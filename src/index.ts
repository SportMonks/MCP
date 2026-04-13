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

// ── Constants ────────────────────────────────────────────────────────────────

const FOOTBALL_API_BASE_URL = "https://api.sportmonks.com/v3/football";
const CORE_API_BASE_URL = "https://api.sportmonks.com/v3/core";
const DOCUMENTATION_RESOURCE_TEXT = `
Sportmonks Football MCP Server

This server intentionally exposes only five high-signal tools:
- search(query, type?)
- get_entity(id, type)
- get_matches(id, type, timeframe?)
- get_match_preview(id)
- get_standings(id)

Authentication
- Set SPORTMONKS_API_TOKEN before starting the server.
- Requests use the official api_token query parameter.

Behavior Notes
- All tool outputs are valid JSON.
- List-style tools return JSON arrays of objects.
- Detail tools return JSON objects.
- Validation errors explain what is wrong and how to fix the request.
- Search returns at most 10 results.
- All types and states are fetched on startup and used to build shared mappings.
- get_entity(player) uses the exact two-step player/team lookup flow to resolve the current team name.
- get_matches limits output to:
  - upcoming: 14 days ahead, max 20 fixtures
  - historic: 30 days back, max 20 fixtures
  - live: max 20 fixtures
- get_match_preview only works for fixtures that have not started yet.

Official References
- Welcome: https://docs.sportmonks.com/football
- Authentication: https://docs.sportmonks.com/v3/welcome/authentication
- Endpoints: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints
- Filters: https://docs.sportmonks.com/v3/api/request-options/filtering
- Best practices: https://docs.sportmonks.com/v3/welcome/best-practices
`.trim();

const SPORTMONKS_SERVER_VERSION = "1.1.0";
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
  return (
    getString(record, ["display_name"]) ??
    getString(record, ["name"]) ??
    getString(record, ["common_name"]) ??
    getString(record, ["short_code"])
  );
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

// ── Response Helpers ─────────────────────────────────────────────────────────

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

function getTypeLookupById(typeId: number | null) {
  if (typeId === null) {
    return null;
  }

  return typeLookupById.get(typeId) ?? null;
}

function pickCurrentTeam(playerRecord: unknown) {
  const teams = toRecordArray(readPath(playerRecord, ["teams"]));
  if (teams.length === 0) {
    return null;
  }

  const domesticTeams = teams.filter((team) => getString(team, ["type"]) !== "national_team");
  const candidateTeams = domesticTeams.length > 0 ? domesticTeams : teams;

  const activeTeam =
    candidateTeams.find((team) => {
      const endValue =
        getString(team, ["meta", "end"]) ??
        getString(team, ["meta", "end_at"]) ??
        getString(team, ["end_at"]);
      return endValue === null;
    }) ?? null;

  if (activeTeam) {
    return activeTeam;
  }

  return [...candidateTeams].sort((left, right) => {
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
  })[0];
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
  const entityLoaders: Record<Exclude<SearchEntityType, "all">, () => Promise<unknown>> = {
    player: () => apiRequest(`/players/search/${encodeURIComponent(query)}`, { per_page: MAX_SEARCH_RESULTS }),
    team: () => apiRequest(`/teams/search/${encodeURIComponent(query)}`, { per_page: MAX_SEARCH_RESULTS }),
    league: () => apiRequest(`/leagues/search/${encodeURIComponent(query)}`, { per_page: MAX_SEARCH_RESULTS }),
  };

  const entityTypes: Array<Exclude<SearchEntityType, "all">> =
    type === "all" ? ["player", "team", "league"] : [type];

  const payloads = await Promise.all(entityTypes.map((entityType) => entityLoaders[entityType]()));

  return payloads
    .flatMap((payload, index) =>
      getResponseItems(payload).map((record) => mapSearchResult(record, entityTypes[index])),
    )
    .filter((result) => result.id !== null && result.name !== null)
    .sort((left, right) => {
      const leftName = left.name ?? "";
      const rightName = right.name ?? "";
      return leftName.localeCompare(rightName);
    })
    .slice(0, MAX_SEARCH_RESULTS);
}

async function searchEntities(query: string, type: SearchEntityType) {
  return jsonResponse(await fetchSearchResults(query, type));
}

