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
- get_squad(team_id, season_id?)
- get_matches(id, type, timeframe?)
- get_match_preview(id)
- get_fixture_details(fixture_id, includes?)
- get_standings(id)
- get_historic_seasons(league_id)
- get_topscorers(season_id, type, limit?)

Authentication
- Set SPORTMONKS_API_TOKEN before starting the server.
- Requests use the official api_token query parameter.

Behavior Notes
- All tool outputs are valid JSON.
- List-style tools (search, get_matches, get_topscorers, get_standings, get_squad) return an envelope
  '{ "data": [...], "meta": { "returned", "cap", "possibly_more", "date_window?" } }'.
  Use 'meta.possibly_more' to detect server-side or local truncation.
- Single-entity tools (get_player, get_team, get_league, get_match_preview, get_fixture_details,
  get_historic_seasons) return a JSON object or array directly, without an envelope.
- Validation errors explain what is wrong and how to fix the request.
- Search returns at most 10 results; meta.possibly_more flags when more matched upstream.
- All types and states are fetched on startup and used to build shared mappings.
- get_player uses the exact two-step player/team lookup flow to resolve the current team name.
- get_matches limits output to:
  - upcoming: 14 days ahead, max 20 fixtures
  - historic: 30 days back, max 20 fixtures
  - live: max 20 fixtures
- get_match_preview only works for fixtures that have not started yet.

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
const MAX_SEARCH_RESULTS = 10;
const MAX_MATCH_RESULTS = 20;
const UPCOMING_WINDOW_DAYS = 14;
const HISTORIC_WINDOW_DAYS = 30;
const API_TIMEOUT_MS = 20_000;

// ── Types ────────────────────────────────────────────────────────────────────

type ParamValue = string | number | boolean | undefined;
type SearchEntityType = "player" | "team" | "league" | "all";
type EntityType = "player" | "team" | "league";
type MatchEntityType = "team" | "league";
type MatchTimeframe = "live" | "historic" | "upcoming";
type FixtureDetailInclude = "lineups" | "events" | "statistics";
type TopscorerType = "goals" | "assists" | "cards";
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
  return {
    id: getNumber(record, ["id"]),
    entity_type: entityType,
    name: getPreferredName(record),
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

// ── Tool Implementations ─────────────────────────────────────────────────────

async function fetchSearchResults(query: string, type: SearchEntityType) {
  // Pull a wider page than we expose so we can detect upstream truncation via
  // pagination.has_more, then trim back to MAX_SEARCH_RESULTS.
  const upstreamPerPage = Math.max(MAX_SEARCH_RESULTS * 5, 50);
  const entityLoaders: Record<Exclude<SearchEntityType, "all">, () => Promise<unknown>> = {
    player: () => apiRequest(`/players/search/${encodeURIComponent(query)}`, { per_page: upstreamPerPage }),
    team: () => apiRequest(`/teams/search/${encodeURIComponent(query)}`, { per_page: upstreamPerPage }),
    league: () => apiRequest(`/leagues/search/${encodeURIComponent(query)}`, { per_page: upstreamPerPage }),
  };

  const entityTypes: Array<Exclude<SearchEntityType, "all">> =
    type === "all" ? ["player", "team", "league"] : [type];

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
      const teamPayload = await apiRequest(`/teams/${id}`, { include: "venue;country" });
      const team = getSingleResponseItem(teamPayload, "Team");

      return {
        id: getNumber(team, ["id"]),
        name: getPreferredName(team),
        country: getPreferredName(readPath(team, ["country"])),
        venue: getPreferredName(readPath(team, ["venue"])),
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
    return [entry];
  });
  const includeValue = ["participants", "scores", "league", "state", ...expandedIncludes].join(";");
  const payload = await apiRequest(`/fixtures/${fixtureId}`, {
    include: includeValue,
  });
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
        position_id: positionId,
        detailed_position:
          getPreferredName(detailedPosition) ??
          (detailedPositionId !== null ? getTypeLookupLabel(detailedPositionId) : null),
        detailed_position_id: detailedPositionId,
        // Formation fields are the match-specific position. formation_field is
        // a grid coord like "1:1" (line:line_position); formation_position is
        // 1-11 numeric placement. null for substitutes.
        formation_field: getString(lineup, ["formation_field"]),
        formation_position: getNumber(lineup, ["formation_position"]),
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

  return response;
}

