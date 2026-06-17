#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ── Constants ────────────────────────────────────────────────────────────────

const FOOTBALL_API_BASE_URL = "https://api.sportmonks.com/v3/football";
const CORE_API_BASE_URL = "https://api.sportmonks.com/v3/core";
const OPENAPI_SPEC_URL = "https://vercel-eight-cyan-93.vercel.app/openapi_spec.json";
const DOCUMENTATION_RESOURCE_TEXT = `
Sportmonks Football MCP Server

This server exposes focused Sportmonks football tools, including:
- search(query, type?)
- get_player(id)
- get_team(id)
- get_league(id)
- get_coach(id)
- get_squad(team_id, season_id?)
- get_matches(id, type, timeframe?)
- get_match_preview(id)
- get_fixture_details(fixture_id, includes?)
- get_standings(id)
- get_historic_seasons(league_id)
- get_topscorers(season_id, type, limit?)
- get_odds(fixture_id, type?, market_id?, bookmaker_id?, limit?)
- get_season_stats(entity_id, entity_type, season_id, stat_types?)
- get_fixture_lineup_stats(fixture_id, player_ids?, stat_types?)
- get_pressure_index(fixture_id, mode?)
- get_transfers(id?, entity_type?, type?, timeframe?, start_date?, end_date?)

Authentication
- Set SPORTMONKS_API_TOKEN before starting the server.
- Requests use the official api_token query parameter.

Behavior Notes
- All tool outputs are valid JSON.
- List-style tools (search, get_matches, get_topscorers, get_standings, get_squad, get_odds,
  get_season_stats, get_fixture_lineup_stats, get_transfers) return an envelope
  '{ "data": [...], "meta": { "returned", "cap", "possibly_more", "date_window?", "stat_types?" } }'.
  Use 'meta.possibly_more' to detect server-side or local truncation.
- get_pressure_index returns a '{ "data", "meta" }' envelope where meta is
  '{ "returned", "cap", "possibly_more", "mode" }'; data is mode-dependent (summary aggregates or a
  per-minute timeline), not a flat list.
- Single-entity tools (get_player, get_team, get_league, get_coach, get_match_preview,
  get_fixture_details, get_historic_seasons) return a JSON object or array directly, without an envelope.
- Validation errors explain what is wrong and how to fix the request.
- Search returns at most 25 results; meta.possibly_more flags when more matched upstream.
- All types and states are fetched on startup and used to build shared mappings.
- get_player uses the exact two-step player/team lookup flow to resolve the current team name.
- search supports types player, team, league, coach, and all.
- get_coach mirrors get_player: id, name, nationality, date_of_birth, current_team (the active appointment).
- get_team includes the current coach ({ id, name }); null when no active coach is recorded.
- get_matches limits output to:
  - upcoming: 14 days ahead, max 20 fixtures
  - historic: 30 days back, max 20 fixtures
  - live: max 20 fixtures
- get_match_preview only works for fixtures that have not started yet.
- get_fixture_details supports includes: lineups, events, statistics, predictions, xg. The predictions
  include returns curated probabilities (percentages, 0-100) plus value bets and requires a
  subscription with the predictions add-on. The xg include returns Expected Goals (xG) and Expected
  Goals on Target (xGoT) per team; empty array for upcoming fixtures or fixtures without xG coverage.
- get_odds returns at most 'limit' entries (default 50, max 200) sorted by market then bookmaker.
  An unfiltered fixture can carry thousands of odds upstream, so narrow with market_id and/or
  bookmaker_id. type='premium' requires a subscription that includes the premium odds feed.
- get_season_stats applies a curated default stat filter per entity type; override with
  stat_types (snake_case names). meta.stat_types always reports the applied filter.
- get_fixture_lineup_stats defaults to goals, assists, minutes_played per player; override with
  stat_types. Sportmonks omits zero-value stats, so missing means not-tracked or zero.
- get_pressure_index returns the per-minute Pressure Index for a fixture. mode='summary' (default)
  gives per-team peak/average/dominance share plus swing minutes; mode='timeline' gives the cleaned
  per-minute series. Empty series for upcoming fixtures or fixtures without pressure data.
- get_transfers covers latest market activity, team/player transfers, and date-range queries
  (max 31-day window — the Sportmonks limit), for confirmed transfers or rumours (type='rumour'
  needs an add-on). Capped at 25. An unscoped query (no id) must set timeframe explicitly; a
  scoped query defaults to latest.

Related Resources
- sportmonks://documentation: this overview.
- sportmonks://openapi: OpenAPI spec fetched from the Sportmonks docs host on read.

Official References
- Welcome: https://docs.sportmonks.com/football
- Authentication: https://docs.sportmonks.com/v3/welcome/authentication
- Endpoints: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints
- Filters: https://docs.sportmonks.com/v3/api/request-options/filtering
- Best practices: https://docs.sportmonks.com/v3/welcome/best-practices
`.trim();

const SPORTMONKS_SERVER_VERSION = "1.2.0";
const MAX_SEARCH_RESULTS = 25;
const MAX_MATCH_RESULTS = 20;
const DEFAULT_ODDS_RESULTS = 50;
const MAX_ODDS_RESULTS = 200;

// Sportmonks ships ~35 prediction types; the MCP curates these four. Verified
// against /core/types: the ids are stable and carry these developer names.
const PREDICTION_TYPE_FULLTIME_RESULT = 237; // FULLTIME_RESULT_PROBABILITY
const PREDICTION_TYPE_BTTS = 231; // BTTS_PROBABILITY
const PREDICTION_TYPE_OVER_UNDER_2_5 = 235; // OVER_UNDER_2_5_PROBABILITY
const PREDICTION_TYPE_VALUEBET = 33; // VALUEBET

// The xGFixture include carries all ~52 fixture stat types per team; the MCP
// exposes only these two. Verified unique in /core/types (no name collisions).
const XG_TYPE_ID = 5304; // EXPECTED_GOALS — "Expected Goals (xG)"
const XGOT_TYPE_ID = 5305; // EXPECTED_GOALS_ON_TARGET — "Expected Goals on Target (xGoT)"

// One row per (entity, season, team) — typically a single row, but mid-season
// transfers produce one row per club, so the envelope stays a list.
const MAX_SEASON_STATS_ROWS = 10;
// Default stat filters keyed by the snake_case of the Sportmonks type name
// (the same key format the stats object uses). Player and team season stats
// expose different type sets upstream: teams have no 'shots_on_target' or
// 'passes' types — shots-on-target lives inside 'shots' (type 1677) and pass
// numbers inside 'pass_stats' (type 27253).
const DEFAULT_PLAYER_STAT_TYPES = [
  "goals",
  "assists",
  "minutes_played",
  "appearances",
  "shots_on_target",
  "passes",
  "key_passes",
  "tackles",
  "rating",
];
const DEFAULT_TEAM_STAT_TYPES = [
  "goals",
  "goals_conceded",
  "team_wins",
  "team_draws",
  "team_lost",
  "cleansheets",
  "shots",
  "pass_stats",
  "ball_possession",
];

// A fixture lineup covers both squads incl. unused bench — 49 rows observed on
// an international friendly with extended benches, so 60 never truncates a
// real fixture while still bounding the envelope.
const MAX_LINEUP_STATS_ROWS = 60;
const DEFAULT_LINEUP_STAT_TYPES = ["goals", "assists", "minutes_played"];

// Pressure is one row per team per minute. A full 90' match collapses to ~94
// per-minute entries; 150 covers extra-time + stoppage without truncating real
// matches, while still flagging via possibly_more if ever exceeded.
const MAX_PRESSURE_TIMELINE_ROWS = 150;
// Summary surfaces only the most decisive momentum swings, not every lead change.
const MAX_PRESSURE_SWINGS = 5;

// Transfers can be high-volume (latest/date-range feeds page well past this),
// so cap hard. Sportmonks itself rejects a /between range over 31 days (verified
// live on both /transfers and /transfer-rumours), so we validate to that limit
// up front rather than letting an over-wide range fail upstream with a confusing
// error. (The originating ticket assumed a 6-month window; the real API is 31 days.)
const MAX_TRANSFER_RESULTS = 25;
const MAX_TRANSFER_RANGE_DAYS = 31;
const UPCOMING_WINDOW_DAYS = 14;
const HISTORIC_WINDOW_DAYS = 30;
const API_TIMEOUT_MS = 20_000;

// ── Types ────────────────────────────────────────────────────────────────────

type ParamValue = string | number | boolean | undefined;
type SearchEntityType = "player" | "team" | "league" | "coach" | "all";
type EntityType = "player" | "team" | "league" | "coach";
type MatchEntityType = "team" | "league";
type MatchTimeframe = "live" | "historic" | "upcoming";
type FixtureDetailInclude = "lineups" | "events" | "statistics" | "predictions" | "xg";
type TopscorerType = "goals" | "assists" | "cards";
type OddsFeedType = "prematch" | "premium";
type SeasonStatsEntityType = "player" | "team";
type PressureMode = "summary" | "timeline";
type TransferType = "confirmed" | "rumour";
type TransferTimeframe = "latest" | "date_range";
type TransferEntityType = "team" | "player";
type ToolErrorKind =
  | "authentication_error"
  | "not_found"
  | "rate_limit_error"
  | "tool_error"
  | "upstream_error"
  | "validation_error";

type JsonRecord = Record<string, unknown>;

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler(args: Record<string, unknown>): Promise<ToolResponse>;
}

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface ApiRequestOptions {
  baseUrl?: string;
}

interface TypeLookup {
  id: number;
  code: string | null;
  developerName: string | null;
  modelType: string | null;
  name: string | null;
}

interface StateLookup {
  id: number;
  state: string | null;
  shortName: string | null;
  developerName: string | null;
  name: string | null;
}

class SportmonksToolError extends Error {
  constructor(
    public kind: ToolErrorKind,
    message: string,
    public howToFix: string,
    public details?: string,
  ) {
    super(message);
    this.name = "SportmonksToolError";
  }
}

const typeLookupById = new Map<number, TypeLookup>();
const stateLookupById = new Map<number, StateLookup>();
let lookupInitializationPromise: Promise<void> | null = null;

// ── Validation Helpers ───────────────────────────────────────────────────────

function requireNonEmptyString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field is required and must be a non-empty string.`,
      `Call the tool again with '${fieldName}' set to a non-empty string value.`,
    );
  }

  return value.trim();
}

function requirePositiveInteger(value: unknown, fieldName: string) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be a positive integer.`,
      `Call the tool again with '${fieldName}' set to a positive integer such as 501 or 19735.`,
    );
  }

  return numericValue;
}

function requireEnumValue<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
  defaultValue?: T,
) {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be one of: ${allowedValues.join(", ")}.`,
      `Call the tool again with '${fieldName}' set to one of: ${allowedValues.join(", ")}.`,
    );
  }

  const normalizedValue = value.trim().toLowerCase() as T;
  if (!allowedValues.includes(normalizedValue)) {
    throw new SportmonksToolError(
      "validation_error",
      `Invalid '${fieldName}' value '${value}'. Expected one of: ${allowedValues.join(", ")}.`,
      `Call the tool again with '${fieldName}' set to one of: ${allowedValues.join(", ")}.`,
    );
  }

  return normalizedValue;
}

function requireOptionalPositiveInteger(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return requirePositiveInteger(value, fieldName);
}

function requirePositiveIntegerWithMaximum(
  value: unknown,
  fieldName: string,
  defaultValue: number,
  maximumValue: number,
) {
  const normalizedValue =
    value === undefined || value === null || value === ""
      ? defaultValue
      : requirePositiveInteger(value, fieldName);

  if (normalizedValue > maximumValue) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be less than or equal to ${maximumValue}.`,
      `Call the tool again with '${fieldName}' set to a positive integer between 1 and ${maximumValue}.`,
    );
  }

  return normalizedValue;
}

function requireEnumArray<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
) {
  if (value === undefined) {
    return [] as T[];
  }

  if (!Array.isArray(value)) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be an array containing only: ${allowedValues.join(", ")}.`,
      `Call the tool again with '${fieldName}' as an array, for example ['${allowedValues[0]}'].`,
    );
  }

  const normalizedValues = value.map((entry) =>
    requireEnumValue(entry, fieldName, allowedValues),
  );

  return [...new Set(normalizedValues)];
}

function requireOptionalStatTypes(value: unknown, fieldName: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be a non-empty array of stat type names.`,
      `Call the tool again with '${fieldName}' as an array such as ['goals', 'assists'], or omit it to use the defaults.`,
    );
  }

  // Accept any human spelling ("Shots On Target", "shots-on-target") and
  // normalize to the snake_case key format the stats object uses.
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SportmonksToolError(
        "validation_error",
        `The '${fieldName}' entry at index ${index} must be a non-empty string.`,
        `Call the tool again with '${fieldName}' containing only non-empty stat type names such as 'goals'.`,
      );
    }
    return toSnakeCaseKey(entry);
  });

  return [...new Set(normalized)];
}

function requireOptionalPositiveIntegerArray(value: unknown, fieldName: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be a non-empty array of positive integers.`,
      `Call the tool again with '${fieldName}' as an array such as [154421, 96353], or omit it.`,
    );
  }

  const normalized = value.map((entry, index) => {
    const numericValue =
      typeof entry === "number"
        ? entry
        : typeof entry === "string" && entry.trim() !== ""
          ? Number(entry)
          : Number.NaN;
    if (!Number.isInteger(numericValue) || numericValue <= 0) {
      throw new SportmonksToolError(
        "validation_error",
        `The '${fieldName}' entry at index ${index} must be a positive integer.`,
        `Call the tool again with '${fieldName}' containing only positive integers.`,
      );
    }
    return numericValue;
  });

  return [...new Set(normalized)];
}

function requireDateString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' field must be a date in YYYY-MM-DD format.`,
      `Call the tool again with '${fieldName}' set to a date such as '2026-01-31'.`,
    );
  }

  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new SportmonksToolError(
      "validation_error",
      `The '${fieldName}' value '${value}' is not a valid calendar date.`,
      `Call the tool again with '${fieldName}' set to a real date such as '2026-01-31'.`,
    );
  }

  return trimmed;
}

// ── JSON Helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, path: string[]) {
  let current: unknown = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function getString(value: unknown, path: string[]) {
  const result = readPath(value, path);
  return typeof result === "string" && result.trim() !== "" ? result : null;
}