async function fetchEntity(id: number, type: EntityType) {
  switch (type) {
    case "player": {
      const payload = await apiRequest(`/players/${id}`, {
        include: "position;nationality;teams",
      });
      const player = getSingleResponseItem(payload, "Player");
      const currentTeamReference = pickCurrentTeam(player);
      const currentTeamId = getNumber(currentTeamReference, ["id"]);
      const currentTeamPayload =
        currentTeamId !== null ? await apiRequest(`/teams/${currentTeamId}`) : null;
      const currentTeam =
        currentTeamPayload !== null ? getSingleResponseItem(currentTeamPayload, "Current team") : null;

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
      const payload = await apiRequest(`/leagues/${id}`, { include: "country" });
      const league = getSingleResponseItem(payload, "League");

      return {
        id: getNumber(league, ["id"]),
        name: getPreferredName(league),
        country: getPreferredName(readPath(league, ["country"])),
      };
    }
  }
}

async function getEntity(id: number, type: EntityType) {
  return jsonResponse(await fetchEntity(id, type));
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
    return getResponseItems(payload)
      .filter((record) =>
        type === "league"
          ? true
          : toRecordArray(readPath(record, ["participants"])).some(
              (participant) => getNumber(participant, ["id"]) === id,
            ),
      )
      .slice(0, MAX_MATCH_RESULTS)
      .map(mapMatch);
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
  return getResponseItems(payload).slice(0, MAX_MATCH_RESULTS).map(mapMatch);
}

async function getMatches(id: number, type: MatchEntityType, timeframe: MatchTimeframe) {
  return jsonResponse(await fetchMatches(id, type, timeframe));
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

async function fetchStandings(leagueId: number) {
  await getEntityReference(leagueId, "league");

  const payload = await apiRequest(`/standings/live/leagues/${leagueId}`, {
    include: "participant;details",
  });

  return getResponseItems(payload).map(mapStanding);
}

async function getStandings(leagueId: number) {
  return jsonResponse(await fetchStandings(leagueId));
}

async function getEntityReference(id: number, type: MatchEntityType) {
  if (type === "team") {
    await apiRequest(`/teams/${id}`);
    return;
  }

  await apiRequest(`/leagues/${id}`);
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
    name: "get_entity",
    description: "Get player, team, or league details by Sportmonks id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Sportmonks entity id.",
        },
        type: {
          type: "string",
          enum: ["player", "team", "league"],
          description: "Entity type to fetch.",
        },
      },
      required: ["id", "type"],
    },
    async handler(args) {
      await initializeReferenceData();
      const id = requirePositiveInteger(args.id, "id");
      const type = requireEnumValue(args.type, "type", ["player", "team", "league"]);
      return getEntity(id, type);
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
    name: "get_standings",
    description: "Get the live league standings for a Sportmonks league id.",
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
];

// ── Resources ────────────────────────────────────────────────────────────────

const resources: ResourceDefinition[] = [
  {
    uri: "sportmonks://documentation",
    name: "Sportmonks Football MCP Overview",
    description: "Overview of the five-tool Sportmonks football MCP server.",
    mimeType: "text/plain",
  },
];

async function readResource(uri: string) {
  switch (uri) {
    case "sportmonks://documentation":
      return {
        contents: [{ uri, mimeType: "text/plain", text: DOCUMENTATION_RESOURCE_TEXT }],
      };
    default:
      throw new SportmonksToolError(
        "not_found",
        `Unknown resource: ${uri}`,
        "Use 'sportmonks://documentation' or list resources again.",
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
      const matches = await fetchMatches(teamId, "team", "upcoming");

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
            const standings = await fetchStandings(firstLeagueId);
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

      const [entity, standings, matches] = await Promise.all([
        fetchEntity(leagueId, "league"),
        fetchStandings(leagueId),
        fetchMatches(leagueId, "league", "upcoming"),
      ]);

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
        lines.push("", "Standings: No live standings returned by Sportmonks.");
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

  if (!tool) {
    return errorResponse(
      new SportmonksToolError(
        "tool_error",
        `Unknown tool: ${name}`,
        "Call list_tools to discover the available tools, then retry with one of those tool names.",
      ),
    );
  }

  try {
    return await tool.handler(args ?? {});
  } catch (error) {
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
