# Sportmonks Football MCP Server

Model Context Protocol (MCP) server for the official Sportmonks Football API 3.0.

This version is intentionally narrow: it exposes only five high-signal tools for search, entity lookup, matches, match previews, and live league standings.

## Features

- 5 focused MCP tools instead of a broad raw API surface
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

### `get_entity`

Get a player, team, or league by id.

Inputs:
- `id` (required)
- `type` (required): `player`, `team`, `league`

Output:
- `player`: `id`, `name`, `position`, `nationality`, `date_of_birth`, `current_team`
- `team`: `id`, `name`, `country`, `venue`
- `league`: `id`, `name`, `country`

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

### `get_standings`

Get live standings for a league.

Inputs:
- `id` (required)

Output:
- JSON array
- Each standing row contains `position`, `team`, `played`, `won`, `drawn`, `lost`, `gd`, and `points`

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
- "Get standings for league 501."

## Development

```bash
npm install
npm run build
npm test
```