function getNumber(value: unknown, path: string[]) {
  const result = readPath(value, path);
  if (typeof result === "number" && Number.isFinite(result)) {
    return result;
  }

  if (typeof result === "string" && result.trim() !== "") {
    const numericValue = Number(result);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  return null;
}

function getBoolean(value: unknown, path: string[]) {
  const result = readPath(value, path);
  return typeof result === "boolean" ? result : null;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function toRecordArray(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (isRecord(value) && Array.isArray(value.data)) {
    return value.data.filter(isRecord);
  }

  if (isRecord(value)) {
    return [value];
  }

  return [];
}

function getResponseItems(payload: unknown) {
  if (isRecord(payload) && "data" in payload) {
    return toRecordArray(payload.data);
  }

  return toRecordArray(payload);
}

function getSingleResponseItem(payload: unknown, label: string) {
  const items = getResponseItems(payload);
  if (items.length === 0) {
    throw new SportmonksToolError(
      "not_found",
      `${label} was not found in Sportmonks.`,
      `Verify the id is correct and available in your Sportmonks subscription. If needed, use the 'search' tool first.`,
    );
  }

  return items[0];
}

function getPreferredName(record: unknown) {
  // Sportmonks occasionally returns names with trailing whitespace
  // (e.g. "Bernardo Silva  ", "Rúben Dias "). Trim so downstream string
  // matching and rendering aren't tripped up.
  const raw =
    getString(record, ["display_name"]) ??
    getString(record, ["name"]) ??
    getString(record, ["common_name"]) ??
    getString(record, ["short_code"]);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function getLocalDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function parseDateToMs(value: string | null) {
  if (!value) {
    return 0;
  }

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsedDate = new Date(normalized);
  return Number.isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime();
}

function fixtureHasStarted(fixture: unknown) {
  const stateId = getNumber(fixture, ["state_id"]);
  const stateLookup = stateId !== null ? stateLookupById.get(stateId) ?? null : null;
  const stateCode = (
    stateLookup?.developerName ??
    stateLookup?.state ??
    stateLookup?.shortName ??
    getString(fixture, ["state", "short_name"]) ??
    getString(fixture, ["state", "state"]) ??
    ""
  ).toUpperCase();
  const explicitlyNotStartedStates = new Set(["NS", "NOT_STARTED", "TBD"]);

  if (explicitlyNotStartedStates.has(stateCode)) {
    return false;
  }

  if (stateCode !== "") {
    return true;
  }

  const startingAt = getString(fixture, ["starting_at"]);
  const fixtureStartMs = parseDateToMs(startingAt);

  if (fixtureStartMs === 0) {
    throw new SportmonksToolError(
      "upstream_error",
      "Sportmonks returned a fixture without a valid starting time.",
      "Retry later or use another fixture id. The preview tool requires a valid future start time.",
    );
  }

  return fixtureStartMs <= Date.now();
}

// ── API Helpers ──────────────────────────────────────────────────────────────

function getApiToken() {
  return process.env.SPORTMONKS_API_TOKEN ?? "";
}

async function apiRequest(
  endpoint: string,
  params: Record<string, ParamValue> = {},
  options: ApiRequestOptions = {},
): Promise<unknown> {
  const apiToken = getApiToken();
  if (!apiToken) {
    throw new SportmonksToolError(
      "authentication_error",
      "SPORTMONKS_API_TOKEN is not set.",
      "Set the SPORTMONKS_API_TOKEN environment variable before starting the MCP server.",
    );
  }

  const baseUrl = options.baseUrl ?? FOOTBALL_API_BASE_URL;
  const url = new URL(`${baseUrl}${endpoint}`);
  url.searchParams.set("api_token", apiToken);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  logUpstreamUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET", signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new SportmonksToolError(
        "upstream_error",
        `Sportmonks did not respond within ${API_TIMEOUT_MS / 1000} seconds.`,
        "Retry the same request. If the timeout keeps happening, Sportmonks may be experiencing issues.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) {
    return response.json();
  }

  const responseBody = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new SportmonksToolError(
      "authentication_error",
      "Sportmonks rejected the request. The API token may be invalid or may not have access to this endpoint.",
      "Verify SPORTMONKS_API_TOKEN and confirm the subscription includes the requested Football API data.",
      responseBody,
    );
  }

  if (response.status === 404) {
    throw new SportmonksToolError(
      "not_found",
      "Sportmonks could not find the requested resource.",
      "Check the provided id or search term. If needed, use the 'search' tool first to find a valid id.",
      responseBody,
    );
  }

  if (response.status === 429) {
    throw new SportmonksToolError(
      "rate_limit_error",
      "Sportmonks rate limited the request.",
      "Wait a moment and retry with the same request. Avoid repeated rapid calls.",
      responseBody,
    );
  }

  throw new SportmonksToolError(
    "upstream_error",
    `Sportmonks returned HTTP ${response.status}.`,
    "Retry later. If the error persists, relay the upstream response to the user or check Sportmonks status and endpoint permissions.",
    responseBody,
  );
}

async function fetchAllPages(
  endpoint: string,
  options: ApiRequestOptions = {},
) {
  const allItems: JsonRecord[] = [];
  let page = 1;

  while (true) {
    const payload = await apiRequest(endpoint, { page, per_page: 50, order: "asc" }, options);
    allItems.push(...getResponseItems(payload));

    const hasMore = getBoolean(payload, ["pagination", "has_more"]);
    if (hasMore !== true) {
      break;
    }

    page += 1;
  }

  return allItems;
}

function setReferenceData(typeRecords: JsonRecord[], stateRecords: JsonRecord[]) {
  typeLookupById.clear();
  stateLookupById.clear();

  for (const record of typeRecords) {
    const id = getNumber(record, ["id"]);
    if (id === null) {
      continue;
    }

    typeLookupById.set(id, {
      id,
      code: getString(record, ["code"]),
      developerName: getString(record, ["developer_name"]),
      modelType: getString(record, ["model_type"]),
      name: getString(record, ["name"]),
    });
  }

  for (const record of stateRecords) {
    const id = getNumber(record, ["id"]);
    if (id === null) {
      continue;
    }

    stateLookupById.set(id, {
      id,
      state: getString(record, ["state"]),
      shortName: getString(record, ["short_name"]),
      developerName: getString(record, ["developer_name"]),
      name: getString(record, ["name"]),
    });
  }
}

async function initializeReferenceData() {
  if (typeLookupById.size > 0 && stateLookupById.size > 0) {
    return;
  }

  if (!lookupInitializationPromise) {
    lookupInitializationPromise = (async () => {
      const [typeRecords, stateRecords] = await Promise.all([
        fetchAllPages("/types", { baseUrl: CORE_API_BASE_URL }),
        fetchAllPages("/states"),
      ]);

      setReferenceData(typeRecords, stateRecords);
    })().finally(() => {
      lookupInitializationPromise = null;
    });
  }

  await lookupInitializationPromise;
}

function primeReferenceData(typeRecords: JsonRecord[], stateRecords: JsonRecord[]) {
  setReferenceData(typeRecords, stateRecords);
}

// ── Observability ────────────────────────────────────────────────────────────

const DEFAULT_LOG_FILE_PATH = path.join(os.tmpdir(), "sportmonks-football-mcp.log");

function resolveLogFilePath() {
  const configured = process.env.SPORTMONKS_LOG_FILE;
  if (configured === undefined) {
    return DEFAULT_LOG_FILE_PATH;
  }

  const trimmed = configured.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "off" || trimmed.toLowerCase() === "none") {
    return null;
  }

  return trimmed;
}

const LOG_FILE_PATH = resolveLogFilePath();

function isTruthyEnvFlag(value: string | undefined) {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const DEBUG_URLS = isTruthyEnvFlag(process.env.SPORTMONKS_DEBUG_URLS);

function logUpstreamUrl(url: URL) {
  if (!DEBUG_URLS) return;
  // Always strip the API token before writing — these lines may end up in
  // stderr captures, support tickets, or shared screenshots.
  const redacted = new URL(url.toString());
  if (redacted.searchParams.has("api_token")) {
    redacted.searchParams.set("api_token", "REDACTED");
  }
  process.stderr.write(`[sportmonks] GET ${redacted.toString()}\n`);
}

interface ToolCallLogEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  duration_ms: number;
  outcome: "ok" | "error";
  error_kind?: string;
}

function recordToolCall(entry: ToolCallLogEntry) {
  const line = JSON.stringify(entry);
  process.stderr.write(line + "\n");

  if (LOG_FILE_PATH !== null) {
    try {
      fs.appendFileSync(LOG_FILE_PATH, line + "\n");
    } catch {
      // Logging must never break tool execution, so swallow file errors.
    }
  }
}

// ── Response Helpers ─────────────────────────────────────────────────────────

interface ListMeta {
  returned: number;
  cap: number;
  possibly_more: boolean;
  date_window?: { start: string; end: string };
  stat_types?: string[];
}

function buildListMeta(
  returned: number,
  cap: number,
  upstreamHasMore: boolean | null,
  dateWindow?: { start: string; end: string },
): ListMeta {
  const meta: ListMeta = {
    returned,
    cap,
    possibly_more: upstreamHasMore === true || returned >= cap,
  };
  if (dateWindow) meta.date_window = dateWindow;
  return meta;
}

function listResponse<T>(data: T[], meta: ListMeta): { data: T[]; meta: ListMeta } {
  return { data, meta };
}

