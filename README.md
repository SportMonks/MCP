# Sportmonks Football MCP Server

Model Context Protocol (MCP) server for the official Sportmonks Football API 3.0.

This server exposes focused Sportmonks Football API tools for search, player/team/league lookup, squads, fixtures, standings, seasons, and topscorers.

## Features

- Focused MCP tools instead of a broad raw API surface
- Typed input schemas plus runtime validation on every tool
- JSON output for every tool response, including error responses
- Descriptive errors with a `how_to_fix` field for the LLM
- Built on official Sportmonks Football API 3.0 endpoints
- Exact two-step player lookup for current team resolution: player by id, then team by id
- Types and states are loaded on startup and reused for shared mappings

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `SPORTMONKS_API_TOKEN` | Yes | Your Sportmonks API token from MySportmonks |

Sportmonks authentication follows the official `api_token` query parameter approach documented at https://docs.sportmonks.com/v3/welcome/authentication.

## Local Setup

```bash
npm install
npm run build
```

Run locally:

```bash
SPORTMONKS_API_TOKEN="your-token" node dist/index.js
```

Development mode:

```bash
SPORTMONKS_API_TOKEN="your-token" npm run dev
```

## MCP Client Examples

Build the project first, then point your MCP client at the compiled entrypoint.

### Claude Code CLI

```bash
claude mcp add sportmonks-football \
  --env SPORTMONKS_API_TOKEN="your-token" \
  -- node /absolute/path/to/dist/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "sportmonks-football": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "SPORTMONKS_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Available Tools

### `search`

Search for entities in the Sportmonks database.

Inputs:
- `query` (required)
- `type` (optional): `player`, `team`, `league`, `all` (default)

Output:
- JSON array with up to 10 items
- Each item contains `id`, `entity_type`, and `name`

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
- JSON object with `id`, `name`, and `country`

### `get_squad`

Get the current or historic squad for a team.

Inputs:
- `team_id` (required)
- `season_id` (optional)

Output:
- JSON array with `player_id`, `name`, `position`, `detailed_position`, and `jersey_number`

### `get_matches`

Get matches for a team or league.

Inputs:
- `id` (required)
- `type` (required): `team`, `league`
- `timeframe` (optional): `live`, `historic`, `upcoming` (default)

Output:
- JSON array
- Each match contains `id`, `home_team`, `away_team`, `starting_at`, `state`, and `league`

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
- Optional sections include `lineups`, `events`, and `statistics`

### `get_standings`

Get live standings for a league.

Inputs:
- `id` (required)

Output:
- JSON array
- Each standing row contains `position`, `team`, `played`, `won`, `drawn`, `lost`, `gd`, and `points`

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
- JSON array with `position`, `player`, `team`, and `total`

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

- "Search for Arsenal across all entity types."
- "Get the team entity for id 14."
- "Get upcoming matches for league 8."
- "Get live matches for team 53."
- "Get a match preview for fixture 18535517."
- "Get detailed fixture data for fixture 2001 with lineups and events."
- "Get standings for league 501."
- "Get the current squad for team 14."
- "Get historic seasons for league 501."
- "Get the top goalscorers for season 2024."

## Development

```bash
npm install
npm run build
npm test
```
