# Sportmonks Football MCP Server

> ** BETA** — This server is currently in beta. Functionality may change and edge cases may be unhandled. It is a **companion tool for AI-assisted exploration of the Sportmonks Football API, not a production API client.** Use it to chat with your data, prototype, and learn the API shape; for production workloads keep using the Sportmonks Football API 3.0 directly.
>
> We actively welcome feedback — see the [Feedback](#feedback) section below.

Model Context Protocol (MCP) server for the official Sportmonks Football API 3.0.

This server exposes focused Sportmonks Football API tools for search, player/team/league lookup, squads, fixtures, standings, seasons, and topscorers.

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
  -- npx -y sportmonks-football-mcp-server
```

### Claude Desktop

```json
{
  "mcpServers": {
    "sportmonks-football": {
      "command": "npx",
      "args": ["-y", "sportmonks-football-mcp-server"],
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
      "args": ["-y", "sportmonks-football-mcp-server"],
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
      "args": ["-y", "sportmonks-football-mcp-server"],
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

List-style tools (`search`, `get_matches`, `get_squad`, `get_standings`, `get_topscorers`) return a `{ data, meta }` envelope where `meta` contains `returned`, `cap`, and `possibly_more`. Use `meta.possibly_more` to detect upstream or local truncation. `get_matches` also exposes `meta.date_window` for non-live timeframes.

Single-entity tools (`get_player`, `get_team`, `get_league`, `get_match_preview`, `get_fixture_details`) and `get_historic_seasons` return a JSON object or array directly without an envelope.

### `search`

Search for entities in the Sportmonks database.

Inputs:
- `query` (required)
- `type` (optional): `player`, `team`, `league`, `all` (default)

Output:
- `{ data, meta }` envelope; `data` contains up to 25 items sorted alphabetically by name
- Each item contains `id`, `entity_type`, `name`, and `country` (`country` may be `null` when Sportmonks doesn't provide one; useful for disambiguating generic names like the dozen leagues called "Super League")

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
- JSON object with `id`, `name`, `country`, and `venue`

### `get_league`

Get league details by id.

Inputs:
- `id` (required)

Output:
- JSON object with `id`, `name`, `country`, `current_season_id`, and `current_season_name`

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
- `includes` (optional): subset of `lineups`, `events`, `statistics`

Output:
- Base fixture object always includes `id`, `home_team`, `away_team`, `starting_at`, `state`, `league`, and `scores`
- `lineups` (when requested): each row contains `player_id`, `player_name`, `team_id`, `jersey_number`, `position`, `detailed_position`, and `type` (`lineup` or `bench`). `team_id` lets you split home vs away without inferring from order
- `events` (when requested): each event contains `minute`, `type`, `player_name`, `related_player_name`, `result`, and `info`
- `statistics` (when requested): grouped per team with `team_id`, `team_name`, and a `stats` object keyed by stat name

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

**Fixtures**
- *Show me Real Madrid's upcoming fixtures for the next two weeks*
- *What were Chelsea's results over the last 30 days?*
- *Are there any live matches right now?*
- *Get the full details for fixture 123456 including lineups and events*

**Standings & seasons**
- *Show me the current Premier League standings*
- *What seasons has the Champions League had? Give me the most recent ones first*
- *Who are the top 10 goal scorers in Serie A this season?*
- *Show me the top 5 assist providers and top 5 yellow card recipients in the Bundesliga*

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