function jsonResponse(data: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

function errorResponse(error: unknown): ToolResponse {
  if (error instanceof SportmonksToolError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              error: {
                type: error.kind,
                message: error.message,
                how_to_fix: error.howToFix,
                details: error.details ?? null,
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: {
              type: "tool_error",
              message,
              how_to_fix:
                "Retry the request. If the same error happens again, relay the message to the user because it may require manual investigation.",
              details: null,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

// ── Entity Mapping Helpers ───────────────────────────────────────────────────

function getHomeAndAwayParticipants(fixture: unknown) {
  const participants = toRecordArray(readPath(fixture, ["participants"]));

  const homeParticipant =
    participants.find((participant) => getString(participant, ["meta", "location"]) === "home") ??
    participants[0] ??
    null;
  const awayParticipant =
    participants.find((participant) => getString(participant, ["meta", "location"]) === "away") ??
    participants.find((participant) => participant !== homeParticipant) ??
    null;

  return {
    home: homeParticipant,
    away: awayParticipant,
  };
}

function getLeagueSummary(fixture: unknown) {
  const league = toRecordArray(readPath(fixture, ["league"]))[0] ?? null;

  return {
    id: getNumber(league, ["id"]),
    name: getPreferredName(league),
  };
}

function getStateName(fixture: unknown) {
  return (
    getString(fixture, ["state", "short_name"]) ??
    getString(fixture, ["state", "state"]) ??
    getString(fixture, ["state", "name"]) ??
    stateLookupById.get(getNumber(fixture, ["state_id"]) ?? -1)?.shortName ??
    stateLookupById.get(getNumber(fixture, ["state_id"]) ?? -1)?.state ??
    null
  );
}

function getFixtureGoalsForParticipant(fixture: unknown, participant: unknown) {
  const participantId = getNumber(participant, ["id"]);
  if (participantId === null) {
    return null;
  }

  const scores = toRecordArray(readPath(fixture, ["scores"])).filter(
    (score) => getNumber(score, ["participant_id"]) === participantId,
  );

  const preferredDescriptions = ["CURRENT", "FT", "FULL_TIME", "FINAL", "2ND_HALF", "NORMAL_TIME"];
  const chosenScore =
    preferredDescriptions
      .map((description) =>
        scores.find((score) => (getString(score, ["description"]) ?? "").toUpperCase() === description),
      )
      .find((score) => score !== undefined) ??
    scores[scores.length - 1];

  return (
    getNumber(chosenScore, ["score", "goals"]) ??
    getNumber(chosenScore, ["score", "value"]) ??
    getNumber(chosenScore, ["value"])
  );
}

function getTypeLookupLabel(typeId: number | null) {
  const typeLookup = getTypeLookupById(typeId);
  return typeLookup?.name ?? typeLookup?.code ?? typeLookup?.developerName ?? null;
}

function resolveStatTypeIds(statTypes: string[]) {
  // Reverse of the detail-mapping direction: find every cached type whose
  // label snake-cases to a requested stat name (labels are not guaranteed
  // unique across the ~1300 core types, so collect all matches). Uses the
  // same label precedence as getTypeLookupLabel so forward and reverse
  // mappings agree.
  const ids: number[] = [];
  for (const typeLookup of typeLookupById.values()) {
    const label = typeLookup.name ?? typeLookup.code ?? typeLookup.developerName;
    if (label !== null && statTypes.includes(toSnakeCaseKey(label))) {
      ids.push(typeLookup.id);
    }
  }
  return ids;
}

function normalizeLookupToken(value: string | null) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveTopscorerTypeId(type: TopscorerType) {
  const codeMap: Record<TopscorerType, string[]> = {
    goals: ["goaltopscorer", "goal-topscorer"],
    assists: ["assisttopscorer", "assist-topscorer"],
    cards: ["yellowcards", "yellow-cards"],
  };

  const targetCodes = codeMap[type];

  for (const typeLookup of typeLookupById.values()) {
    const code = normalizeLookupToken(typeLookup.code);
    const developerName = normalizeLookupToken(typeLookup.developerName);

    if (
      targetCodes.includes(code) ||
      targetCodes.includes(developerName)
    ) {
      return typeLookup.id;
    }
  }

  const fallbackMap: Record<TopscorerType, number> = {
    goals: 208,
    assists: 209,
    cards: 84,
  };

  return fallbackMap[type];
}

function getFixtureScoreSummary(fixture: unknown) {
  const { home, away } = getHomeAndAwayParticipants(fixture);

  return {
    home: getFixtureGoalsForParticipant(fixture, home),
    away: getFixtureGoalsForParticipant(fixture, away),
  };
}

function getLineupType(lineup: unknown): "lineup" | "bench" {
  const typeId = getNumber(lineup, ["type_id"]);
  const typeLabel = (
    getTypeLookupLabel(typeId) ??
    getString(lineup, ["type"]) ??
    getPreferredName(readPath(lineup, ["type"])) ??
    ""
  ).toLowerCase();

  if (typeId === 12 || typeLabel.includes("bench") || typeLabel.includes("substitut")) {
    return "bench";
  }

  if (typeId === 11 || typeLabel.includes("lineup") || typeLabel.includes("starting")) {
    return "lineup";
  }

  return readPath(lineup, ["formation_field"]) !== undefined &&
    readPath(lineup, ["formation_field"]) !== null
    ? "lineup"
    : "bench";
}

function toSnakeCaseKey(value: string | null) {
  const normalized = (value ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "unknown";
}

function getStatisticValue(statistic: unknown): unknown {
  const data = readPath(statistic, ["data"]);
  if (isRecord(data)) {
    if (isScalar(data.value)) {
      return data.value;
    }

    if (isScalar(data.total)) {
      return data.total;
    }

    return data;
  }

  const directValue = readPath(statistic, ["value"]);
  return directValue ?? null;
}

function mapSearchResult(record: unknown, entityType: Exclude<SearchEntityType, "all">) {
  // Country lets the LLM disambiguate generic names — e.g. ~12 leagues named
  // "Super League" are otherwise indistinguishable. Just the country name is
  // enough; we don't include the nested country object.
  return {
    id: getNumber(record, ["id"]),
    entity_type: entityType,
    name: getPreferredName(record),
    country: getPreferredName(readPath(record, ["country"])),
  };
}

function mapMatch(record: unknown) {
  const { home, away } = getHomeAndAwayParticipants(record);

  return {
    id: getNumber(record, ["id"]),
    home_team: getPreferredName(home),
    away_team: getPreferredName(away),
    starting_at: getString(record, ["starting_at"]),
    state: getStateName(record),
    league: getLeagueSummary(record),
  };
}

function isUsableMatchRow(row: ReturnType<typeof mapMatch>): boolean {
  // Drop placeholder rows where Sportmonks returned a stub object with no real
  // fixture id. Defense-in-depth alongside getEntityReference's id check.
  return row.id !== null;
}

function getTypeLookupById(typeId: number | null) {
  if (typeId === null) {
    return null;
  }

  return typeLookupById.get(typeId) ?? null;
}

function orderedClubCandidates(playerRecord: unknown): JsonRecord[] {
  // Returns player.teams[] entries sorted club-first / active-first so the
  // caller can iterate and verify with /teams/{id} when the relation row
  // doesn't expose team.type. Order:
  //   1. Relations whose nested team.type is NOT "national" / "national_team"
  //      AND whose end is null (currently active).
  //   2. Relations whose nested team.type isn't visible AND end is null.
  //   3. Relations whose nested team.type IS national but end is null
  //      (last-resort, e.g. all relations are national for some reason).
  //   4. Anything else, sorted by most recent activity.
  // We still let the caller fetch /teams/{id} and re-check team.type as a
  // final guard, since some plans don't populate the nested type field.
  const teams = toRecordArray(readPath(playerRecord, ["teams"]));
  if (teams.length === 0) return [];

  const score = (relation: unknown): number => {
    const nestedType = (getString(relation, ["team", "type"]) ?? "").toLowerCase();
    const isNationalKnown = nestedType === "national" || nestedType === "national_team";
    const isDomesticKnown = nestedType === "domestic";
    const endValue =
      getString(relation, ["meta", "end"]) ??
      getString(relation, ["meta", "end_at"]) ??
      getString(relation, ["end_at"]);
    const isActive = endValue === null;

    if (isDomesticKnown && isActive) return 0;
    if (!isNationalKnown && isActive) return 1;
    if (isActive) return 2; // active national, last-resort active
    return 3;
  };

  return [...teams].sort((left, right) => {
    const scoreDiff = score(left) - score(right);
    if (scoreDiff !== 0) return scoreDiff;
    const leftDate = parseDateToMs(
      getString(left, ["last_played_at"]) ??
        getString(left, ["meta", "start"]) ??
        getString(left, ["meta", "start_at"]),
    );
    const rightDate = parseDateToMs(
      getString(right, ["last_played_at"]) ??
        getString(right, ["meta", "start"]) ??
        getString(right, ["meta", "start_at"]),
    );
    return rightDate - leftDate;
  });
}

function getStandingStat(details: JsonRecord[], typeIds: number[], typeCodes: string[]) {
  for (const detail of details) {
    const typeId = getNumber(detail, ["type_id"]);
    const typeLookup = getTypeLookupById(typeId);
    const typeCode = (typeLookup?.code ?? getString(detail, ["type", "code"]) ?? "").toLowerCase();
    const developerName = (typeLookup?.developerName ?? "").toLowerCase();

    if (
      (typeId !== null && typeIds.includes(typeId)) ||
      typeCodes.includes(typeCode) ||
      typeCodes.includes(developerName)
    ) {
      return getNumber(detail, ["value"]);
    }
  }

  return null;
}

function mapStanding(record: unknown) {
  const participant = toRecordArray(readPath(record, ["participant"]))[0] ?? null;
  const details = toRecordArray(readPath(record, ["details"]));
  const goalsFor = getStandingStat(details, [133], ["overall-goals-for"]);
  const goalsAgainst = getStandingStat(details, [134], ["overall-conceded"]);
  const goalDifference =
    getStandingStat(details, [179], ["goal-difference", "overall-goal-difference"]) ??
    (goalsFor !== null && goalsAgainst !== null ? goalsFor - goalsAgainst : null);

  return {
    position: getNumber(record, ["position"]),
    team: {
      id: getNumber(participant, ["id"]) ?? getNumber(record, ["participant_id"]),
      name: getPreferredName(participant),
    },
    played: getStandingStat(details, [129], ["overall-matches-played"]),
    won: getStandingStat(details, [130], ["overall-won"]),
    drawn: getStandingStat(details, [131], ["overall-draw"]),
    lost: getStandingStat(details, [132], ["overall-lost"]),
    gd: goalDifference,
    points: getStandingStat(details, [187], ["overall-points"]) ?? getNumber(record, ["points"]),
  };
}

function mapOdd(record: unknown) {
  // value/total/handicap stay as the strings Sportmonks sends ("19.00", "2.5",
  // "-1.5") so no formatting or precision is lost. total and handicap are what
  // make lines like Goal Line or Asian Handicap readable: label "Over" with
  // value "2.03" only means something next to total "2.5".
  return {
    bookmaker_id: getNumber(record, ["bookmaker_id"]),
    bookmaker_name: getPreferredName(readPath(record, ["bookmaker"])),
    market_id: getNumber(record, ["market_id"]),
    market_name:
      getPreferredName(readPath(record, ["market"])) ??
      getString(record, ["market_description"]),
    label: getString(record, ["label"]),
    value: getString(record, ["value"]),
    total: getString(record, ["total"]),
    handicap: getString(record, ["handicap"]),
    stopped: getBoolean(record, ["stopped"]),
    last_updated: getString(record, ["latest_bookmaker_update"]),
  };
}

function isUsableOddsRow(row: ReturnType<typeof mapOdd>): boolean {
  // Drop placeholder rows where Sportmonks returned a stub with neither a
  // market nor a price. Mirrors isUsableMatchRow's defense-in-depth.
  return row.market_id !== null || row.value !== null;
}

// ── Tool Implementations ─────────────────────────────────────────────────────

async function fetchSearchResults(query: string, type: SearchEntityType) {
  // Pull a wider page than we expose so we can detect upstream truncation via
  // pagination.has_more, then trim back to MAX_SEARCH_RESULTS.
  const upstreamPerPage = Math.max(MAX_SEARCH_RESULTS * 2, 50);
  const baseParams = { per_page: upstreamPerPage, include: "country" };
  const entityLoaders: Record<Exclude<SearchEntityType, "all">, () => Promise<unknown>> = {
    player: () => apiRequest(`/players/search/${encodeURIComponent(query)}`, baseParams),
    team: () => apiRequest(`/teams/search/${encodeURIComponent(query)}`, baseParams),
    league: () => apiRequest(`/leagues/search/${encodeURIComponent(query)}`, baseParams),
    coach: () => apiRequest(`/coaches/search/${encodeURIComponent(query)}`, baseParams),
  };

  const entityTypes: Array<Exclude<SearchEntityType, "all">> =
    type === "all" ? ["player", "team", "league", "coach"] : [type];

  const payloads = await Promise.all(entityTypes.map((entityType) => entityLoaders[entityType]()));

  const upstreamHasMore = payloads.some(
    (payload) => getBoolean(payload, ["pagination", "has_more"]) === true,
  );

  const merged = payloads
    .flatMap((payload, index) =>
      getResponseItems(payload).map((record) => mapSearchResult(record, entityTypes[index])),
    )
    .filter((result) => result.id !== null && result.name !== null)
    .sort((left, right) => {
      const leftName = left.name ?? "";
      const rightName = right.name ?? "";
      return leftName.localeCompare(rightName);
    });

  const data = merged.slice(0, MAX_SEARCH_RESULTS);
  const truncatedHere = merged.length > data.length;
  return {
    data,
    meta: buildListMeta(data.length, MAX_SEARCH_RESULTS, upstreamHasMore || truncatedHere),
  };
}

async function searchEntities(query: string, type: SearchEntityType) {
  const { data, meta } = await fetchSearchResults(query, type);
  return jsonResponse(listResponse(data, meta));
}

function getCurrentRelation(relations: JsonRecord[]): JsonRecord | null {
  // Coach<->team relations carry `active: true` for the live appointment.
  // Among multiple active rows (rare), prefer permanent over caretaker, then
  // the most recently started. No active row → no current relation (null).
  const active = relations.filter((relation) => getBoolean(relation, ["active"]) === true);
  if (active.length === 0) {
    return null;
  }

  return [...active].sort((left, right) => {
    const leftTemp = getBoolean(left, ["temporary"]) === true ? 1 : 0;
    const rightTemp = getBoolean(right, ["temporary"]) === true ? 1 : 0;
    if (leftTemp !== rightTemp) return leftTemp - rightTemp;
    return parseDateToMs(getString(right, ["start"])) - parseDateToMs(getString(left, ["start"]));
  })[0];
}

async function fetchEntity(id: number, type: EntityType) {
  switch (type) {
    case "player": {
      // teams.team brings the nested Team object so we can read team.type
      // ("domestic" vs "national") without a second roundtrip per candidate.
      const payload = await apiRequest(`/players/${id}`, {
        include: "position;nationality;teams.team",
      });
      const player = getSingleResponseItem(payload, "Player");
      const candidates = orderedClubCandidates(player);

      // Walk candidates club-first; if the candidate's type isn't visible in
      // the relation, fetch /teams/{id} and check there. Skip national teams.
      // In the common case (player on club + national team) this is one team
      // fetch, same as before.
      let currentTeam: unknown = null;
      let currentTeamId: number | null = null;
      for (const candidate of candidates) {
        const candidateId =
          getNumber(candidate, ["team_id"]) ??
          getNumber(candidate, ["team", "id"]) ??
          getNumber(candidate, ["id"]);
        if (candidateId === null) continue;

        const nestedType = (getString(candidate, ["team", "type"]) ?? "").toLowerCase();
        if (nestedType === "national" || nestedType === "national_team") continue;

        const teamPayload = await apiRequest(`/teams/${candidateId}`);
        const team = getSingleResponseItem(teamPayload, "Current team");
        const fetchedType = (getString(team, ["type"]) ?? "").toLowerCase();
        if (fetchedType === "national" || fetchedType === "national_team") continue;

        currentTeam = team;
        currentTeamId = candidateId;
        break;
      }

      return {
        id: getNumber(player, ["id"]),
        name: getPreferredName(player),
        position: getPreferredName(readPath(player, ["position"])),
        nationality: getPreferredName(readPath(player, ["nationality"])),
        date_of_birth: getString(player, ["date_of_birth"]),
        current_team: currentTeam
          ? {
              id: currentTeamId,
              name: getPreferredName(currentTeam),
            }
          : null,
      };
    }
    case "team": {
      // coaches.coach brings the nested Coach object so we can name the current
      // manager without a second roundtrip.
      const teamPayload = await apiRequest(`/teams/${id}`, { include: "venue;country;coaches.coach" });
      const team = getSingleResponseItem(teamPayload, "Team");
      const coachRelation = getCurrentRelation(toRecordArray(readPath(team, ["coaches"])));
      const coach = coachRelation ? readPath(coachRelation, ["coach"]) : null;

      return {
        id: getNumber(team, ["id"]),
        name: getPreferredName(team),
        country: getPreferredName(readPath(team, ["country"])),
        venue: getPreferredName(readPath(team, ["venue"])),
        coach: coachRelation
          ? {
              id: getNumber(coach, ["id"]) ?? getNumber(coachRelation, ["coach_id"]),
              name: getPreferredName(coach),
            }
          : null,
      };
    }
    case "coach": {
      // teams.team brings the nested Team object so we can name the current club
      // (the active relation) without a second roundtrip. Mirrors get_player.
      const payload = await apiRequest(`/coaches/${id}`, {
        include: "nationality;teams.team",
      });
      const coach = getSingleResponseItem(payload, "Coach");
      const currentRelation = getCurrentRelation(toRecordArray(readPath(coach, ["teams"])));
      const team = currentRelation ? readPath(currentRelation, ["team"]) : null;

      return {
        id: getNumber(coach, ["id"]),
        name: getPreferredName(coach),
        nationality: getPreferredName(readPath(coach, ["nationality"])),
        date_of_birth: getString(coach, ["date_of_birth"]),
        current_team: currentRelation
          ? {
              id: getNumber(team, ["id"]) ?? getNumber(currentRelation, ["team_id"]),
              name: getPreferredName(team),
            }
          : null,
      };
    }
    case "league": {
      const payload = await apiRequest(`/leagues/${id}`, { include: "country;currentseason" });
      const league = getSingleResponseItem(payload, "League");
      const currentSeason = readPath(league, ["currentseason"]);

      return {
        id: getNumber(league, ["id"]),
        name: getPreferredName(league),
        country: getPreferredName(readPath(league, ["country"])),
        current_season_id:
          getNumber(currentSeason, ["id"]) ??
          getNumber(league, ["current_season_id"]),
        current_season_name: getPreferredName(currentSeason),
      };
    }
  }
}

async function getPlayer(id: number) {
  return jsonResponse(await fetchEntity(id, "player"));
}

async function getTeam(id: number) {
  return jsonResponse(await fetchEntity(id, "team"));
}

async function getLeague(id: number) {
  return jsonResponse(await fetchEntity(id, "league"));
}

async function getCoach(id: number) {
  return jsonResponse(await fetchEntity(id, "coach"));
}

async function fetchMatches(id: number, type: MatchEntityType, timeframe: MatchTimeframe) {
  await getEntityReference(id, type);

  if (timeframe === "live") {
    const params: Record<string, ParamValue> = {
      include: "participants;league",
    };

    if (type === "league") {
      params.filters = `fixtureLeagues:${id}`;
    }

    const payload = await apiRequest("/livescores/inplay", params);
    const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
    const filtered = getResponseItems(payload).filter((record) =>
      type === "league"
        ? true
        : toRecordArray(readPath(record, ["participants"])).some(
            (participant) => getNumber(participant, ["id"]) === id,
          ),
    );
    const data = filtered.slice(0, MAX_MATCH_RESULTS).map(mapMatch).filter(isUsableMatchRow);
    const truncatedHere = filtered.length > data.length;
    return {
      data,
      meta: buildListMeta(data.length, MAX_MATCH_RESULTS, upstreamHasMore === true || truncatedHere),
    };
  }

  const today = startOfLocalDay();
  const startDate =
    timeframe === "upcoming"
      ? getLocalDateString(today)
      : getLocalDateString(addDays(today, -HISTORIC_WINDOW_DAYS));
  const endDate =
    timeframe === "upcoming"
      ? getLocalDateString(addDays(today, UPCOMING_WINDOW_DAYS))
      : getLocalDateString(today);
  const order = timeframe === "upcoming" ? "asc" : "desc";

  const endpoint =
    type === "team"
      ? `/fixtures/between/${startDate}/${endDate}/${id}`
      : `/fixtures/between/${startDate}/${endDate}`;

  const params: Record<string, ParamValue> = {
    include: "participants;league",
    per_page: MAX_MATCH_RESULTS,
  };

  if (timeframe === "historic") {
    params.order = order;
  }

  if (type === "league") {
    params.filters = `fixtureLeagues:${id}`;
  }

  const payload = await apiRequest(endpoint, params);
  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
  const items = getResponseItems(payload);
  const data = items.slice(0, MAX_MATCH_RESULTS).map(mapMatch).filter(isUsableMatchRow);
  const truncatedHere = items.length > data.length;
  return {
    data,
    meta: buildListMeta(
      data.length,
      MAX_MATCH_RESULTS,
      upstreamHasMore === true || truncatedHere,
      { start: startDate, end: endDate },
    ),
  };
}

async function getMatches(id: number, type: MatchEntityType, timeframe: MatchTimeframe) {
  const { data, meta } = await fetchMatches(id, type, timeframe);
  return jsonResponse(listResponse(data, meta));
}

const SQUAD_PER_PAGE = 50;

async function fetchSquad(teamId: number, seasonId?: number) {
  const endpoint =
    seasonId === undefined
      ? `/squads/teams/${teamId}`
      : `/squads/seasons/${seasonId}/teams/${teamId}`;
  const include =
    seasonId === undefined
      ? "player;position;detailedPosition"
      : "player;position";

  const payload = await apiRequest(endpoint, { include, per_page: SQUAD_PER_PAGE });
  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);

  const data = getResponseItems(payload).map((record) => {
    const player = toRecordArray(readPath(record, ["player"]))[0] ?? null;
    const position = readPath(record, ["position"]);
    const detailedPosition =
      readPath(record, ["detailedPosition"]) ?? readPath(record, ["detailedposition"]);

    const positionId =
      getNumber(position, ["id"]) ??
      getNumber(record, ["position_id"]) ??
      getNumber(player, ["position_id"]);
    const detailedPositionId =
      getNumber(detailedPosition, ["id"]) ??
      getNumber(record, ["detailed_position_id"]) ??
      getNumber(player, ["detailed_position_id"]);

    return {
      player_id: getNumber(player, ["id"]) ?? getNumber(record, ["player_id"]),
      name: getPreferredName(player) ?? getString(record, ["player_name"]),
      position:
        getPreferredName(position) ??
        (positionId !== null ? getTypeLookupLabel(positionId) : null),
      position_id: positionId,
      detailed_position:
        getPreferredName(detailedPosition) ??
        (detailedPositionId !== null ? getTypeLookupLabel(detailedPositionId) : null),
      detailed_position_id: detailedPositionId,
      jersey_number:
        getNumber(record, ["jersey_number"]) ??
        getNumber(record, ["number"]) ??
        getNumber(player, ["jersey_number"]),
    };
  });

  return {
    data,
    meta: buildListMeta(data.length, SQUAD_PER_PAGE, upstreamHasMore),
  };
}

async function getSquad(teamId: number, seasonId?: number) {
  const { data, meta } = await fetchSquad(teamId, seasonId);
  return jsonResponse(listResponse(data, meta));
}

async function fetchMatchPreview(id: number) {
  const fixturePayload = await apiRequest(`/fixtures/${id}`, {
    include: "participants",
  });
  const fixture = getSingleResponseItem(fixturePayload, "Fixture");

  if (fixtureHasStarted(fixture)) {
    throw new SportmonksToolError(
      "validation_error",
      "get_match_preview only works for fixtures that have not started yet.",
      "Call the tool again with a future fixture id that has not started. Use get_matches with timeframe='upcoming' to find one.",
    );
  }

  const { home, away } = getHomeAndAwayParticipants(fixture);
  const homeId = getNumber(home, ["id"]);
  const awayId = getNumber(away, ["id"]);

  if (homeId === null || awayId === null) {
    throw new SportmonksToolError(
      "upstream_error",
      "Sportmonks returned the fixture without two identifiable participants.",
      "Retry later. If the problem persists, ask the user for a different fixture id.",
    );
  }

  const h2hPayload = await apiRequest(`/fixtures/head-to-head/${homeId}/${awayId}`, {
    include: "participants;scores",
    per_page: 5,
    order: "desc",
  });

  const headToHead = getResponseItems(h2hPayload)
    .filter((record) => getNumber(record, ["id"]) !== id)
    .slice(0, 5)
    .map((record) => {
      const participants = getHomeAndAwayParticipants(record);

      return {
        date: getString(record, ["starting_at"])?.slice(0, 10) ?? null,
        home_team: getPreferredName(participants.home),
        away_team: getPreferredName(participants.away),
        home_score: getFixtureGoalsForParticipant(record, participants.home),
        away_score: getFixtureGoalsForParticipant(record, participants.away),
        result_info: getString(record, ["result_info"]),
      };
    });

  return {
    id: getNumber(fixture, ["id"]),
    home_team: getPreferredName(home),
    away_team: getPreferredName(away),
    starting_at: getString(fixture, ["starting_at"]),
    last_5_h2h_matches: headToHead,
  };
}

async function getMatchPreview(id: number) {
  return jsonResponse(await fetchMatchPreview(id));
}

async function fetchFixtureDetails(
  fixtureId: number,
  includes: FixtureDetailInclude[],
) {
  // For lineups we want the player relation (so we can read the player's
  // detailed_position_id and resolve a label via the types cache) and the
  // position relation (broad position name). We also try lineups.detailedPosition
  // defensively — Sportmonks silently ignores unsupported includes, and some
  // plans/endpoints surface it directly on the lineup row. The mapper below
  // reads both `detailedPosition` and `detailedposition` keys to handle either
  // casing the upstream may emit.
  // Source: https://docs.sportmonks.com/football/tutorials-and-guides/tutorials/includes/lineups
  const expandedIncludes = includes.flatMap((entry) => {
    if (entry === "lineups") {
      return ["lineups.player", "lineups.position", "lineups.detailedPosition"];
    }
    // The user-facing 'xg' include maps to the Sportmonks 'xGFixture' relation.
    if (entry === "xg") {
      return ["xGFixture"];
    }
    return [entry];
  });
  const includeValue = ["participants", "scores", "league", "state", ...expandedIncludes].join(";");

  let payload: unknown;
  try {
    payload = await apiRequest(`/fixtures/${fixtureId}`, {
      include: includeValue,
    });
  } catch (error) {
    // Predictions are a Sportmonks add-on. When the subscription lacks it, the
    // include doesn't degrade silently — the WHOLE fixtures request fails with
    // 403 ("You do not have access to the 'predictions' include"), so surface
    // an error that tells the caller how to get the rest of the data back.
    if (
      includes.includes("predictions") &&
      error instanceof SportmonksToolError &&
      error.kind === "authentication_error"
    ) {
      throw new SportmonksToolError(
        "authentication_error",
        "Sportmonks rejected the request. The predictions include requires a subscription with the predictions add-on.",
        "Call the tool again without 'predictions' in includes for the remaining fixture data, or upgrade the Sportmonks subscription to include predictions. If other tools also fail, verify SPORTMONKS_API_TOKEN instead.",
        error.details,
      );
    }
    throw error;
  }

  const fixture = getSingleResponseItem(payload, "Fixture");
  const { home, away } = getHomeAndAwayParticipants(fixture);
  const scoreSummary = getFixtureScoreSummary(fixture);

  const response: JsonRecord = {
    id: getNumber(fixture, ["id"]),
    home_team: {
      id: getNumber(home, ["id"]),
      name: getPreferredName(home),
    },
    away_team: {
      id: getNumber(away, ["id"]),
      name: getPreferredName(away),
    },
    starting_at: getString(fixture, ["starting_at"]),
    state: getStateName(fixture),
    league: getLeagueSummary(fixture),
    scores: {
      home: scoreSummary.home,
      away: scoreSummary.away,
    },
  };

  if (includes.includes("lineups")) {
    const lineups = toRecordArray(readPath(fixture, ["lineups"]));
    response.lineups = lineups.map((lineup) => {
      const player = toRecordArray(readPath(lineup, ["player"]))[0] ?? null;
      const position = readPath(lineup, ["position"]);
      // Sportmonks has emitted detailedPosition under both camelCase and
      // lowercase keys depending on plan/endpoint — read whichever is present.
      const detailedPosition =
        readPath(lineup, ["detailedPosition"]) ?? readPath(lineup, ["detailedposition"]);

      const positionId =
        getNumber(position, ["id"]) ??
        getNumber(lineup, ["position_id"]) ??
        getNumber(player, ["position_id"]);
      // Lineup records don't carry detailed_position_id; the player record does.
      const detailedPositionId =
        getNumber(detailedPosition, ["id"]) ??
        getNumber(player, ["detailed_position_id"]) ??
        getNumber(lineup, ["detailed_position_id"]);

      return {
        player_id: getNumber(player, ["id"]) ?? getNumber(lineup, ["player_id"]),
        player_name: getPreferredName(player) ?? getString(lineup, ["player_name"]),
        // team_id lets consumers split home vs away without inferring from order.
        team_id: getNumber(lineup, ["team_id"]),
        jersey_number:
          getNumber(lineup, ["jersey_number"]) ??
          getNumber(lineup, ["number"]) ??
          getNumber(player, ["jersey_number"]),
        position:
          getPreferredName(position) ??
          (positionId !== null ? getTypeLookupLabel(positionId) : null),
        detailed_position:
          getPreferredName(detailedPosition) ??
          (detailedPositionId !== null ? getTypeLookupLabel(detailedPositionId) : null),
        type: getLineupType(lineup),
      };
    });
  }

  if (includes.includes("events")) {
    const events = toRecordArray(readPath(fixture, ["events"])).sort((left, right) => {
      const leftOrder = getNumber(left, ["sort_order"]) ?? getNumber(left, ["minute"]) ?? 0;
      const rightOrder = getNumber(right, ["sort_order"]) ?? getNumber(right, ["minute"]) ?? 0;
      return leftOrder - rightOrder;
    });

    response.events = events.map((event) => ({
      minute: getNumber(event, ["minute"]),
      type:
        getTypeLookupLabel(getNumber(event, ["type_id"])) ??
        getPreferredName(readPath(event, ["type"])) ??
        getString(event, ["type"]),
      player_name: getString(event, ["player_name"]),
      related_player_name: getString(event, ["related_player_name"]),
      result: getString(event, ["result"]),
      info: getString(event, ["info"]),
    }));
  }

  if (includes.includes("statistics")) {
    const participants = toRecordArray(readPath(fixture, ["participants"]));
    const participantById = new Map(
      participants
        .map((participant) => [getNumber(participant, ["id"]), participant] as const)
        .filter(([participantId]) => participantId !== null),
    );
    const groupedStatistics = new Map<
      number,
      { team_id: number; team_name: string | null; stats: Record<string, unknown> }
    >();

    for (const statistic of toRecordArray(readPath(fixture, ["statistics"]))) {
      const participantId = getNumber(statistic, ["participant_id"]);
      if (participantId === null) {
        continue;
      }

      const participant = participantById.get(participantId) ?? null;
      const key = toSnakeCaseKey(
        getTypeLookupLabel(getNumber(statistic, ["type_id"])) ??
          getPreferredName(readPath(statistic, ["type"])),
      );
      const existing =
        groupedStatistics.get(participantId) ?? {
          team_id: participantId,
          team_name: getPreferredName(participant),
          stats: {},
        };

      existing.stats[key] = getStatisticValue(statistic);
      groupedStatistics.set(participantId, existing);
    }

    response.statistics = [...groupedStatistics.values()];
  }

  if (includes.includes("xg")) {
    // xGFixture rows are per type, per team (keyed by participant_id like
    // statistics). Collapse the two curated types into one row per team. An
    // empty xgfixture relation (upcoming fixtures, or live/finished fixtures
    // without xG coverage) yields an empty array.
    const participants = toRecordArray(readPath(fixture, ["participants"]));
    const participantById = new Map(
      participants
        .map((participant) => [getNumber(participant, ["id"]), participant] as const)
        .filter(([participantId]) => participantId !== null),
    );
    const xgByTeam = new Map<
      number,
      { team_id: number; team_name: string | null; xg: number | null; xg_on_target: number | null }
    >();

    for (const row of toRecordArray(readPath(fixture, ["xgfixture"]))) {
      const typeId = getNumber(row, ["type_id"]);
      if (typeId !== XG_TYPE_ID && typeId !== XGOT_TYPE_ID) {
        continue;
      }

      const teamId = getNumber(row, ["participant_id"]) ?? getNumber(row, ["team_id"]);
      if (teamId === null) {
        continue;
      }

      const existing =
        xgByTeam.get(teamId) ?? {
          team_id: teamId,
          team_name: getPreferredName(participantById.get(teamId)),
          xg: null,
          xg_on_target: null,
        };

      const value = getNumber(row, ["data", "value"]);
      if (typeId === XG_TYPE_ID) {
        existing.xg = value;
      } else {
        existing.xg_on_target = value;
      }
      xgByTeam.set(teamId, existing);
    }

    response.xg = [...xgByTeam.values()];
  }

  if (includes.includes("predictions")) {
    const rows = toRecordArray(readPath(fixture, ["predictions"]));
    const predictionByType = (typeId: number) =>
      rows.find((row) => getNumber(row, ["type_id"]) === typeId) ?? null;

    const fulltimeResult = predictionByType(PREDICTION_TYPE_FULLTIME_RESULT);
    const btts = predictionByType(PREDICTION_TYPE_BTTS);
    const overUnder = predictionByType(PREDICTION_TYPE_OVER_UNDER_2_5);
    const valueBets = rows.filter(
      (row) => getNumber(row, ["type_id"]) === PREDICTION_TYPE_VALUEBET,
    );

    // Probabilities are percentages on a 0-100 scale, exactly as Sportmonks
    // returns them. btts and over_2_5 carry only the positive direction
    // ('yes'); the inverse is derivable. value_bets keeps the upstream fields:
    // 'bet' uses 1X2 notation ("1" home, "X" draw, "2" away).
    response.predictions = {
      home_win: getNumber(fulltimeResult, ["predictions", "home"]),
      draw: getNumber(fulltimeResult, ["predictions", "draw"]),
      away_win: getNumber(fulltimeResult, ["predictions", "away"]),
      btts: getNumber(btts, ["predictions", "yes"]),
      over_2_5: getNumber(overUnder, ["predictions", "yes"]),
      value_bets: valueBets.map((row) => ({
        bet: getString(row, ["predictions", "bet"]),
        bookmaker: getString(row, ["predictions", "bookmaker"]),
        fair_odd: getNumber(row, ["predictions", "fair_odd"]),
        odd: getNumber(row, ["predictions", "odd"]),
        stake: getNumber(row, ["predictions", "stake"]),
        is_value: getBoolean(row, ["predictions", "is_value"]),
      })),
    };
  }

  return response;
}

async function getFixtureDetails(fixtureId: number, includes: FixtureDetailInclude[]) {
  return jsonResponse(await fetchFixtureDetails(fixtureId, includes));
}

function isUsableStandingRow(row: ReturnType<typeof mapStanding>): boolean {
  // The /standings/live endpoint returns a placeholder row of all-nulls when
  // no live standings are available. Reject rows missing both a participant
  // and a numeric position so the caller gets `[]` rather than a misleading row.
  return row.team.id !== null || row.team.name !== null || row.position !== null;
}

const STANDINGS_PER_PAGE = 50;

async function fetchStandings(leagueId: number) {
  await getEntityReference(leagueId, "league");

  // Step 1: try live standings. Pull a wide page so competitions with 36+ rows
  // (e.g. Champions League league phase) come back complete without paging.
  // Sportmonks may return either 200 with an empty/placeholder list or 404
  // when no live standings are available; treat both as "fall through to the
  // season-based fallback" rather than surfacing 404 as a terminal error.
  let liveRows: ReturnType<typeof mapStanding>[] = [];
  let liveUpstreamHasMore: boolean | null = null;
  try {
    const livePayload = await apiRequest(`/standings/live/leagues/${leagueId}`, {
      include: "participant;details",
      per_page: STANDINGS_PER_PAGE,
    });
    liveRows = getResponseItems(livePayload).map(mapStanding).filter(isUsableStandingRow);
    liveUpstreamHasMore = getBoolean(livePayload, ["pagination", "has_more"]);
  } catch (error) {
    if (!(error instanceof SportmonksToolError) || error.kind !== "not_found") {
      throw error;
    }
  }

  if (liveRows.length > 0) {
    return {
      data: liveRows,
      meta: buildListMeta(liveRows.length, STANDINGS_PER_PAGE, liveUpstreamHasMore),
    };
  }

  // Step 2: live returned nothing. Fall back to season-based standings using
  // the league's current season.
  const leaguePayload = await apiRequest(`/leagues/${leagueId}`, {
    include: "currentseason",
  });
  const league = getSingleResponseItem(leaguePayload, "League");
  const currentSeasonId =
    getNumber(league, ["currentseason", "id"]) ??
    getNumber(league, ["current_season_id"]) ??
    getNumber(league, ["currentSeason", "id"]);

  if (currentSeasonId === null) {
    return {
      data: [],
      meta: buildListMeta(0, STANDINGS_PER_PAGE, false),
    };
  }

  const seasonPayload = await apiRequest(`/standings/seasons/${currentSeasonId}`, {
    include: "participant;details",
    per_page: STANDINGS_PER_PAGE,
  });
  const seasonRows = getResponseItems(seasonPayload).map(mapStanding).filter(isUsableStandingRow);
  const upstreamHasMore = getBoolean(seasonPayload, ["pagination", "has_more"]);
  return {
    data: seasonRows,
    meta: buildListMeta(seasonRows.length, STANDINGS_PER_PAGE, upstreamHasMore),
  };
}

async function getStandings(leagueId: number) {
  const { data, meta } = await fetchStandings(leagueId);
  return jsonResponse(listResponse(data, meta));
}

async function fetchHistoricSeasons(leagueId: number) {
  const payload = await apiRequest(`/leagues/${leagueId}`, { include: "seasons" });
  const league = getSingleResponseItem(payload, "League");
  const seasons = toRecordArray(readPath(league, ["seasons"]));

  return seasons
    .map((season) => ({
      id: getNumber(season, ["id"]),
      name: getPreferredName(season),
      is_current:
        getBoolean(season, ["is_current"]) ??
        getBoolean(season, ["current"]) ??
        false,
      finished: getBoolean(season, ["finished"]) ?? false,
      starting_at: getString(season, ["starting_at"]),
      ending_at: getString(season, ["ending_at"]),
    }))
    .sort((left, right) => {
      const leftDate = parseDateToMs(left.ending_at) || parseDateToMs(left.starting_at);
      const rightDate = parseDateToMs(right.ending_at) || parseDateToMs(right.starting_at);
      return rightDate - leftDate;
    });
}

async function getHistoricSeasons(leagueId: number) {
  return jsonResponse(await fetchHistoricSeasons(leagueId));
}

async function fetchTopscorers(
  seasonId: number,
  type: TopscorerType,
  limit: number,
) {
  const topscorerTypeId = resolveTopscorerTypeId(type);
  const payload = await apiRequest(`/topscorers/seasons/${seasonId}`, {
    include: "player;participant;type",
    filters: `seasonTopscorerTypes:${topscorerTypeId}`,
    per_page: limit,
    order: "asc",
  });

  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
  const items = getResponseItems(payload);
  const data = items.slice(0, limit).map((record) => {
    const player = toRecordArray(readPath(record, ["player"]))[0] ?? null;
    const team = toRecordArray(readPath(record, ["participant"]))[0] ?? null;

    return {
      position: getNumber(record, ["position"]),
      player: {
        id: getNumber(player, ["id"]) ?? getNumber(record, ["player_id"]),
        name: getPreferredName(player),
      },
      team: {
        id: getNumber(team, ["id"]) ?? getNumber(record, ["participant_id"]),
        name: getPreferredName(team),
      },
      total: getNumber(record, ["total"]),
    };
  });
  const truncatedHere = items.length > data.length;
  return {
    data,
    meta: buildListMeta(data.length, limit, upstreamHasMore === true || truncatedHere),
  };
}

async function getTopscorers(
  seasonId: number,
  type: TopscorerType,
  limit: number,
) {
  const { data, meta } = await fetchTopscorers(seasonId, type, limit);
  return jsonResponse(listResponse(data, meta));
}

async function assertFixtureExists(fixtureId: number) {
  // Same caveat as getEntityReference: Sportmonks doesn't reliably 404 on
  // unknown ids, so verify the response actually carries a fixture id. Build
  // the error here rather than relying on getSingleResponseItem or the
  // apiRequest 404 mapping — their generic messages recommend the 'search'
  // tool, which cannot find fixture ids.
  const notFound = new SportmonksToolError(
    "not_found",
    `Fixture ${fixtureId} was not found in Sportmonks.`,
    "Verify the fixture id is correct and available in your Sportmonks subscription. Use get_matches to find a valid fixture id.",
  );

  let payload: unknown;
  try {
    payload = await apiRequest(`/fixtures/${fixtureId}`);
  } catch (error) {
    if (error instanceof SportmonksToolError && error.kind === "not_found") {
      throw notFound;
    }
    throw error;
  }

  const fixture = getResponseItems(payload)[0] ?? null;
  if (getNumber(fixture, ["id"]) === null) {
    throw notFound;
  }
}

async function fetchOdds(
  fixtureId: number,
  type: OddsFeedType,
  limit: number,
  marketId?: number,
  bookmakerId?: number,
) {
  const endpoint =
    type === "premium"
      ? `/odds/premium/fixtures/${fixtureId}`
      : `/odds/pre-match/fixtures/${fixtureId}`;

  // Both filters compose on the one fixture endpoint, so a single request
  // covers every filter combination including market + bookmaker together.
  const filters = [
    ...(marketId !== undefined ? [`markets:${marketId}`] : []),
    ...(bookmakerId !== undefined ? [`bookmakers:${bookmakerId}`] : []),
  ].join(";");

  const params: Record<string, ParamValue> = { include: "market;bookmaker" };
  if (filters !== "") {
    params.filters = filters;
  }

  let payload: unknown;
  try {
    payload = await apiRequest(endpoint, params);
  } catch (error) {
    if (error instanceof SportmonksToolError && error.kind === "authentication_error") {
      throw new SportmonksToolError(
        "authentication_error",
        type === "premium"
          ? "Sportmonks rejected the premium odds request. The premium odds feed requires a subscription tier that includes it."
          : "Sportmonks rejected the odds request. The subscription may not include the standard pre-match odds feed.",
        type === "premium"
          ? "Retry with type='prematch' for the standard feed, or upgrade the Sportmonks subscription to include premium odds."
          : "Verify SPORTMONKS_API_TOKEN and confirm the subscription includes the pre-match odds feed.",
        error.details,
      );
    }
    throw error;
  }

  const rows = getResponseItems(payload).map(mapOdd).filter(isUsableOddsRow);

  if (rows.length === 0) {
    // Sportmonks returns 200 with empty data both for unknown fixtures and for
    // fixtures that simply carry no odds (or none matching the filters), so
    // disambiguate before reporting an empty result.
    await assertFixtureExists(fixtureId);
    return { data: rows, meta: buildListMeta(0, limit, false) };
  }

  // The odds endpoints return the full set in one response (no pagination;
  // thousands of entries for a well-covered fixture), so sort before capping
  // to keep truncation deterministic and surface the headline market
  // (market 1, Fulltime Result) first.
  rows.sort((left, right) => {
    const leftMarket = left.market_id ?? Number.MAX_SAFE_INTEGER;
    const rightMarket = right.market_id ?? Number.MAX_SAFE_INTEGER;
    if (leftMarket !== rightMarket) return leftMarket - rightMarket;
    const leftBookmaker = left.bookmaker_id ?? Number.MAX_SAFE_INTEGER;
    const rightBookmaker = right.bookmaker_id ?? Number.MAX_SAFE_INTEGER;
    if (leftBookmaker !== rightBookmaker) return leftBookmaker - rightBookmaker;
    return (left.label ?? "").localeCompare(right.label ?? "");
  });

  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
  const data = rows.slice(0, limit);
  const truncatedHere = rows.length > data.length;
  return {
    data,
    meta: buildListMeta(data.length, limit, upstreamHasMore === true || truncatedHere),
  };
}

async function getOdds(
  fixtureId: number,
  type: OddsFeedType,
  limit: number,
  marketId?: number,
  bookmakerId?: number,
) {
  const { data, meta } = await fetchOdds(fixtureId, type, limit, marketId, bookmakerId);
  return jsonResponse(listResponse(data, meta));
}

function getSeasonStatValue(detail: unknown): unknown {
  // Detail values are heterogeneous: {total: 43}, {value: "7.01"},
  // {count, average}, {all/home/away splits}, ... Unwrap single-key objects
  // holding a scalar so the common case reads as a plain number; keep
  // multi-key objects raw because every key carries information.
  const value = readPath(detail, ["value"]);
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && isScalar(value[keys[0]])) {
      return value[keys[0]];
    }
    return value;
  }

  return isScalar(value) ? value : null;
}

function mapSeasonStatsRow(
  record: unknown,
  entityType: SeasonStatsEntityType,
  statTypes: string[],
) {
  const stats: Record<string, unknown> = {};
  for (const detail of toRecordArray(readPath(record, ["details"]))) {
    const label = getTypeLookupLabel(getNumber(detail, ["type_id"]));
    if (label === null) {
      continue;
    }

    const key = toSnakeCaseKey(label);
    if (!statTypes.includes(key)) {
      continue;
    }

    stats[key] = getSeasonStatValue(detail);
  }

  const entity =
    entityType === "player"
      ? toRecordArray(readPath(record, ["player"]))[0] ?? null
      : toRecordArray(readPath(record, ["team"]))[0] ?? null;

  const row: JsonRecord = {
    entity_id:
      getNumber(record, [entityType === "player" ? "player_id" : "team_id"]) ??
      getNumber(entity, ["id"]),
    entity_name: getPreferredName(entity),
    entity_type: entityType,
    season_id: getNumber(record, ["season_id"]),
    season_name: getPreferredName(readPath(record, ["season"])),
    stats,
  };

  if (entityType === "player") {
    // A player's season stats are per club; expose which club this row covers
    // so mid-season transfers (one row per club) stay distinguishable.
    row.team = {
      id: getNumber(record, ["team_id"]),
      name: getPreferredName(readPath(record, ["team"])),
    };
  }

  return row;
}

async function fetchSeasonStats(
  entityId: number,
  entityType: SeasonStatsEntityType,
  seasonId: number,
  statTypes?: string[],
) {
  const appliedStatTypes =
    statTypes ?? (entityType === "player" ? DEFAULT_PLAYER_STAT_TYPES : DEFAULT_TEAM_STAT_TYPES);

  const endpoint =
    entityType === "player"
      ? `/statistics/seasons/players/${entityId}`
      : `/statistics/seasons/teams/${entityId}`;
  const seasonFilter =
    entityType === "player" ? `playerstatisticSeasons:${seasonId}` : `teamstatisticSeasons:${seasonId}`;
  const include = entityType === "player" ? "player;team;season" : "team;season";

  const payload = await apiRequest(endpoint, {
    include,
    filters: seasonFilter,
    per_page: 50,
  });

  const items = getResponseItems(payload);

  const buildMeta = (returned: number, upstreamHasMore: boolean | null) => {
    const meta = buildListMeta(returned, MAX_SEASON_STATS_ROWS, upstreamHasMore);
    meta.stat_types = appliedStatTypes;
    return meta;
  };

  if (items.length === 0) {
    // Sportmonks returns 200 with empty data both for unknown entities and for
    // seasons the entity has no statistics in, so disambiguate before
    // reporting an empty result. An unknown season also lands here — the
    // caller can verify season ids via get_historic_seasons.
    await getEntityReference(entityId, entityType);
    return { data: [], meta: buildMeta(0, false) };
  }

  const rows = items
    .map((record) => mapSeasonStatsRow(record, entityType, appliedStatTypes))
    .filter((row) => row.entity_id !== null || row.season_id !== null);

  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
  const data = rows.slice(0, MAX_SEASON_STATS_ROWS);
  const truncatedHere = rows.length > data.length;
  return {
    data,
    meta: buildMeta(data.length, upstreamHasMore === true || truncatedHere),
  };
}

async function getSeasonStats(
  entityId: number,
  entityType: SeasonStatsEntityType,
  seasonId: number,
  statTypes?: string[],
) {
  const { data, meta } = await fetchSeasonStats(entityId, entityType, seasonId, statTypes);
  return jsonResponse(listResponse(data, meta));
}

async function fetchFixtureLineupStats(
  fixtureId: number,
  playerIds?: number[],
  statTypes?: string[],
) {
  const appliedStatTypes = statTypes ?? DEFAULT_LINEUP_STAT_TYPES;
  const statTypeIds = resolveStatTypeIds(appliedStatTypes);

  // An unfiltered fixture carries ~900 detail rows across ~60 stat types, so
  // push the stat filter upstream via lineupdetailTypes. When no requested
  // name resolves to a known type, skip the details include entirely — the
  // stats objects would be empty either way.
  const params: Record<string, ParamValue> = {
    include: statTypeIds.length > 0 ? "lineups.details;participants" : "lineups;participants",
  };
  if (statTypeIds.length > 0) {
    params.filters = `lineupdetailTypes:${statTypeIds.join(",")}`;
  }

  const notFound = new SportmonksToolError(
    "not_found",
    `Fixture ${fixtureId} was not found in Sportmonks.`,
    "Verify the fixture id is correct and available in your Sportmonks subscription. Use get_matches to find a valid fixture id.",
  );

  let payload: unknown;
  try {
    payload = await apiRequest(`/fixtures/${fixtureId}`, params);
  } catch (error) {
    // Match assertFixtureExists: the generic 404 mapping recommends the
    // 'search' tool, which cannot find fixture ids.
    if (error instanceof SportmonksToolError && error.kind === "not_found") {
      throw notFound;
    }
    throw error;
  }

  const fixture = getResponseItems(payload)[0] ?? null;
  const lineups = toRecordArray(readPath(fixture, ["lineups"]));

  const buildMeta = (returned: number, possiblyMore: boolean) => {
    const meta = buildListMeta(returned, MAX_LINEUP_STATS_ROWS, possiblyMore);
    meta.stat_types = appliedStatTypes;
    return meta;
  };

  if (fixture === null || getNumber(fixture, ["id"]) === null) {
    throw notFound;
  }

  if (lineups.length === 0) {
    // The fixture exists but carries no lineup data (not announced yet, or
    // not covered for this league/tier).
    return { data: [], meta: buildMeta(0, false) };
  }

  const teamNameById = new Map(
    toRecordArray(readPath(fixture, ["participants"]))
      .map((participant) => [getNumber(participant, ["id"]), getPreferredName(participant)] as const)
      .filter(([id]) => id !== null),
  );

  const playerIdFilter = playerIds === undefined ? null : new Set(playerIds);
  const rows = lineups
    .filter(
      (lineup) =>
        playerIdFilter === null || playerIdFilter.has(getNumber(lineup, ["player_id"]) ?? -1),
    )
    .map((lineup) => {
      const stats: Record<string, unknown> = {};
      for (const detail of toRecordArray(readPath(lineup, ["details"]))) {
        const label = getTypeLookupLabel(getNumber(detail, ["type_id"]));
        if (label === null) {
          continue;
        }

        const key = toSnakeCaseKey(label);
        if (!appliedStatTypes.includes(key)) {
          continue;
        }

        stats[key] = getStatisticValue(detail);
      }

      const teamId = getNumber(lineup, ["team_id"]);
      return {
        player_id: getNumber(lineup, ["player_id"]),
        player_name: getString(lineup, ["player_name"])?.trim() ?? null,
        team_id: teamId,
        team_name: teamNameById.get(teamId) ?? null,
        // lineup = starting XI, bench = substitute. Under the default filter
        // (which includes minutes_played) a bench player with an empty stats
        // object did not come on; with a narrower override, empty may just
        // mean none of the requested stats were recorded.
        type: getLineupType(lineup),
        stats,
      };
    })
    .filter((row) => row.player_id !== null);

  const data = rows.slice(0, MAX_LINEUP_STATS_ROWS);
  return { data, meta: buildMeta(data.length, rows.length > data.length) };
}

async function getFixtureLineupStats(
  fixtureId: number,
  playerIds?: number[],
  statTypes?: string[],
) {
  const { data, meta } = await fetchFixtureLineupStats(fixtureId, playerIds, statTypes);
  return jsonResponse(listResponse(data, meta));
}

interface PressureMeta {
  returned: number;
  cap: number;
  possibly_more: boolean;
  mode: PressureMode;
}

interface PressureTeam {
  team_id: number | null;
  team_name: string | null;
}

// One grouped minute: each team's pressure value (absent rows treated as 0,
// since pressure is a relativity metric where "no row" means "not pressing").
interface PressureMinute {
  minute: number;
  home: number;
  away: number;
}

function groupPressureByMinute(
  rows: JsonRecord[],
  homeId: number | null,
  awayId: number | null,
): PressureMinute[] {
  const byMinute = new Map<number, { home: number; away: number }>();
  for (const row of rows) {
    const minute = getNumber(row, ["minute"]);
    const participantId = getNumber(row, ["participant_id"]);
    const value = getNumber(row, ["pressure"]);
    if (minute === null || participantId === null) {
      continue;
    }

    const entry = byMinute.get(minute) ?? { home: 0, away: 0 };
    // Rows arrive unordered and not always paired per minute, so accumulate
    // into whichever side this participant is.
    if (participantId === homeId) {
      entry.home = value ?? 0;
    } else if (participantId === awayId) {
      entry.away = value ?? 0;
    }
    byMinute.set(minute, entry);
  }

  return [...byMinute.entries()]
    .map(([minute, v]) => ({ minute, home: v.home, away: v.away }))
    .sort((left, right) => left.minute - right.minute);
}

function buildPressureSummary(
  minutes: PressureMinute[],
  home: PressureTeam,
  away: PressureTeam,
) {
  const peak = { home: 0, away: 0 };
  const sum = { home: 0, away: 0 };
  const led = { home: 0, away: 0 };

  for (const m of minutes) {
    peak.home = Math.max(peak.home, m.home);
    peak.away = Math.max(peak.away, m.away);
    sum.home += m.home;
    sum.away += m.away;
    if (m.home > m.away) led.home += 1;
    else if (m.away > m.home) led.away += 1;
    // equal (e.g. both 0) counts toward neither team's dominance share.
  }

  const total = minutes.length;
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const share = (count: number) => (total === 0 ? 0 : round2((count / total) * 100));

  // A swing = the leading team changes from the previous led minute. Rank by
  // how decisively the new leader took over (their pressure), keep the top few,
  // then present chronologically.
  const swings: Array<{ minute: number; team_id: number | null; team_name: string | null; pressure: number }> = [];
  let lastLeader: "home" | "away" | null = null;
  for (const m of minutes) {
    const leader: "home" | "away" | null =
      m.home > m.away ? "home" : m.away > m.home ? "away" : null;
    if (leader !== null && lastLeader !== null && leader !== lastLeader) {
      const team = leader === "home" ? home : away;
      swings.push({
        minute: m.minute,
        team_id: team.team_id,
        team_name: team.team_name,
        pressure: leader === "home" ? m.home : m.away,
      });
    }
    if (leader !== null) {
      lastLeader = leader;
    }
  }

  const topSwings = [...swings]
    .sort((left, right) => right.pressure - left.pressure)
    .slice(0, MAX_PRESSURE_SWINGS)
    .sort((left, right) => left.minute - right.minute);

  return {
    teams: [
      {
        team_id: home.team_id,
        team_name: home.team_name,
        peak_pressure: round2(peak.home),
        average_pressure: total === 0 ? 0 : round2(sum.home / total),
        dominance_share: share(led.home),
      },
      {
        team_id: away.team_id,
        team_name: away.team_name,
        peak_pressure: round2(peak.away),
        average_pressure: total === 0 ? 0 : round2(sum.away / total),
        dominance_share: share(led.away),
      },
    ],
    swings: topSwings,
  };
}

async function fetchPressureIndex(fixtureId: number, mode: PressureMode) {
  const notFound = new SportmonksToolError(
    "not_found",
    `Fixture ${fixtureId} was not found in Sportmonks.`,
    "Verify the fixture id is correct and available in your Sportmonks subscription. Use get_matches to find a valid fixture id.",
  );

  let payload: unknown;
  try {
    payload = await apiRequest(`/fixtures/${fixtureId}`, {
      include: "pressure;participants",
    });
  } catch (error) {
    if (error instanceof SportmonksToolError && error.kind === "not_found") {
      throw notFound;
    }
    throw error;
  }

  const fixture = getResponseItems(payload)[0] ?? null;
  if (fixture === null || getNumber(fixture, ["id"]) === null) {
    throw notFound;
  }

  const { home, away } = getHomeAndAwayParticipants(fixture);
  const homeTeam: PressureTeam = { team_id: getNumber(home, ["id"]), team_name: getPreferredName(home) };
  const awayTeam: PressureTeam = { team_id: getNumber(away, ["id"]), team_name: getPreferredName(away) };

  const rows = toRecordArray(readPath(fixture, ["pressure"]));
  const minutes = groupPressureByMinute(rows, homeTeam.team_id, awayTeam.team_id);

  if (mode === "timeline") {
    const data = minutes.slice(0, MAX_PRESSURE_TIMELINE_ROWS).map((m) => ({
      minute: m.minute,
      home: m.home,
      away: m.away,
    }));
    const meta: PressureMeta = {
      returned: data.length,
      cap: MAX_PRESSURE_TIMELINE_ROWS,
      possibly_more: minutes.length > MAX_PRESSURE_TIMELINE_ROWS,
      mode,
    };
    // teams[0] is home (the `home` key in each entry), teams[1] is away — so
    // consumers resolve the positional values to names without per-entry repeats.
    return { data: { teams: [homeTeam, awayTeam], timeline: data }, meta };
  }

  const summary = buildPressureSummary(minutes, homeTeam, awayTeam);
  const meta: PressureMeta = {
    returned: minutes.length,
    cap: MAX_PRESSURE_TIMELINE_ROWS,
    // Summary aggregates the whole recorded series, so nothing is truncated.
    possibly_more: false,
    mode,
  };
  return { data: summary, meta };
}

async function getPressureIndex(fixtureId: number, mode: PressureMode) {
  const { data, meta } = await fetchPressureIndex(fixtureId, mode);
  return jsonResponse({ data, meta });
}

function mapTransfer(record: unknown, type: TransferType) {
  // Confirmed transfers and rumours share these fields; the rumour-only extras
  // (probability, source, currency) are dropped to keep one uniform shape.
  // `transfer_kind` resolves type_id (e.g. Transfer, Loan, End of loan, Free);
  // `type` echoes which feed the row came from.
  const player = readPath(record, ["player"]);
  const fromTeam = readPath(record, ["fromteam"]);
  const toTeam = readPath(record, ["toteam"]);

  return {
    id: getNumber(record, ["id"]),
    player: {
      id: getNumber(player, ["id"]) ?? getNumber(record, ["player_id"]),
      name: getPreferredName(player),
    },
    from_team: {
      id: getNumber(fromTeam, ["id"]) ?? getNumber(record, ["from_team_id"]),
      name: getPreferredName(fromTeam),
    },
    to_team: {
      id: getNumber(toTeam, ["id"]) ?? getNumber(record, ["to_team_id"]),
      name: getPreferredName(toTeam),
    },
    type,
    transfer_kind: getTypeLookupLabel(getNumber(record, ["type_id"])),
    // Undisclosed fees come back null; keep them null rather than coercing to 0.
    fee: getNumber(record, ["amount"]),
    date: getString(record, ["date"]),
  };
}

function resolveTransferEndpoint(
  type: TransferType,
  timeframe: TransferTimeframe,
  entityType: TransferEntityType | undefined,
  id: number | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
) {
  const base = type === "rumour" ? "/transfer-rumours" : "/transfers";

  if (id !== undefined) {
    return entityType === "team" ? `${base}/teams/${id}` : `${base}/players/${id}`;
  }

  if (timeframe === "date_range") {
    return `${base}/between/${startDate}/${endDate}`;
  }

  // Latest market activity. Confirmed transfers have a dedicated /latest
  // endpoint; rumours don't, so fall back to the (cap-bounded) full feed.
  return type === "rumour" ? base : `${base}/latest`;
}

async function fetchTransfers(params: {
  id?: number;
  entityType?: TransferEntityType;
  type: TransferType;
  timeframe: TransferTimeframe;
  startDate?: string;
  endDate?: string;
}) {
  const endpoint = resolveTransferEndpoint(
    params.type,
    params.timeframe,
    params.entityType,
    params.id,
    params.startDate,
    params.endDate,
  );

  let payload: unknown;
  try {
    payload = await apiRequest(endpoint, {
      include: "player;fromteam;toteam",
      per_page: MAX_TRANSFER_RESULTS,
    });
  } catch (error) {
    // Rumours are a separate add-on; surface a clear, actionable error rather
    // than the generic auth message when the subscription lacks them.
    if (
      params.type === "rumour" &&
      error instanceof SportmonksToolError &&
      error.kind === "authentication_error"
    ) {
      throw new SportmonksToolError(
        "authentication_error",
        "Sportmonks rejected the transfer rumours request. Rumours require a subscription with the transfer rumours add-on.",
        "Retry with type='confirmed' for confirmed transfers, or upgrade the Sportmonks subscription to include transfer rumours.",
        error.details,
      );
    }
    throw error;
  }

  const upstreamHasMore = getBoolean(payload, ["pagination", "has_more"]);
  const items = getResponseItems(payload);
  const data = items
    .slice(0, MAX_TRANSFER_RESULTS)
    .map((record) => mapTransfer(record, params.type))
    .filter((row) => row.id !== null);
  const truncatedHere = items.length > data.length;
  return {
    data,
    meta: buildListMeta(data.length, MAX_TRANSFER_RESULTS, upstreamHasMore === true || truncatedHere),
  };
}

async function getTransfers(params: {
  id?: number;
  entityType?: TransferEntityType;
  type: TransferType;
  timeframe: TransferTimeframe;
  startDate?: string;
  endDate?: string;
}) {
  const { data, meta } = await fetchTransfers(params);
  return jsonResponse(listResponse(data, meta));
}

async function getEntityReference(id: number, type: EntityType) {
  // Sportmonks doesn't reliably 404 on unknown ids — depending on plan it can
  // return 200 with `data: []`, `data: {}`, or `data: {/* placeholder with no id */}`.
  // We verify the result actually contains an entity with a numeric `id`;
  // anything else surfaces as `not_found` with a clear how-to-fix message.
  const path =
    type === "team"
      ? `/teams/${id}`
      : type === "player"
        ? `/players/${id}`
        : type === "coach"
          ? `/coaches/${id}`
          : `/leagues/${id}`;
  const label =
    type === "team" ? "Team" : type === "player" ? "Player" : type === "coach" ? "Coach" : "League";
  const payload = await apiRequest(path);
  const item = getSingleResponseItem(payload, label);
  if (getNumber(item, ["id"]) === null) {
    throw new SportmonksToolError(
      "not_found",
      `${label} ${id} was not found in Sportmonks.`,
      `Verify the id is correct and available in your Sportmonks subscription. Use the 'search' tool to find a valid id.`,
    );
  }
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

const tools: ToolDefinition[] = [
  {
    name: "search",
    description: "Search Sportmonks players, teams, leagues, coaches, or all supported entity types.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text to look up in Sportmonks.",
        },
        type: {
          type: "string",
          enum: ["player", "team", "league", "coach", "all"],
          description: "Entity type to search. Defaults to 'all'.",
        },
      },
      required: ["query"],
    },
    async handler(args) {
      await initializeReferenceData();
      const query = requireNonEmptyString(args.query, "query");
      const type = requireEnumValue(
        args.type,
        "type",
        ["player", "team", "league", "coach", "all"],
        "all",
      );
      return searchEntities(query, type);
    },
  },
  {
    name: "get_player",
    description: "Gets player details by Sportmonks player id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks player id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      return getPlayer(id);
    },
  },
  {
    name: "get_team",
    description: "Gets team details by Sportmonks team id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks team id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      return getTeam(id);
    },
  },
  {
    name: "get_league",
    description: "Gets league details by Sportmonks league id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks league id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      return getLeague(id);
    },
  },
  {
    name: "get_coach",
    description: "Gets coach details by Sportmonks coach id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks coach id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      return getCoach(id);
    },
  },
  {
    name: "get_squad",
    description: "Gets the squad for a team, optionally for a specific historic season.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: {
          type: "integer",
          description: "Sportmonks team id.",
        },
        season_id: {
          type: "integer",
          description: "Sportmonks season id. Omit for the current squad.",
        },
      },
      required: ["team_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const teamId = requirePositiveInteger(args.team_id, "team_id");
      const seasonId = requireOptionalPositiveInteger(args.season_id, "season_id");
      return getSquad(teamId, seasonId);
    },
  },
  {
    name: "get_matches",
    description: "Get upcoming, live, or historic matches for a team id or league id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks team id or league id.",
        },
        type: {
          type: "string",
          enum: ["team", "league"],
          description: "Whether the id refers to a team or a league.",
        },
        timeframe: {
          type: "string",
          enum: ["live", "historic", "upcoming"],
          description: "Timeframe to fetch. Defaults to 'upcoming'.",
        },
      },
      required: ["id", "type"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      const type = requireEnumValue(args.type, "type", ["team", "league"]);
      const timeframe = requireEnumValue(
        args.timeframe,
        "timeframe",
        ["live", "historic", "upcoming"],
        "upcoming",
      );
      return getMatches(id, type, timeframe);
    },
  },
  {
    name: "get_match_preview",
    description: "Get a fixture preview plus the last five head-to-head matches.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks fixture id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      return getMatchPreview(id);
    },
  },
  {
    name: "get_fixture_details",
    description:
      "Gets detailed fixture data with optional whitelisted expansions for lineups, events, statistics, predictions, and xg. Predictions return curated match probabilities (percentages, 0-100) and value bets, and require a Sportmonks subscription with the predictions add-on. The xg include returns Expected Goals (xG) and Expected Goals on Target (xGoT) per team for finished and live fixtures; it is an empty array for upcoming fixtures or fixtures without xG coverage.",
    inputSchema: {
      type: "object",
      properties: {
        fixture_id: {
          type: "integer",
          description: "Sportmonks fixture id.",
        },
        includes: {
          type: "array",
          items: {
            type: "string",
            enum: ["lineups", "events", "statistics", "predictions", "xg"],
          },
          description:
            "Optional subset of ['lineups', 'events', 'statistics', 'predictions', 'xg'] to expand on top of the base fixture data.",
        },
      },
      required: ["fixture_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const fixtureId = requirePositiveInteger(args.fixture_id, "fixture_id");
      const includes = requireEnumArray(
        args.includes,
        "includes",
        ["lineups", "events", "statistics", "predictions", "xg"],
      );
      return getFixtureDetails(fixtureId, includes);
    },
  },
  {
    name: "get_standings",
    description:
      "Get the standings table for a Sportmonks league id. Tries the live endpoint first; if no live standings are returned, falls back to season-based standings using the league's current season.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks league id.",
        },
      },
      required: ["id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const leagueId = requirePositiveInteger(args.id, "id");
      return getStandings(leagueId);
    },
  },
  {
    name: "get_historic_seasons",
    description:
      "Gets all historic and current seasons for a league, sorted with the most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: {
          type: "integer",
          description: "Sportmonks league id.",
        },
      },
      required: ["league_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const leagueId = requirePositiveInteger(args.league_id, "league_id");
      return getHistoricSeasons(leagueId);
    },
  },
  {
    name: "get_topscorers",
    description: "Gets the top scorers, assisters, or card recipients for a season.",
    inputSchema: {
      type: "object",
      properties: {
        season_id: {
          type: "integer",
          description: "Sportmonks season id.",
        },
        type: {
          type: "string",
          enum: ["goals", "assists", "cards"],
          description: "Topscorer type to fetch.",
        },
        limit: {
          type: "integer",
          description: "Optional result limit. Defaults to 10 and cannot exceed 25.",
        },
      },
      required: ["season_id", "type"],
    },
    async handler(args) {
      await initializeReferenceData();
      const seasonId = requirePositiveInteger(args.season_id, "season_id");
      const type = requireEnumValue(args.type, "type", ["goals", "assists", "cards"]);
      const limit = requirePositiveIntegerWithMaximum(args.limit, "limit", 10, 25);
      return getTopscorers(seasonId, type, limit);
    },
  },
  {
    name: "get_odds",
    description:
      "Gets pre-match or premium betting odds for a fixture. An unfiltered fixture can carry thousands of odds entries upstream, so results are capped at 'limit' (default 50, max 200; sorted by market, then bookmaker); narrow with market_id and/or bookmaker_id or raise the limit when meta.possibly_more is true. An empty data array means the fixture exists but has no odds for the requested feed type and filters.",
    inputSchema: {
      type: "object",
      properties: {
        fixture_id: {
          type: "integer",
          description: "Sportmonks fixture id.",
        },
        type: {
          type: "string",
          enum: ["prematch", "premium"],
          description:
            "Odds feed to query. Defaults to 'prematch'. 'premium' requires a subscription that includes the premium odds feed.",
        },
        market_id: {
          type: "integer",
          description: "Optional Sportmonks market id to filter to a single market (e.g. 1 for Fulltime Result).",
        },
        bookmaker_id: {
          type: "integer",
          description: "Optional Sportmonks bookmaker id to filter to a single bookmaker.",
        },
        limit: {
          type: "integer",
          description: "Optional result limit. Defaults to 50 and cannot exceed 200.",
        },
      },
      required: ["fixture_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const fixtureId = requirePositiveInteger(args.fixture_id, "fixture_id");
      const type = requireEnumValue(args.type, "type", ["prematch", "premium"], "prematch");
      const marketId = requireOptionalPositiveInteger(args.market_id, "market_id");
      const bookmakerId = requireOptionalPositiveInteger(args.bookmaker_id, "bookmaker_id");
      const limit = requirePositiveIntegerWithMaximum(
        args.limit,
        "limit",
        DEFAULT_ODDS_RESULTS,
        MAX_ODDS_RESULTS,
      );
      return getOdds(fixtureId, type, limit, marketId, bookmakerId);
    },
  },
  {
    name: "get_season_stats",
    description:
      "Gets seasonal statistics for a player or team. A curated default stat filter is applied per entity type (player: goals, assists, minutes_played, appearances, shots_on_target, passes, key_passes, tackles, rating; team: goals, goals_conceded, team_wins, team_draws, team_lost, cleansheets, shots, pass_stats, ball_possession). Override with stat_types using snake_case stat names. A stat missing from the stats object means it is not tracked for the entity's league or data tier, or its value is zero — Sportmonks omits zero-value stats. An empty data array means the entity exists but has no statistics for that season — verify season ids with get_historic_seasons.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "integer",
          description: "Sportmonks player id or team id.",
        },
        entity_type: {
          type: "string",
          enum: ["player", "team"],
          description: "Whether entity_id refers to a player or a team.",
        },
        season_id: {
          type: "integer",
          description: "Sportmonks season id. Use get_historic_seasons to find one.",
        },
        stat_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional stat names to return instead of the per-entity-type defaults, e.g. ['goals', 'big_chances_created']. Names are snake_case of the Sportmonks type name.",
        },
      },
      required: ["entity_id", "entity_type", "season_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const entityId = requirePositiveInteger(args.entity_id, "entity_id");
      const entityType = requireEnumValue(args.entity_type, "entity_type", ["player", "team"]);
      const seasonId = requirePositiveInteger(args.season_id, "season_id");
      const statTypes = requireOptionalStatTypes(args.stat_types, "stat_types");
      return getSeasonStats(entityId, entityType, seasonId, statTypes);
    },
  },
  {
    name: "get_fixture_lineup_stats",
    description:
      "Gets player-level statistics for a fixture (both squads including bench). Defaults to goals, assists, and minutes_played per player; override with stat_types using snake_case stat names (e.g. ['rating', 'passes']). Sportmonks omits zero-value stats, so a stat missing from a player's stats object means not-tracked or zero; under the default filter (which includes minutes_played) a bench player with an empty stats object did not come on. An empty data array means the fixture exists but has no lineup data (not announced yet, or not covered for the league) — or, when player_ids is set, that none of the requested players are in the lineups.",
    inputSchema: {
      type: "object",
      properties: {
        fixture_id: {
          type: "integer",
          description: "Sportmonks fixture id.",
        },
        player_ids: {
          type: "array",
          items: { type: "integer" },
          description: "Optional Sportmonks player ids to filter to specific players.",
        },
        stat_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional stat names to return instead of the defaults (goals, assists, minutes_played). Names are snake_case of the Sportmonks type name.",
        },
      },
      required: ["fixture_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const fixtureId = requirePositiveInteger(args.fixture_id, "fixture_id");
      const playerIds = requireOptionalPositiveIntegerArray(args.player_ids, "player_ids");
      const statTypes = requireOptionalStatTypes(args.stat_types, "stat_types");
      return getFixtureLineupStats(fixtureId, playerIds, statTypes);
    },
  },
  {
    name: "get_pressure_index",
    description:
      "Gets the Sportmonks Pressure Index for a fixture — a real-time, per-minute metric of which team is dominating. mode='summary' (default) returns per-team peak/average pressure, dominance share (% of recorded minutes each team led), and the top momentum-swing minutes. mode='timeline' returns the cleaned per-minute series (one entry per minute with both teams' values, sorted by minute). Teams are resolved to names. Works for live (partial series) and finished fixtures; returns an empty series for upcoming fixtures or fixtures without pressure data.",
    inputSchema: {
      type: "object",
      properties: {
        fixture_id: {
          type: "integer",
          description: "Sportmonks fixture id.",
        },
        mode: {
          type: "string",
          enum: ["summary", "timeline"],
          description:
            "'summary' (default) for per-team aggregates and swing minutes; 'timeline' for the full per-minute series.",
        },
      },
      required: ["fixture_id"],
    },
    async handler(args) {
      await initializeReferenceData();
      const fixtureId = requirePositiveInteger(args.fixture_id, "fixture_id");
      const mode = requireEnumValue(args.mode, "mode", ["summary", "timeline"], "summary");
      return getPressureIndex(fixtureId, mode);
    },
  },
  {
    name: "get_transfers",
    description:
      "Gets football transfers: latest market activity, transfers for a team or player, or transfers within a date range. type='confirmed' (default) or type='rumour' (rumours need a subscription add-on). Provide id with entity_type to scope to a team/player (always the latest feed — a date range cannot be combined with an id). For an unscoped query you must set timeframe explicitly: timeframe='latest' for recent market activity, or timeframe='date_range' with start_date and end_date (window must not exceed 31 days — the Sportmonks limit). Results are capped at 25; fee is null for undisclosed deals.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Optional Sportmonks team id or player id to scope the transfers to.",
        },
        entity_type: {
          type: "string",
          enum: ["team", "player"],
          description: "Whether id refers to a team or a player. Required when id is provided.",
        },
        type: {
          type: "string",
          enum: ["confirmed", "rumour"],
          description: "Confirmed transfers (default) or transfer rumours (rumours require an add-on).",
        },
        timeframe: {
          type: "string",
          enum: ["latest", "date_range"],
          description:
            "'latest' for recent market activity, or 'date_range' with start_date/end_date. Defaults to 'latest' when an id is provided; required for unscoped (no id) queries.",
        },
        start_date: {
          type: "string",
          description: "Start of the date range (YYYY-MM-DD). Required when timeframe='date_range'.",
        },
        end_date: {
          type: "string",
          description: "End of the date range (YYYY-MM-DD). Required when timeframe='date_range'; must be within 31 days of start_date (Sportmonks limit).",
        },
      },
      required: [],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requireOptionalPositiveInteger(args.id, "id");
      const type = requireEnumValue(args.type, "type", ["confirmed", "rumour"], "confirmed");

      if (id !== undefined && args.entity_type === undefined) {
        throw new SportmonksToolError(
          "validation_error",
          "The 'entity_type' field is required when 'id' is provided.",
          "Call the tool again with entity_type set to 'team' or 'player', or omit id to query latest/date-range transfers.",
        );
      }

      const entityType =
        id === undefined
          ? undefined
          : requireEnumValue(args.entity_type, "entity_type", ["team", "player"]);

      // An unscoped call (no id) must name its timeframe — this is the guard
      // against unbounded queries. A scoped call (id present) defaults to latest.
      if (id === undefined && args.timeframe === undefined) {
        throw new SportmonksToolError(
          "validation_error",
          "Provide either an id (with entity_type) or a timeframe.",
          "Call the tool again with an id and entity_type, or set timeframe to 'latest' or 'date_range' (date_range also needs start_date and end_date).",
        );
      }

      const timeframe = requireEnumValue(
        args.timeframe,
        "timeframe",
        ["latest", "date_range"],
        "latest",
      );

      // Sportmonks has no date-scoped team/player transfer endpoint, so an
      // id + date_range combination cannot be honored. Reject it rather than
      // silently dropping the date window and returning the full scoped feed.
      if (id !== undefined && timeframe === "date_range") {
        throw new SportmonksToolError(
          "validation_error",
          "A date range cannot be combined with an id — Sportmonks has no date-scoped team or player transfer endpoint.",
          "Call the tool again with the id (entity_type) and timeframe='latest', or omit the id and use timeframe='date_range' with start_date and end_date.",
        );
      }

      let startDate: string | undefined;
      let endDate: string | undefined;
      if (timeframe === "date_range") {
        startDate = requireDateString(args.start_date, "start_date");
        endDate = requireDateString(args.end_date, "end_date");

        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        if (end.getTime() < start.getTime()) {
          throw new SportmonksToolError(
            "validation_error",
            "The 'end_date' must be on or after 'start_date'.",
            "Call the tool again with end_date on or after start_date.",
          );
        }

        const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
        if (diffDays > MAX_TRANSFER_RANGE_DAYS) {
          throw new SportmonksToolError(
            "validation_error",
            `The date range must not exceed ${MAX_TRANSFER_RANGE_DAYS} days (Sportmonks limits transfer date ranges to ${MAX_TRANSFER_RANGE_DAYS} days).`,
            `Call the tool again with start_date and end_date no more than ${MAX_TRANSFER_RANGE_DAYS} days apart.`,
          );
        }
      }

      return getTransfers({ id, entityType, type, timeframe, startDate, endDate });
    },
  },
];

