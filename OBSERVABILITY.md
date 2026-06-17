# Observability and Debugging

This server writes one structured line to stderr and to a local log file for every tool call. Use it to find slow calls, failed calls, and the upstream error type behind a failure.

## Log Locations

| Target | Default path | Override |
| --- | --- | --- |
| Local log file | `<os.tmpdir()>/sportmonks-football-mcp.log` | `SPORTMONKS_LOG_FILE=/absolute/path/to/file.log` |
| stderr | Captured by the MCP client (e.g. Claude Desktop, Claude Code) | — |

Resolved default paths:
- Windows: `%TEMP%\sportmonks-football-mcp.log` (typically `C:\Users\<you>\AppData\Local\Temp\sportmonks-football-mcp.log`)
- macOS: `/var/folders/.../T/sportmonks-football-mcp.log`
- Linux: `/tmp/sportmonks-football-mcp.log`

To disable file logging, set `SPORTMONKS_LOG_FILE=off` (or `none`, or an empty string). stderr logging stays on.

## Log Format

One JSON object per line (JSONL). Each entry records a single `tools/call` request.

```json
{"ts":"2026-04-19T13:42:11.204Z","tool":"get_team","args":{"id":14},"duration_ms":187,"outcome":"ok"}
{"ts":"2026-04-19T13:42:15.911Z","tool":"get_standings","args":{"id":501},"duration_ms":612,"outcome":"ok"}
{"ts":"2026-04-19T13:42:20.003Z","tool":"get_match_preview","args":{"id":99999999},"duration_ms":298,"outcome":"error","error_kind":"not_found"}
```

| Field | Meaning |
| --- | --- |
| `ts` | ISO 8601 timestamp when the call completed |
| `tool` | Tool name (e.g. `get_player`, `get_matches`) |
| `args` | Arguments passed to the tool |
| `duration_ms` | End-to-end duration in milliseconds, including validation, upstream HTTP, and response formatting |
| `outcome` | `ok` or `error` |
| `error_kind` | Only present when `outcome` is `error`; one of the error types below |

## Error Types

| `error_kind` | Cause | First thing to check |
| --- | --- | --- |
| `validation_error` | Tool was called with invalid inputs (bad id, bad enum, etc.) | The `args` field in the log line shows what was sent |
| `authentication_error` | Missing token, invalid token, or the token does not cover the requested endpoint/subscription tier | Verify `SPORTMONKS_API_TOKEN` and check the subscription in MySportmonks |
| `not_found` | Sportmonks does not have the requested id | Confirm the id with the `search` tool; check subscription access |
| `rate_limit_error` | Sportmonks rate limit hit | Wait and retry; avoid rapid bursts |
| `upstream_error` | Sportmonks returned a non-2xx outside the handled statuses, or a request timed out (`>20s`) | Check Sportmonks status; inspect `details` in the error response |
| `tool_error` | Unknown tool name, or an unexpected exception not classified above | Call `tools/list` to confirm the tool name |

The full `how_to_fix` guidance is included in the JSON error response returned to the MCP client, not in the log line.

## Common Debugging Flows

### "A tool is slow"

```bash
# macOS / Linux
tail -f /tmp/sportmonks-football-mcp.log | jq 'select(.duration_ms > 1000)'

# Windows PowerShell
Get-Content -Wait $env:TEMP\sportmonks-football-mcp.log | Where-Object { $_ -match '"duration_ms":[0-9]{4,}' }
```

Typical durations on a healthy connection:
- Simple entity lookups (`get_team`, `get_league`): 100-400 ms
- List endpoints (`get_matches`, `get_standings`): 300-900 ms
- `get_match_preview`: 500-1500 ms (two upstream calls)
- `get_fixture_details` with all includes: 400-1200 ms

Calls above ~2 s usually mean Sportmonks is slow or the payload is large. Calls above 20 s time out with `upstream_error`.

### "A tool keeps failing"

1. Find the most recent error entries in the log and note `error_kind`.
2. Match `error_kind` against the table above.
3. If it is `authentication_error` on an endpoint you expect to access, check the subscription page in MySportmonks for that data surface.
4. If it is `upstream_error`, look at the tool response `details` field — it contains the raw Sportmonks response body.

### "Nothing is being logged"

1. Confirm `SPORTMONKS_LOG_FILE` is not set to `off`, `none`, or empty.
2. Confirm the process has write access to the log path (tmpdir always does; custom paths may not).
3. Startup messages (`Sportmonks Football MCP Server running on stdio`) go only to stderr. Tool call lines go to both stderr and the file. If you see startup in Claude's logs but no tool call lines, the server is running but no tool has been invoked yet.

## Tool → Upstream Endpoint Map

When `error_kind` is `upstream_error` or `not_found`, use this to know which Sportmonks endpoint to cross-check.