async function getFixtureDetails(fixtureId: number, includes: FixtureDetailInclude[]) {
  return jsonResponse(await fetchFixtureDetails(fixtureId, includes));
}

function isUsableStandingRow(row: ReturnType<typeof mapStanding>): boolean {
  // The /standings/live endpoint returns a placeholder row of all-nulls when
  // no live standings exist (typical for cup competitions in knockout phases
  // or out-of-season leagues). Reject rows missing both a participant and a
  // numeric position so the caller gets `[]` rather than a misleading row.
  return row.team.id !== null || row.team.name !== null || row.position !== null;
}

const STANDINGS_PER_PAGE = 50;

async function fetchStandings(leagueId: number) {
  await getEntityReference(leagueId, "league");

  // Step 1: try live standings (works for in-progress league seasons). Pull a
  // wide page so cup competitions with 36+ rows (e.g. Champions League league
  // phase) come back complete without paging.
  const livePayload = await apiRequest(`/standings/live/leagues/${leagueId}`, {
    include: "participant;details",
    per_page: STANDINGS_PER_PAGE,
  });
  const liveRows = getResponseItems(livePayload).map(mapStanding).filter(isUsableStandingRow);
  if (liveRows.length > 0) {
    const upstreamHasMore = getBoolean(livePayload, ["pagination", "has_more"]);
    return {
      data: liveRows,
      meta: buildListMeta(liveRows.length, STANDINGS_PER_PAGE, upstreamHasMore),
    };
  }

  // Step 2: live empty (cup competition / between matches / off-season).
  // Fall back to season-based standings using the league's current season.
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

async function getEntityReference(id: number, type: MatchEntityType) {
  // Sportmonks doesn't reliably 404 on unknown ids — depending on plan it can
  // return 200 with `data: []`, `data: {}`, or `data: {/* placeholder with no id */}`.
  // We verify the result actually contains an entity with a numeric `id`;
  // anything else surfaces as `not_found` with a clear how-to-fix message.
  const path = type === "team" ? `/teams/${id}` : `/leagues/${id}`;
  const label = type === "team" ? "Team" : "League";
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
    description: "Search Sportmonks players, teams, leagues, or all supported entity types.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text to look up in Sportmonks.",
        },
        type: {
          type: "string",
          enum: ["player", "team", "league", "all"],
          description: "Entity type to search. Defaults to 'all'.",
        },
      },
      required: ["query"],
    },
    async handler(args) {
      await initializeReferenceData();
      const query = requireNonEmptyString(args.query, "query");
      const type = requireEnumValue(args.type, "type", ["player", "team", "league", "all"], "all");
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
      "Gets detailed fixture data with optional whitelisted expansions for lineups, events, and statistics.",
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
            enum: ["lineups", "events", "statistics"],
          },
          description:
            "Optional subset of ['lineups', 'events', 'statistics'] to expand on top of the base fixture data.",
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
        ["lineups", "events", "statistics"],
      );
      return getFixtureDetails(fixtureId, includes);
    },
  },
  {
    name: "get_standings",
    description:
      "Get the standings table for a Sportmonks league id. Tries the live endpoint first; if it returns nothing (cup competitions in knockout phases, between matchdays, or out-of-season leagues), falls back to season-based standings using the league's current season.",
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
  DOCUMENTATION_RESOURCE_TEXT,
  FOOTBALL_API_BASE_URL,
  MAX_MATCH_RESULTS,
  MAX_SEARCH_RESULTS,
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