// ── Resources ────────────────────────────────────────────────────────────────

const resources: ResourceDefinition[] = [
  {
    uri: "sportmonks://documentation",
    name: "Sportmonks Football MCP Overview",
    description: "Overview of the Sportmonks football MCP server.",
    mimeType: "text/plain",
  },
  {
    uri: "sportmonks://openapi",
    name: "Sportmonks Football API OpenAPI Spec",
    description:
      "OpenAPI specification for the Sportmonks Football API 3.0. Fetched on read.",
    mimeType: "application/json",
  },
];

async function fetchOpenApiSpec() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    logUpstreamUrl(new URL(OPENAPI_SPEC_URL));
    const response = await fetch(OPENAPI_SPEC_URL, { signal: controller.signal });

    if (!response.ok) {
      throw new SportmonksToolError(
        "upstream_error",
        `Failed to fetch OpenAPI spec. HTTP ${response.status}.`,
        "Retry later. If the error persists, the OpenAPI spec host may be unavailable.",
      );
    }

    return JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    if (error instanceof SportmonksToolError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new SportmonksToolError(
        "upstream_error",
        `OpenAPI spec host did not respond within ${API_TIMEOUT_MS / 1000} seconds.`,
        "Retry later. If the timeout keeps happening, the OpenAPI spec host may be unavailable.",
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResource(uri: string) {
  switch (uri) {
    case "sportmonks://documentation":
      return {
        contents: [{ uri, mimeType: "text/plain", text: DOCUMENTATION_RESOURCE_TEXT }],
      };
    case "sportmonks://openapi": {
      const text = await fetchOpenApiSpec();
      return {
        contents: [{ uri, mimeType: "application/json", text }],
      };
    }
    default:
      throw new SportmonksToolError(
        "not_found",
        `Unknown resource: ${uri}`,
        "Use 'sportmonks://documentation' or 'sportmonks://openapi', or list resources again.",
      );
  }
}

// ── Prompts ─────────────────────────────────────────────────────────────────

interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
  handler(args: Record<string, string>): Promise<{
    description: string;
    messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }>;
  }>;
}

