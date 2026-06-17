# Sportmonks Football MCP Server

> ** BETA** — This server is currently in beta. Functionality may change and edge cases may be unhandled. It is a **companion tool for AI-assisted exploration of the Sportmonks Football API, not a production API client.** Use it to chat with your data, prototype, and learn the API shape; for production workloads keep using the Sportmonks Football API 3.0 directly.
>
> We actively welcome feedback — see the [Feedback](#feedback) section below.

Model Context Protocol (MCP) server for the official Sportmonks Football API 3.0.

This server exposes focused Sportmonks Football API tools for search, player/team/league/coach lookup, squads, fixtures, standings, seasons, topscorers, odds, season statistics, per-fixture player statistics, match pressure index, and transfers.

## Features

- Focused MCP tools instead of a broad raw API surface
- Typed input schemas plus runtime validation on every tool
- JSON output for every tool response, including error responses
- Descriptive errors with a `how_to_fix` field for the LLM
- Pagination metadata (`returned`, `cap`, `possibly_more`, `date_window`) on every list-style tool so the LLM knows when results were truncated
- Built on official Sportmonks Football API 3.0 endpoints
- Player current-team resolution iterates candidate clubs and rejects national-team relations, so `current_team` returns the player's club rather than their country
- Invalid league/team ids surface as typed `not_found` errors instead of empty rows
- Types and states are loaded on startup and reused for shared mappings (broad and detailed positions are resolved to readable names via this cache)

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SPORTMONKS_API_TOKEN` | Yes | — | Your Sportmonks API token from MySportmonks |
| `SPORTMONKS_LOG_FILE` | No | `<os.tmpdir()>/sportmonks-football-mcp.log` | Absolute path for the local tool-call log. Set to `off`, `none`, or empty to disable file logging |
| `SPORTMONKS_DEBUG_URLS` | No | `off` | Set to `1`, `true`, `yes`, or `on` to log each outbound Sportmonks URL to stderr (with `api_token` redacted). Off by default |

Sportmonks authentication follows the official `api_token` query parameter approach documented at https://docs.sportmonks.com/v3/welcome/authentication.

## Installation

The published npm binary works with any MCP client. Each example below fetches the package on first run (via `npx -y`) and starts the server; no manual install required.

### Claude Code CLI

```bash
claude mcp add sportmonks-football \
  --env SPORTMONKS_API_TOKEN="your-token" \
  -- npx -y @sportmonks/football-mcp-server
```

### Claude Desktop

```json
{
  "mcpServers": {
    "sportmonks-football": {
      "command": "npx",
      "args": ["-y", "@sportmonks/football-mcp-server"],
      "env": {
        "SPORTMONKS_API_TOKEN": "your-token"
      }
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "sportmonks-football": {
      "command": "npx",
      "args": ["-y", "@sportmonks/football-mcp-server"],
      "env": {
        "SPORTMONKS_API_TOKEN": "your-token"
      }
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "sportmonks-football": {
      "command": "npx",
      "args": ["-y", "@sportmonks/football-mcp-server"],
      "env": {
        "SPORTMONKS_API_TOKEN": "your-token"
      }
    }
  }
}
```

### Install from source

For contributing or running against unreleased changes:

```bash
npm install
npm run build
SPORTMONKS_API_TOKEN="your-token" node dist/index.js
```

Point your MCP client at the compiled entrypoint (`node /absolute/path/to/dist/index.js`) instead of the `npx` command.

## Available Tools

### Response shapes

List-style tools (`search`, `get_matches`, `get_squad`, `get_standings`, `get_topscorers`, `get_odds`, `get_season_stats`, `get_fixture_lineup_stats`, `get_transfers`) return a `{ data, meta }` envelope where `meta` contains `returned`, `cap`, and `possibly_more`. Use `meta.possibly_more` to detect upstream or local truncation. `get_matches` also exposes `meta.date_window` for non-live timeframes, and the two stats tools (`get_season_stats`, `get_fixture_lineup_stats`) expose `meta.stat_types` with the applied stat filter.

`get_pressure_index` also returns a `{ data, meta }` envelope, but `meta` carries `returned`, `cap`, `possibly_more`, and the applied `mode`; its `data` is mode-dependent (summary aggregates or a per-minute timeline) rather than a flat list.

Single-entity tools (`get_player`, `get_team`, `get_league`, `get_coach`, `get_match_preview`, `get_fixture_details`) and `get_historic_seasons` return a JSON object or array directly without an envelope.

### `search`

Search for entities in the Sportmonks database.

Inputs:
- `query` (required)
- `type` (optional): `player`, `team`, `league`, `coach`, `all` (default)

Output:
- `{ data, meta }` envelope; `data` contains up to 25 items sorted alphabetically by name
- Each item contains `id`, `entity_type` (`player`, `team`, `league`, or `coach`), `name`, and `country` (`country` may be `null` when Sportmonks doesn't provide one; useful for disambiguating generic names like the dozen leagues called "Super League")

### `get_player`

Get player details by id.

Inputs:
- `id` (required)

Output:
- JSON object with `id`, `name`, `position`, `nationality`, `date_of_birth`, and `current_team`

### `get_team`

Get team details by id.

Inputs:
- `id` (required)

Output:
- JSON object with `id`, `name`, `country`, `venue`, and `coach` (`{ id, name }` for the current manager; `null` when no active coach is recorded)

### `get_league`

Get league details by id.

Inputs:
- `id` (required)

Output:
- JSON object with `id`, `name`, `country`, `current_season_id`, and `current_season_name`

### `get_coach`

Get coach details by id.

Inputs:
- `id` (required)

Output:
- JSON object with `id`, `name`, `nationality`, `date_of_birth`, and `current_team` (`{ id, name }` for the coach's active appointment; `null` when none is recorded). Mirrors `get_player`'s shape

### `get_squad`

Get the current or historic squad for a team.

Inputs:
- `team_id` (required)
- `season_id` (optional)

Output:
- `{ data, meta }` envelope; each row contains `player_id`, `name`, `position`, `position_id`, `detailed_position`, `detailed_position_id`, and `jersey_number`

### `get_matches`

Get matches for a team or league.

Inputs:
- `id` (required)
- `type` (required): `team`, `league`
- `timeframe` (optional): `live`, `historic`, `upcoming` (default)

Output:
- `{ data, meta }` envelope; each match contains `id`, `home_team`, `away_team`, `starting_at`, `state`, and `league`
- For `upcoming` and `historic` timeframes, `meta.date_window` reports the `{ start, end }` range queried

Built-in limits:
- `upcoming`: next 14 days, max 20 fixtures
- `historic`: last 30 days, max 20 fixtures
- `live`: max 20 fixtures

### `get_match_preview`

Get a compact match preview for a fixture id.

Inputs:
- `id` (required): fixture id

Output:
- JSON object with `id`, `home_team`, `away_team`, `starting_at`, and `last_5_h2h_matches`
- `last_5_h2h_matches` contains up to 5 previous H2H fixtures with `date`, `home_team`, `away_team`, `home_score`, `away_score`, and `result_info`

Constraint:
- only works for fixtures that have not started yet

### `get_fixture_details`

Get detailed fixture data with optional expansions.

Inputs:
- `fixture_id` (required)
- `includes` (optional): subset of `lineups`, `events`, `statistics`, `predictions`, `xg`

Output:
- Base fixture object always includes `id`, `home_team`, `away_team`, `starting_at`, `state`, `league`, and `scores`
- `lineups` (when requested): each row contains `player_id`, `player_name`, `team_id`, `jersey_number`, `position`, `detailed_position`, and `type` (`lineup` or `bench`). `team_id` lets you split home vs away without inferring from order
- `events` (when requested): each event contains `minute`, `type`, `player_name`, `related_player_name`, `result`, and `info`
- `statistics` (when requested): grouped per team with `team_id`, `team_name`, and a `stats` object keyed by stat name
- `predictions` (when requested): a curated object with `home_win`, `draw`, `away_win`, `btts`, `over_2_5`, and `value_bets`. Probabilities are percentages on a 0–100 scale as Sportmonks returns them; `btts` and `over_2_5` carry only the positive direction (the inverse is derivable). Each value bet contains `bet` (1X2 notation: `"1"` home, `"X"` draw, `"2"` away), `bookmaker`, `fair_odd`, `odd`, `stake`, and `is_value`. Sportmonks exposes ~35 prediction types; this include curates the four most useful (fulltime result, BTTS, over/under 2.5, value bets) — fields are `null` (or `[]`) when a type is missing
- `xg` (when requested): a list of one object per team with `team_id`, `team_name`, `xg` (Expected Goals), and `xg_on_target` (Expected Goals on Target / xGoT). Populated for finished and live fixtures with coverage; an empty array for upcoming fixtures or fixtures without xG data. Sportmonks exposes 10+ xG-family metrics; this include curates only xG and xGoT

Constraint:
- `predictions` requires a Sportmonks subscription with the predictions add-on; without it the whole call returns an `authentication_error` explaining how to retry without predictions

### `get_standings`

Get the standings table for a league. Tries the live endpoint first; if no live standings are returned (including 404 responses for competitions between phases), falls back to season-based standings using the league's current season.

Inputs:
- `id` (required)

Output:
- `{ data, meta }` envelope; each standing row contains `position`, `team`, `played`, `won`, `drawn`, `lost`, `gd`, and `points`

### `get_historic_seasons`

Get all seasons for a league, sorted from most recent to oldest.

Inputs:
- `league_id` (required)

Output:
- JSON array with `id`, `name`, `is_current`, `finished`, `starting_at`, and `ending_at`

### `get_topscorers`

Get season topscorers, assisters, or card leaders.

Inputs:
- `season_id` (required)
- `type` (required): `goals`, `assists`, `cards`
- `limit` (optional): default `10`, max `25`

Output:
- `{ data, meta }` envelope; each row contains `position`, `player`, `team`, and `total`

### `get_odds`

Get pre-match or premium betting odds for a fixture. Inplay odds are not supported.

Inputs:
- `fixture_id` (required)
- `type` (optional): `prematch` (default), `premium`
- `market_id` (optional): filter to a single market (e.g. `1` for Fulltime Result)
- `bookmaker_id` (optional): filter to a single bookmaker
- `limit` (optional): default `50`, max `200`

Output:
- `{ data, meta }` envelope; each entry contains `bookmaker_id`, `bookmaker_name`, `market_id`, `market_name`, `label`, `value`, `total`, `handicap`, `stopped`, and `last_updated`
- `value`, `total`, and `handicap` are decimal strings as Sportmonks sends them; `total`/`handicap` carry the line for markets like Goal Line or Asian Handicap
- An empty `data` array means the fixture exists but has no odds for the requested feed type and filters

Built-in limits:
- at most `limit` entries (default 50, max 200), sorted by market then bookmaker; an unfiltered fixture can carry thousands of odds upstream, so narrow with `market_id` and/or `bookmaker_id` — or raise `limit` — when `meta.possibly_more` is `true`

Constraint:
- `type='premium'` requires a Sportmonks subscription that includes the premium odds feed; without it the tool returns an `authentication_error` explaining the tier requirement

### `get_season_stats`

Get seasonal statistics for a player or team.

Inputs:
- `entity_id` (required): player id or team id
- `entity_type` (required): `player`, `team`
- `season_id` (required): use `get_historic_seasons` to find one
- `stat_types` (optional): stat names to return instead of the per-entity-type defaults, e.g. `["goals", "big_chances_created"]`

Output:
- `{ data, meta }` envelope; each row contains `entity_id`, `entity_name`, `entity_type`, `season_id`, `season_name`, and a `stats` object keyed by snake_case stat name
- Player rows also contain `team` (`{ id, name }`) — a player's season stats are per club, so a mid-season transfer yields one row per club
- Stat values mirror the upstream data: simple counters are unwrapped to plain numbers; richer stats (e.g. `goals` with penalty split, team stats with home/away splits, `rating` with average/highest/lowest) stay objects — so the same stat key can be a number for one entity and an object for another, depending on what Sportmonks tracks
- `meta.stat_types` always reports the applied stat filter, whether default or user-supplied
- An empty `data` array means the entity exists but has no statistics for that season

Default stat filters:
- player: `goals`, `assists`, `minutes_played`, `appearances`, `shots_on_target`, `passes`, `key_passes`, `tackles`, `rating`
- team: `goals`, `goals_conceded`, `team_wins`, `team_draws`, `team_lost`, `cleansheets`, `shots`, `pass_stats`, `ball_possession`

Notes:
- stat names are the snake_case of the Sportmonks type name (`"Shots On Target"` → `shots_on_target`); spellings like `"Shots On Target"` or `"shots-on-target"` are normalized automatically
- stat availability varies by league, entity type, and data tier — and Sportmonks omits zero-value stats entirely — so a stat missing from `stats` means "not tracked or zero"; the two cases cannot be distinguished upstream. A player with no minutes in the season yields a row with an empty `stats` object
- teams have no `shots_on_target` or `passes` stat types upstream; shots-on-target lives inside `shots` and pass numbers inside `pass_stats`

### `get_fixture_lineup_stats`

Get player-level statistics for a fixture — both squads, including bench.

Inputs:
- `fixture_id` (required)
- `player_ids` (optional): filter to specific players
- `stat_types` (optional): stat names to return instead of the defaults, e.g. `["rating", "passes", "shots_total"]`

Output:
- `{ data, meta }` envelope; each row contains `player_id`, `player_name`, `team_id`, `team_name`, `type` (`lineup` or `bench`), and a `stats` object keyed by snake_case stat name
- `meta.stat_types` always reports the applied stat filter, whether default or user-supplied
- An empty `data` array means the fixture exists but has no lineup data (not announced yet, or not covered for the league) — or, when `player_ids` is set, that none of the requested players are in the lineups

Default stat filter:
- `goals`, `assists`, `minutes_played`

Built-in limits:
- max 60 player rows (an international friendly with extended benches produced 49, so real fixtures are never truncated)

Notes:
- the stat filter is pushed upstream (an unfiltered fixture carries ~900 stat entries across ~60 types), so narrow `stat_types` rather than post-filtering large responses
- stat names are the snake_case of the Sportmonks type name, normalized like `get_season_stats`
- Sportmonks omits zero-value stats, so a missing stat means "not tracked or zero"; under the default filter (which includes `minutes_played`) a `bench` player with an empty `stats` object did not come on — with a narrower override, empty may just mean none of the requested stats were recorded

### `get_pressure_index`

Get the Sportmonks Pressure Index for a fixture — a proprietary real-time metric scoring which team is dominating, minute by minute. Use it to describe momentum swings and periods of dominance.

Inputs:
- `fixture_id` (required)
- `mode` (optional): `summary` (default) or `timeline`

Output (both modes return a `{ data, meta }` envelope; `meta` is `{ returned, cap, possibly_more, mode }`):
- `summary`: `data` is `{ teams, swings }`. `teams` is `[home, away]`, each with `team_id`, `team_name`, `peak_pressure`, `average_pressure`, and `dominance_share` (% of recorded minutes that team led). `swings` is the top momentum-swing minutes (lead changes, most decisive first by pressure, then chronological), each with `minute`, `team_id`, `team_name`, and `pressure`
- `timeline`: `data` is `{ teams, timeline }`. `teams` is `[home, away]` (`team_id`, `team_name`); `teams[0]` is the `home` key and `teams[1]` the `away` key. `timeline` is the cleaned per-minute series sorted by minute, each entry `{ minute, home, away }` with the redundant `id`/`fixture_id` stripped

Built-in limits:
- timeline capped at 150 minute-entries (a full 90' match is ~94; covers extra time), with `meta.possibly_more` flagging truncation. Summary aggregates the whole recorded series

Notes:
- works for live (partial series) and finished (full series) fixtures; returns an empty series for upcoming fixtures or fixtures without pressure data
- pressure is a relativity metric — only one team has positive pressure at a time, so `dominance_share` values reflect who led each minute and a tied (both-zero) minute counts toward neither
- team names are resolved from the fixture participants returned by the same call (no extra lookup)

### `get_transfers`

Get football transfers: latest market activity, transfers for a team or player, or transfers within a date range. Confirmed transfers and rumours share one shape, selected via `type`.

Inputs:
- `id` (optional): team or player id to scope to
- `entity_type` (`team` | `player`): required when `id` is provided
- `type` (`confirmed` | `rumour`): default `confirmed`; rumours require a subscription add-on
- `timeframe` (`latest` | `date_range`): defaults to `latest` when an `id` is provided; for an unscoped query (no `id`) it must be set explicitly
- `start_date` / `end_date` (YYYY-MM-DD): required when `timeframe=date_range`; the window must not exceed 31 days (the Sportmonks API limit for transfer date ranges)

Output:
- `{ data, meta }` envelope, max 25 results; each entry contains `id`, `player` (`{ id, name }`), `from_team` (`{ id, name }`), `to_team` (`{ id, name }`), `type` (`confirmed`/`rumour`), `transfer_kind` (resolved transfer type, e.g. `Transfer`, `Loan`, `End of loan`), `fee`, and `date`
- `fee` is `null` for undisclosed deals (never `0`)

Constraints / validation:
- requires either an `id` (with `entity_type`) or an explicit `timeframe` — a bare call with neither is rejected
- `id` without `entity_type` is rejected
- a `date_range` window longer than 31 days is rejected (Sportmonks caps transfer date ranges at 31 days)
- `date_range` cannot be combined with an `id` — there is no date-scoped team/player endpoint, so the combination is rejected rather than silently ignoring the window
- `type='rumour'` without the rumours add-on returns a clear `authentication_error` telling you to retry with `type='confirmed'` or upgrade

Notes:
- rumours have no dedicated "latest" feed, so an unscoped `timeframe=latest` rumour query reads the full rumour feed (still capped at 25)
- rumour-only fields (probability, source, currency) are dropped to keep one uniform shape across both types

## Resources

The server exposes two MCP Resources. Fetch them via `resources/read` (or `@`-mention in clients that support it, e.g. Claude Desktop, Cursor).

| URI | MIME type | Content |
| --- | --- | --- |
| `sportmonks://documentation` | `text/plain` | Server overview: tool list, behavior notes, links to official Sportmonks docs |
| `sportmonks://openapi` | `application/json` | Official Sportmonks Football OpenAPI spec (fetched fresh on every read) |

Claude Code does not auto-load resources — users attach them explicitly via `@`-mention when needed.

## Observability

The server writes one JSON line per tool call to stderr and to a local log file, including tool name, arguments, duration, and outcome. See [OBSERVABILITY.md](OBSERVABILITY.md) for the log format, default paths per OS, and debugging flows.

## Error Format

All tool errors are returned as JSON with this shape:

```json
{
  "ok": false,
  "error": {
    "type": "validation_error",
    "message": "The 'id' field must be a positive integer.",
    "how_to_fix": "Call the tool again with 'id' set to a positive integer such as 501 or 19735.",
    "details": null
  }
}
```

## Example Prompts

You don't need to know any Sportmonks ids — the server will look them up. Try any of these:

**Finding things**
- *Search for "Barcelona" — is it a team, a league, or both?*
- *Find the player ID for Erling Haaland*
- *Search for leagues named "Premier League"*

**Teams & players**
- *Get the profile for Manchester City*
- *Show me the current squad for Liverpool*
- *Who was in Arsenal's squad during the 2021/22 season?*
- *Get the profile for Vinicius Jr — which team is he at?*
- *Who is the current coach of Manchester City?*
- *Find the coach Pep Guardiola and tell me which club he manages*

**Fixtures**
- *Show me Real Madrid's upcoming fixtures for the next two weeks*
- *What were Chelsea's results over the last 30 days?*
- *Are there any live matches right now?*
- *Get the full details for fixture 123456 including lineups and events*
- *What were the xG and xGoT for both teams in fixture 123456?*
- *Who controlled fixture 123456 and when did the momentum swing? Use the pressure index*

**Standings & seasons**
- *Show me the current Premier League standings*
- *What seasons has the Champions League had? Give me the most recent ones first*
- *Who are the top 10 goal scorers in Serie A this season?*
- *Show me the top 5 assist providers and top 5 yellow card recipients in the Bundesliga*

**Odds**
- *What are the match-winner odds for England's next fixture?*
- *Which bookmaker offers the best odds on a home win in tomorrow's Madrid derby?*

**Season statistics**
- *How many goals and assists did Haaland record in the 2025/26 Premier League season?*
- *Compare Manchester City's goals scored and conceded at home vs away last season*

**Player match stats**
- *How many minutes did each Iceland player get in the Argentina friendly?*
- *Get the player ratings and passes for both teams in yesterday's final*

**Transfers**
- *Show me the latest confirmed transfers*
- *What transfer rumours are linked to Real Madrid right now?*
- *List all transfers in January 2026*

**Briefings (using prompts)**
- *Give me a pre-match briefing for the upcoming El Clásico — use the `match_preview` prompt*
- *Run the `team_overview` prompt for Manchester United*
- *Generate a `league_overview` for the Premier League*

**Building with the API**
- *Fetch a sample fixture with lineups and events using `get_fixture_details`, then write me a TypeScript interface for the response shape*
- *Use `get_standings` to get the current La Liga table and render it as a formatted markdown table*
- *Build a function that takes a team name, searches for it, then fetches its next 5 fixtures*

## Feedback

This server is in beta and the team actively welcomes feedback. If you encounter issues, unexpected behavior, or have ideas for improvements, please email **support@sportmonks.com** and include:

- The specific tool that was called and its arguments
- What you expected versus what actually happened
- Your AI client (Claude Desktop, Claude Code, Cursor, etc.) and the version of this package

That detail helps us reproduce and fix issues quickly.

## Development

```bash
npm install
npm run build
npm test
```