| Tool | Endpoint(s) |
| --- | --- |
| `search` | `/football/players/search/{q}`, `/football/teams/search/{q}`, `/football/leagues/search/{q}`, `/football/coaches/search/{q}` (whichever the `type` selects; all four for `type=all`) |
| `get_player` | `/football/players/{id}?include=position;nationality;teams.team` + `/football/teams/{team_id}` |
| `get_team` | `/football/teams/{id}?include=venue;country;coaches.coach` (the active coach relation supplies the `coach` field) |
| `get_league` | `/football/leagues/{id}?include=country;currentseason` |
| `get_coach` | `/football/coaches/{id}?include=nationality;teams.team` (the active team relation supplies `current_team`) |
| `get_squad` | `/football/squads/teams/{team_id}` or `/football/squads/seasons/{season_id}/teams/{team_id}` |
| `get_matches` (upcoming/historic, team) | `/football/fixtures/between/{start}/{end}/{team_id}` |
| `get_matches` (upcoming/historic, league) | `/football/fixtures/between/{start}/{end}` + `fixtureLeagues:{id}` filter |
| `get_matches` (live) | `/football/livescores/inplay` |
| `get_match_preview` | `/football/fixtures/{id}` + `/football/fixtures/head-to-head/{a}/{b}` |
| `get_fixture_details` | `/football/fixtures/{id}` (with `include=predictions`, the whole request requires the predictions add-on; a missing add-on surfaces as `authentication_error`. The `xg` include maps to the `xGFixture` relation) |
| `get_standings` | `/football/standings/live/leagues/{id}` first; on empty/404, falls back to `/football/leagues/{id}?include=currentseason` then `/football/standings/seasons/{current_season_id}` |
| `get_historic_seasons` | `/football/leagues/{id}?include=seasons` |
| `get_topscorers` | `/football/topscorers/seasons/{id}` |
| `get_odds` (prematch) | `/football/odds/pre-match/fixtures/{fixture_id}` + optional `markets:{id};bookmakers:{id}` filters; on empty data, `/football/fixtures/{fixture_id}` to distinguish "no odds" from "unknown fixture" |
| `get_odds` (premium) | `/football/odds/premium/fixtures/{fixture_id}` (requires the premium odds subscription; 403 surfaces as `authentication_error`) + the same empty-data fixture check |
| `get_season_stats` (player) | `/football/statistics/seasons/players/{entity_id}` + `playerstatisticSeasons:{season_id}` filter; on empty data, `/football/players/{entity_id}` to distinguish "no stats" from "unknown player" |
| `get_season_stats` (team) | `/football/statistics/seasons/teams/{entity_id}` + `teamstatisticSeasons:{season_id}` filter; on empty data, `/football/teams/{entity_id}` |
| `get_fixture_lineup_stats` | `/football/fixtures/{fixture_id}?include=lineups.details;participants` + `lineupdetailTypes:{type_ids}` filter (resolved from the requested stat names; the details include is skipped when no name resolves) |
| `get_pressure_index` | `/football/fixtures/{fixture_id}?include=pressure;participants` (one request; team names resolved from participants. summary/timeline shaping is done in-process, not upstream) |
| `get_transfers` (confirmed) | `/football/transfers/latest`, `/football/transfers/teams/{id}`, `/football/transfers/players/{id}`, or `/football/transfers/between/{start}/{end}` — by timeframe/scope; `include=player;fromteam;toteam` |
| `get_transfers` (rumour) | same shapes under `/football/transfer-rumours/...` (no `/latest` — unscoped uses the base feed); requires the rumours add-on, a missing add-on surfaces as `authentication_error` |

Plus startup-only:
- `/core/types` — paginated, loaded once at startup for the shared type mapping
- `/football/states` — paginated, loaded once at startup for the shared state mapping

## Reproducing a Tool Call Locally

```bash
# Launch the server with a clean log path
SPORTMONKS_API_TOKEN="your-token" \
SPORTMONKS_LOG_FILE="$(pwd)/mcp-debug.log" \
node dist/index.js
```

Then send a `tools/call` from your MCP client and inspect `mcp-debug.log`.

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SPORTMONKS_API_TOKEN` | Yes | — | Sportmonks API token |
| `SPORTMONKS_LOG_FILE` | No | `<os.tmpdir()>/sportmonks-football-mcp.log` | Absolute path for the local log file. Set to `off`, `none`, or empty to disable file logging |
| `SPORTMONKS_DEBUG_URLS` | No | `off` | Set to `1`, `true`, `yes`, or `on` to log every outbound Sportmonks URL to stderr (with `api_token` redacted). Useful for confirming which endpoint actually served a response (e.g. live vs. season fallback in `get_standings`) |