function findStandingRow(
  standings: ReturnType<typeof mapStanding>[],
  teamId: number | null,
) {
  if (teamId === null) return null;
  return standings.find((row) => row.team.id === teamId) ?? null;
}

function formatStandingRow(row: ReturnType<typeof mapStanding>) {
  return `${row.position}. ${row.team.name} — ${row.played}P ${row.won}W ${row.drawn}D ${row.lost}L GD:${row.gd} Pts:${row.points}`;
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "Unknown";
  }

  return String(value);
}

const prompts: PromptDefinition[] = [
  {
    name: "match_preview",
    description:
      "Match briefing for an upcoming fixture: fixture info and the last five head-to-head results.",
    arguments: [
      {
        name: "fixture_id",
        description: "Sportmonks fixture id for an upcoming match.",
        required: true,
      },
    ],
    async handler(args) {
      const fixtureId = requirePositiveInteger(args.fixture_id, "fixture_id");

      const preview = await fetchMatchPreview(fixtureId);

      const lines: string[] = [
        "Use the Sportmonks data below to write a concise pre-match briefing. Do not invent facts that are not present.",
        "",
        `Match: ${preview.home_team} vs ${preview.away_team}`,
        `Kick-off: ${preview.starting_at}`,
        `Fixture ID: ${preview.id}`,
      ];

      if (preview.last_5_h2h_matches.length > 0) {
        lines.push("", "Head-to-Head (last 5):");
        for (const match of preview.last_5_h2h_matches) {
          lines.push(
            `  ${match.date}: ${match.home_team} ${match.home_score}-${match.away_score} ${match.away_team}${match.result_info ? ` (${match.result_info})` : ""}`,
          );
        }
      } else {
        lines.push("", "Head-to-Head (last 5): No previous H2H matches returned by Sportmonks.");
      }

      return {
        description: `Match preview: ${preview.home_team} vs ${preview.away_team}`,
        messages: [
          {
            role: "user",
            content: { type: "text", text: lines.join("\n") },
          },
        ],
      };
    },
  },
  {
    name: "team_overview",
    description:
      "Team briefing: entity details, upcoming fixtures, and current league standing.",
    arguments: [
      {
        name: "team_id",
        description: "Sportmonks team id.",
        required: true,
      },
    ],
    async handler(args) {
      const teamId = requirePositiveInteger(args.team_id, "team_id");

      const entity = await fetchEntity(teamId, "team");
      const { data: matches } = await fetchMatches(teamId, "team", "upcoming");

      const lines: string[] = [
        "Use the Sportmonks data below to write a concise team overview. Do not invent facts that are not present.",
        "",
        `Team: ${formatValue(entity.name)}`,
        `Country: ${formatValue(entity.country)}`,
        `Venue: ${formatValue(entity.venue)}`,
      ];

      if (matches.length > 0) {
        lines.push("", `Upcoming Matches (next ${UPCOMING_WINDOW_DAYS} days):`);
        for (const match of matches) {
          lines.push(
            `  ${match.starting_at}: ${match.home_team} vs ${match.away_team} — ${match.league?.name ?? "Unknown league"}`,
          );
        }

        const firstLeagueId = matches[0].league?.id;
        if (typeof firstLeagueId === "number") {
          try {
            const { data: standings } = await fetchStandings(firstLeagueId);
            const row = findStandingRow(standings, teamId);
            if (row) {
              lines.push("", `League Standing (${matches[0].league?.name}):`, `  ${formatStandingRow(row)}`);
            }
          } catch {
            // standings unavailable — skip silently
          }
        }
      } else {
        lines.push("", `Upcoming Matches (next ${UPCOMING_WINDOW_DAYS} days): No upcoming matches returned by Sportmonks.`);
      }

      if (!lines.some((line) => line.startsWith("League Standing"))) {
        lines.push("", "League Standing: Not available from the returned Sportmonks data.");
      }

      return {
        description: `Team overview: ${entity.name}`,
        messages: [
          {
            role: "user",
            content: { type: "text", text: lines.join("\n") },
          },
        ],
      };
    },
  },
  {
    name: "league_overview",
    description:
      "League briefing: league details, full standings table, and upcoming fixtures.",
    arguments: [
      {
        name: "league_id",
        description: "Sportmonks league id.",
        required: true,
      },
    ],
    async handler(args) {
      const leagueId = requirePositiveInteger(args.league_id, "league_id");

      const [entity, standingsEnvelope, matchesEnvelope] = await Promise.all([
        fetchEntity(leagueId, "league"),
        fetchStandings(leagueId),
        fetchMatches(leagueId, "league", "upcoming"),
      ]);
      const standings = standingsEnvelope.data;
      const matches = matchesEnvelope.data;

      const lines: string[] = [
        "Use the Sportmonks data below to write a concise league overview. Do not invent facts that are not present.",
        "",
        `League: ${formatValue(entity.name)}`,
        `Country: ${formatValue(entity.country)}`,
      ];

      if (standings.length > 0) {
        lines.push("", "Standings:");
        for (const row of standings) {
          lines.push(`  ${formatStandingRow(row)}`);
        }
      } else {
        lines.push("", "Standings: No standings available from Sportmonks for this league right now.");
      }

      if (matches.length > 0) {
        lines.push("", `Upcoming Matches (next ${UPCOMING_WINDOW_DAYS} days):`);
        for (const match of matches) {
          lines.push(
            `  ${match.starting_at}: ${match.home_team} vs ${match.away_team}`,
          );
        }
      } else {
        lines.push("", `Upcoming Matches (next ${UPCOMING_WINDOW_DAYS} days): No upcoming matches returned by Sportmonks.`);
      }

      return {
        description: `League overview: ${entity.name}`,
        messages: [
          {
            role: "user",
            content: { type: "text", text: lines.join("\n") },
          },
        ],
      };
    },
  },
];

const promptMap = new Map(prompts.map((prompt) => [prompt.name, prompt]));

async function getPrompt(name: string, args: Record<string, string>) {
  const prompt = promptMap.get(name);

  if (!prompt) {
    throw new SportmonksToolError(
      "not_found",
      `Unknown prompt: ${name}`,
      `Use one of: ${prompts.map((p) => p.name).join(", ")}. Call prompts/list to see all available prompts.`,
    );
  }

  await initializeReferenceData();
  return prompt.handler(args);
}

// ── Server Setup ─────────────────────────────────────────────────────────────

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

const server = new Server(
  { name: "sportmonks-football-mcp", version: SPORTMONKS_SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  const safeArgs = (args ?? {}) as Record<string, unknown>;
  const startedAt = performance.now();

  if (!tool) {
    recordToolCall({
      ts: new Date().toISOString(),
      tool: name,
      args: safeArgs,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: "error",
      error_kind: "tool_error",
    });
    return errorResponse(
      new SportmonksToolError(
        "tool_error",
        `Unknown tool: ${name}`,
        "Call list_tools to discover the available tools, then retry with one of those tool names.",
      ),
    );
  }

  try {
    const result = await tool.handler(safeArgs);
    recordToolCall({
      ts: new Date().toISOString(),
      tool: name,
      args: safeArgs,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: result.isError ? "error" : "ok",
    });
    return result;
  } catch (error) {
    const errorKind = error instanceof SportmonksToolError ? error.kind : "tool_error";
    recordToolCall({
      ts: new Date().toISOString(),
      tool: name,
      args: safeArgs,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: "error",
      error_kind: errorKind,
    });
    return errorResponse(error);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    return await readResource(request.params.uri);
  } catch (error) {
    if (error instanceof SportmonksToolError) {
      throw new Error(`${error.message} ${error.howToFix}`);
    }

    throw error;
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: prompts.map(({ name, description, arguments: args }) => ({
    name,
    description,
    arguments: args,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  try {
    return await getPrompt(request.params.name, request.params.arguments ?? {});
  } catch (error) {
    if (error instanceof SportmonksToolError) {
      throw new Error(`${error.message} ${error.howToFix}`);
    }

    throw error;
  }
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  if (!getApiToken()) {
    console.error("Error: SPORTMONKS_API_TOKEN environment variable is required");
    process.exit(1);
  }

  await initializeReferenceData();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sportmonks Football MCP Server running on stdio");
}

if (process.env.VITEST !== "true" && process.env.VITEST !== "1") {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

// ── Exports (for testing) ────────────────────────────────────────────────────

export {
  DEFAULT_LINEUP_STAT_TYPES,
  DEFAULT_ODDS_RESULTS,
  DEFAULT_PLAYER_STAT_TYPES,
  DEFAULT_TEAM_STAT_TYPES,
  DOCUMENTATION_RESOURCE_TEXT,
  FOOTBALL_API_BASE_URL,
  MAX_LINEUP_STATS_ROWS,
  MAX_MATCH_RESULTS,
  MAX_ODDS_RESULTS,
  MAX_PRESSURE_TIMELINE_ROWS,
  MAX_SEASON_STATS_ROWS,
  MAX_SEARCH_RESULTS,
  MAX_TRANSFER_RESULTS,
  apiRequest,
  errorResponse,
  getPrompt,
  initializeReferenceData,
  jsonResponse,
  primeReferenceData,
  promptMap,
  prompts,
  readResource,
  resources,
  textResponse,
  toolMap,
  tools,
};
