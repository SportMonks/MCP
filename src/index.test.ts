import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SPORTMONKS_API_TOKEN = "test-api-token";
  process.env.VITEST = "true";
});

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => {
  class MockServer {
    setRequestHandler = vi.fn();
    connect = vi.fn();
  }

  return { Server: MockServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class MockTransport {}

  return { StdioServerTransport: MockTransport };
});

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
  ListResourcesRequestSchema: Symbol("ListResourcesRequestSchema"),
  ReadResourceRequestSchema: Symbol("ReadResourceRequestSchema"),
  ListPromptsRequestSchema: Symbol("ListPromptsRequestSchema"),
  GetPromptRequestSchema: Symbol("GetPromptRequestSchema"),
}));

import {
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
} from "./index.js";

function mockFetchJson(...responses: Array<{ data: unknown; status?: number; [key: string]: unknown }>) {
  return vi.fn().mockImplementation(async () => {
    const nextResponse = responses.shift();
    if (!nextResponse) {
      throw new Error("No more mocked responses available");
    }

    const status = nextResponse.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(nextResponse.data),
      text: () => Promise.resolve(JSON.stringify(nextResponse.data)),
    };
  });
}

function parseToolJson(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function primeDefaultReferenceData() {
  primeReferenceData(
    [
      { id: 11, code: "lineup", developer_name: "lineup", name: "Lineup" },
      { id: 12, code: "bench", developer_name: "bench", name: "Bench" },
      { id: 129, code: "overall-matches-played", developer_name: "overall-matches-played" },
      { id: 130, code: "overall-won", developer_name: "overall-won" },
      { id: 131, code: "overall-draw", developer_name: "overall-draw" },
      { id: 132, code: "overall-lost", developer_name: "overall-lost" },
      { id: 133, code: "overall-goals-for", developer_name: "overall-goals-for" },
      { id: 134, code: "overall-conceded", developer_name: "overall-conceded" },
      { id: 179, code: "goal-difference", developer_name: "goal-difference" },
      { id: 187, code: "overall-points", developer_name: "overall-points" },
      { id: 208, code: "goal-topscorer", developer_name: "GOAL_TOPSCORER", model_type: "statistic", name: "Goal Topscorer" },
      { id: 209, code: "assist-topscorer", developer_name: "ASSIST_TOPSCORER", model_type: "statistic", name: "Assist Topscorer" },
      { id: 84, code: "yellowcards", developer_name: "YELLOWCARDS", model_type: "statistic", name: "Yellowcards" },
      { id: 301, code: "goal", developer_name: "goal", name: "Goal" },
      { id: 401, code: "possession", developer_name: "possession", name: "Possession" },
      { id: 402, code: "corners", developer_name: "corners", name: "Corners" },
      // Season/lineup statistic detail types (subset used by stats tools).
      { id: 34, code: "corners", developer_name: "CORNERS", name: "Corners" },
      { id: 41, code: "shots-off-target", developer_name: "SHOTS_OFF_TARGET", name: "Shots Off Target" },
      { id: 45, code: "ball-possession", developer_name: "BALL_POSSESSION", name: "Ball Possession %" },
      { id: 52, code: "goals", developer_name: "GOALS", name: "Goals" },
      { id: 78, code: "tackles", developer_name: "TACKLES", name: "Tackles" },
      { id: 79, code: "assists", developer_name: "ASSISTS", name: "Assists" },
      { id: 80, code: "passes", developer_name: "PASSES", name: "Passes" },
      { id: 86, code: "shots-on-target", developer_name: "SHOTS_ON_TARGET", name: "Shots On Target" },
      { id: 88, code: "goals-conceded", developer_name: "GOALS_CONCEDED", name: "Goals Conceded" },
      { id: 117, code: "key-passes", developer_name: "KEY_PASSES", name: "Key Passes" },
      { id: 118, code: "rating", developer_name: "RATING", name: "Rating" },
      { id: 119, code: "minutes-played", developer_name: "MINUTES_PLAYED", name: "Minutes Played" },
      { id: 194, code: "cleansheets", developer_name: "CLEANSHEET", name: "Cleansheets" },
      { id: 214, code: "team-wins", developer_name: "WIN", name: "Team Wins" },
      { id: 215, code: "team-draws", developer_name: "DRAW", name: "Team Draws" },
      { id: 216, code: "team-lost", developer_name: "LOST", name: "Team Lost" },
      { id: 321, code: "appearances", developer_name: "APPEARANCES", name: "Appearances" },
      { id: 1677, code: "shots", developer_name: "SHOTS", name: "Shots" },
      { id: 27253, code: "pass-stats", developer_name: "PASS_STATS", name: "Pass Stats" },
      // Transfer kinds (resolved by get_transfers via the types cache).
      { id: 219, code: "transfer", developer_name: "TRANSFER", name: "Transfer" },
      { id: 9688, code: "end-of-loan", developer_name: "END_OF_LOAN", name: "End of loan" },
    ],
    [
      { id: 1, state: "NS", short_name: "NS", developer_name: "NOT_STARTED", name: "Not Started" },
      { id: 2, state: "LIVE", short_name: "LIVE", developer_name: "INPLAY", name: "In Play" },
    ],
  );
}

beforeEach(() => {
  primeDefaultReferenceData();
});

describe("Tool Registry", () => {
  const expectedTools = [
    "search",
    "get_player",
    "get_team",
    "get_league",
    "get_coach",
    "get_squad",
    "get_matches",
    "get_match_preview",
    "get_fixture_details",
    "get_standings",
    "get_historic_seasons",
    "get_topscorers",
    "get_odds",
    "get_season_stats",
    "get_fixture_lineup_stats",
    "get_pressure_index",
    "get_transfers",
  ];

  it("registers the split player, team, and league tools without the old get_entity tool", () => {
    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toEqual(expectedTools);
  });

  it("uses typed input schemas and the expected required fields", () => {
    expect(toolMap.get("search")?.inputSchema.required).toEqual(["query"]);
    expect(toolMap.get("get_player")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_team")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_league")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_coach")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_squad")?.inputSchema.required).toEqual(["team_id"]);
    expect(toolMap.get("get_matches")?.inputSchema.required).toEqual(["id", "type"]);
    expect(toolMap.get("get_match_preview")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_fixture_details")?.inputSchema.required).toEqual(["fixture_id"]);
    expect(toolMap.get("get_standings")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_historic_seasons")?.inputSchema.required).toEqual(["league_id"]);
    expect(toolMap.get("get_topscorers")?.inputSchema.required).toEqual(["season_id", "type"]);
    expect(toolMap.get("get_odds")?.inputSchema.required).toEqual(["fixture_id"]);
    expect(toolMap.get("get_season_stats")?.inputSchema.required).toEqual([
      "entity_id",
      "entity_type",
      "season_id",
    ]);
    expect(toolMap.get("get_fixture_lineup_stats")?.inputSchema.required).toEqual(["fixture_id"]);
    expect(toolMap.get("get_pressure_index")?.inputSchema.required).toEqual(["fixture_id"]);
    expect(toolMap.get("get_transfers")?.inputSchema.required).toEqual([]);

    expect(toolMap.get("get_player")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_team")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_league")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_coach")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("search")?.inputSchema.properties.type).toMatchObject({
      enum: ["player", "team", "league", "coach", "all"],
    });
    expect(toolMap.get("get_squad")?.inputSchema.properties.team_id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_matches")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_match_preview")?.inputSchema.properties.id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_fixture_details")?.inputSchema.properties.fixture_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_standings")?.inputSchema.properties.id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_historic_seasons")?.inputSchema.properties.league_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_topscorers")?.inputSchema.properties.season_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_odds")?.inputSchema.properties.fixture_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_odds")?.inputSchema.properties.type).toMatchObject({
      enum: ["prematch", "premium"],
    });
    // The advertised includes enum and the handler whitelist are separate
    // literals — pin the schema side so they can't silently drift apart.
    expect(toolMap.get("get_fixture_details")?.inputSchema.properties.includes).toMatchObject({
      items: { enum: ["lineups", "events", "statistics", "predictions", "xg"] },
    });
    expect(toolMap.get("get_season_stats")?.inputSchema.properties.entity_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_season_stats")?.inputSchema.properties.entity_type).toMatchObject({
      enum: ["player", "team"],
    });
    expect(toolMap.get("get_fixture_lineup_stats")?.inputSchema.properties.fixture_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_fixture_lineup_stats")?.inputSchema.properties.player_ids).toMatchObject({
      items: { type: "integer" },
    });
    expect(toolMap.get("get_pressure_index")?.inputSchema.properties.fixture_id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_pressure_index")?.inputSchema.properties.mode).toMatchObject({
      enum: ["summary", "timeline"],
    });
    expect(toolMap.get("get_transfers")?.inputSchema.properties.entity_type).toMatchObject({
      enum: ["team", "player"],
    });
    expect(toolMap.get("get_transfers")?.inputSchema.properties.type).toMatchObject({
      enum: ["confirmed", "rumour"],
    });
    expect(toolMap.get("get_transfers")?.inputSchema.properties.timeframe).toMatchObject({
      enum: ["latest", "date_range"],
    });
  });
});

describe("Response Helpers", () => {
  it("jsonResponse returns structured JSON text", () => {
    const result = jsonResponse({ hello: "world" });
    expect(parseToolJson(result)).toEqual({ hello: "world" });
  });

  it("textResponse returns plain text content", () => {
    expect(textResponse("hello").content[0].text).toBe("hello");
  });

  it("errorResponse returns structured JSON errors", () => {
    const result = errorResponse(new Error("boom"));
    const parsed = parseToolJson(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe("boom");
    expect(parsed.error.how_to_fix).toContain("Retry");
  });
});

describe("Reference Data", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads types from core and states from football on initialization", async () => {
    primeReferenceData([], []);

    const fetchMock = mockFetchJson(
      {
        data: [{ id: 129, code: "overall-matches-played", developer_name: "overall-matches-played" }],
        pagination: { has_more: false },
      },
      {
        data: [{ id: 1, state: "NS", short_name: "NS", developer_name: "NOT_STARTED" }],
        pagination: { has_more: false },
      },
    );
    globalThis.fetch = fetchMock;

    await initializeReferenceData();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    const secondUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(firstUrl.origin + firstUrl.pathname).toBe("https://api.sportmonks.com/v3/core/types");
    expect(secondUrl.origin + secondUrl.pathname).toBe(`${FOOTBALL_API_BASE_URL}/states`);
    expect(firstUrl.searchParams.get("per_page")).toBe("50");
    expect(firstUrl.searchParams.get("order")).toBe("asc");
    expect(secondUrl.searchParams.get("per_page")).toBe("50");
    expect(secondUrl.searchParams.get("order")).toBe("asc");
  });
});

describe("apiRequest", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.SPORTMONKS_API_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.SPORTMONKS_API_TOKEN = originalToken;
  });

  it("uses football api base url and api_token auth", async () => {
    const fetchMock = mockFetchJson({ data: [] });
    globalThis.fetch = fetchMock;

    await apiRequest("/teams/14", { include: "country" });

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe(`${FOOTBALL_API_BASE_URL}/teams/14`);
    expect(calledUrl.searchParams.get("api_token")).toBe("test-api-token");
    expect(calledUrl.searchParams.get("include")).toBe("country");
  });

  it("throws a descriptive auth error when the token is missing", async () => {
    process.env.SPORTMONKS_API_TOKEN = "";
    globalThis.fetch = mockFetchJson({ data: [] });

    await expect(apiRequest("/teams/14")).rejects.toThrow("SPORTMONKS_API_TOKEN is not set");
  });

  it("throws descriptive upstream errors", async () => {
    globalThis.fetch = mockFetchJson({ data: { error: "forbidden" }, status: 403 });

    await expect(apiRequest("/teams/14")).rejects.toThrow("Sportmonks rejected the request");
  });

  it("throws a timeout error when the request takes too long", async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const pending = apiRequest("/teams/14");
    vi.advanceTimersByTime(20_000);
    await expect(pending).rejects.toThrow("did not respond within");

    vi.useRealTimers();
  });
});

describe("Tool Handlers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("search defaults to all entity types (including coaches) and caps results", async () => {
    // Order matches the fan-out: player, team, league, coach.
    globalThis.fetch = mockFetchJson(
      { data: [{ id: 2, name: "Zed Player" }] },
      { data: [{ id: 3, name: "Arsenal" }] },
      { data: [{ id: 1, name: "Premier League" }] },
      { data: [{ id: 5, name: "Coach Bob" }] },
    );

    const result = await toolMap.get("search")!.handler({ query: "ars" });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      { id: 3, entity_type: "team", name: "Arsenal", country: null },
      { id: 5, entity_type: "coach", name: "Coach Bob", country: null },
      { id: 1, entity_type: "league", name: "Premier League", country: null },
      { id: 2, entity_type: "player", name: "Zed Player", country: null },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 4, cap: MAX_SEARCH_RESULTS, possibly_more: false });

    expect(globalThis.fetch).toHaveBeenCalledTimes(4);

    const firstUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(firstUrl.pathname).toBe("/v3/football/players/search/ars");
    expect(Number(firstUrl.searchParams.get("per_page"))).toBeGreaterThanOrEqual(MAX_SEARCH_RESULTS);
    expect(firstUrl.searchParams.get("include")).toBe("country");
    const coachUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[3][0]);
    expect(coachUrl.pathname).toBe("/v3/football/coaches/search/ars");
  });

  it("search uses the coaches endpoint when type=coach", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{ id: 455361, name: "Josep Guardiola i Sala", country: { name: "Spain" } }],
    });

    const result = await toolMap.get("search")!.handler({ query: "Guardiola", type: "coach" });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      { id: 455361, entity_type: "coach", name: "Josep Guardiola i Sala", country: "Spain" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/coaches/search/Guardiola");
    expect(calledUrl.searchParams.get("include")).toBe("country");
  });

  it("search uses a single exact endpoint when a specific type is provided", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{ id: 14, name: "Arsenal", country: { name: "England" } }],
    });

    const result = await toolMap.get("search")!.handler({ query: "Arsenal", type: "team" });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      { id: 14, entity_type: "team", name: "Arsenal", country: "England" },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, cap: MAX_SEARCH_RESULTS, possibly_more: false });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/teams/search/Arsenal");
    expect(calledUrl.searchParams.get("include")).toBe("country");
  });

  it("get_player delegates to the exact player entity flow", async () => {
    globalThis.fetch = mockFetchJson(
      {
        data: [
          {
            id: 758,
            display_name: "James Tavernier",
            date_of_birth: "1991-10-31",
            position: { name: "Right Back" },
            nationality: { name: "England" },
            teams: [{ id: 62, type: "domestic" }],
          },
        ],
      },
      {
        data: {
          id: 62,
          name: "Rangers",
        },
      },
    );

    const result = await toolMap.get("get_player")!.handler({ id: 758 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 758,
      name: "James Tavernier",
      position: "Right Back",
      nationality: "England",
      date_of_birth: "1991-10-31",
      current_team: { id: 62, name: "Rangers" },
    });
  });

  it("get_team uses the exact team endpoint and output shape, including the current coach", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 14,
        name: "Arsenal",
        country: { name: "England" },
        venue: { name: "Emirates Stadium" },
        coaches: [
          // A former coach (inactive) plus the current one — only active is used.
          { active: false, coach_id: 9, coach: { id: 9, name: "Unai Emery" } },
          { active: true, coach_id: 523817, coach: { id: 523817, name: "Mikel Arteta" } },
        ],
      },
    });

    const result = await toolMap.get("get_team")!.handler({ id: 14 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 14,
      name: "Arsenal",
      country: "England",
      venue: "Emirates Stadium",
      coach: { id: 523817, name: "Mikel Arteta" },
    });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/teams/14");
    expect(calledUrl.searchParams.get("include")).toBe("venue;country;coaches.coach");
  });

  it("get_team returns coach null when no active coach is recorded", async () => {
    globalThis.fetch = mockFetchJson({
      data: { id: 14, name: "Arsenal", country: { name: "England" }, venue: { name: "Emirates Stadium" }, coaches: [{ active: false, coach_id: 9, coach: { id: 9, name: "Unai Emery" } }] },
    });
    const parsed = parseToolJson(await toolMap.get("get_team")!.handler({ id: 14 }));
    expect(parsed.coach).toBeNull();
  });

  it("get_coach mirrors get_player and resolves the active club as current_team", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 455361,
        display_name: "Josep Guardiola i Sala",
        date_of_birth: "1971-01-18",
        nationality: { name: "Spain" },
        teams: [
          // An ended appointment plus the active one — current_team is the active club.
          { active: false, team_id: 70, team: { id: 70, name: "Bayern München" }, start: "2013-07-01", end: "2016-06-30" },
          { active: true, team_id: 9, team: { id: 9, name: "Manchester City" }, start: "2016-07-01", end: "2027-06-30" },
        ],
      },
    });

    const result = await toolMap.get("get_coach")!.handler({ id: 455361 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 455361,
      name: "Josep Guardiola i Sala",
      nationality: "Spain",
      date_of_birth: "1971-01-18",
      current_team: { id: 9, name: "Manchester City" },
    });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/coaches/455361");
    expect(calledUrl.searchParams.get("include")).toBe("nationality;teams.team");
  });

  it("get_coach picks the permanent, latest-start club among multiple active relations", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 455361, display_name: "Multi Coach", date_of_birth: "1971-01-18", nationality: { name: "Spain" },
        teams: [
          // A caretaker role with the newest start must lose to a permanent one.
          { active: true, temporary: true, team_id: 100, team: { id: 100, name: "Caretaker Club" }, start: "2024-01-01" },
          { active: true, temporary: false, team_id: 200, team: { id: 200, name: "Older Permanent" }, start: "2020-01-01" },
          { active: true, temporary: false, team_id: 300, team: { id: 300, name: "Newer Permanent" }, start: "2022-01-01" },
          // inactive rows are never eligible.
          { active: false, temporary: false, team_id: 400, team: { id: 400, name: "Past Club" }, start: "2026-01-01" },
        ],
      },
    });
    const parsed = parseToolJson(await toolMap.get("get_coach")!.handler({ id: 455361 }));
    expect(parsed.current_team).toEqual({ id: 300, name: "Newer Permanent" });
  });

  it("get_coach returns current_team null when the coach has no active appointment", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 999, display_name: "Retired Gaffer", date_of_birth: "1950-01-01", nationality: { name: "England" },
        teams: [{ active: false, team_id: 1, team: { id: 1, name: "Old Club" }, start: "1990-01-01", end: "1995-01-01" }],
      },
    });
    const parsed = parseToolJson(await toolMap.get("get_coach")!.handler({ id: 999 }));
    expect(parsed.current_team).toBeNull();
    expect(parsed).toMatchObject({ id: 999, name: "Retired Gaffer", nationality: "England", date_of_birth: "1950-01-01" });
  });

  it("get_league uses the exact league endpoint and output shape", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 501,
        name: "Premiership",
        country: { name: "Scotland" },
        currentseason: { id: 25583, name: "2025/2026" },
      },
    });

    const result = await toolMap.get("get_league")!.handler({ id: 501 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 501,
      name: "Premiership",
      country: "Scotland",
      current_season_id: 25583,
      current_season_name: "2025/2026",
    });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/leagues/501");
    expect(calledUrl.searchParams.get("include")).toBe("country;currentseason");
  });

  it("get_squad uses the current squad endpoint and maps current squad fields", async () => {
    globalThis.fetch = mockFetchJson({
      data: [
        {
          player_id: 10,
          jersey_number: 7,
          player: { id: 10, display_name: "Bukayo Saka" },
          position: { name: "Forward" },
          detailedPosition: { name: "Right Wing" },
        },
      ],
    });

    const result = await toolMap.get("get_squad")!.handler({ team_id: 14 });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        player_id: 10,
        name: "Bukayo Saka",
        position: "Forward",
        position_id: null,
        detailed_position: "Right Wing",
        detailed_position_id: null,
        jersey_number: 7,
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, possibly_more: false });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/squads/teams/14");
    expect(calledUrl.searchParams.get("include")).toBe("player;position;detailedPosition");
  });

  it("get_squad uses the historic squad endpoint when season_id is provided", async () => {
    globalThis.fetch = mockFetchJson({
      data: [
        {
          player_id: 11,
          jersey_number: 8,
          player: { id: 11, display_name: "Martin Odegaard" },
          position: { name: "Midfielder" },
        },
      ],
    });

    const result = await toolMap.get("get_squad")!.handler({ team_id: 14, season_id: 2024 });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        player_id: 11,
        name: "Martin Odegaard",
        position: "Midfielder",
        position_id: null,
        detailed_position: null,
        detailed_position_id: null,
        jersey_number: 8,
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, possibly_more: false });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/squads/seasons/2024/teams/14");
    expect(calledUrl.searchParams.get("include")).toBe("player;position");
  });

  it("get_matches uses the exact team date-range endpoint for upcoming team fixtures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T10:00:00"));

    globalThis.fetch = mockFetchJson(
      {
        data: { id: 14, name: "Arsenal" },
      },
      {
        data: [
          {
            id: 1001,
            starting_at: "2026-04-10 19:00:00",
            state_id: 1,
            league: { id: 8, name: "Premier League" },
            participants: [
              { id: 14, name: "Arsenal", meta: { location: "home" } },
              { id: 65, name: "Chelsea", meta: { location: "away" } },
            ],
          },
        ],
      },
    );

    const result = await toolMap.get("get_matches")!.handler({ id: 14, type: "team" });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        id: 1001,
        home_team: "Arsenal",
        away_team: "Chelsea",
        starting_at: "2026-04-10 19:00:00",
        state: "NS",
        league: { id: 8, name: "Premier League" },
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, cap: MAX_MATCH_RESULTS, possibly_more: false });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(calledUrl.pathname).toBe("/v3/football/fixtures/between/2026-04-08/2026-04-22/14");
    expect(calledUrl.searchParams.get("include")).toBe("participants;league");
    expect(calledUrl.searchParams.get("per_page")).toBe(String(MAX_MATCH_RESULTS));
    expect(calledUrl.searchParams.get("order")).toBeNull();
  });

  it("get_matches uses inplay livescores with the exact league filter for live league matches", async () => {
    globalThis.fetch = mockFetchJson(
      {
        data: { id: 501, name: "Premiership" },
      },
      {
        data: [
          {
            id: 2001,
            starting_at: "2026-04-08 16:00:00",
            state_id: 2,
            league: { id: 501, name: "Premiership" },
            participants: [
              { id: 53, name: "Celtic", meta: { location: "home" } },
              { id: 62, name: "Rangers", meta: { location: "away" } },
            ],
          },
        ],
      },
    );

    const result = await toolMap.get("get_matches")!.handler({
      id: 501,
      type: "league",
      timeframe: "live",
    });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        id: 2001,
        home_team: "Celtic",
        away_team: "Rangers",
        starting_at: "2026-04-08 16:00:00",
        state: "LIVE",
        league: { id: 501, name: "Premiership" },
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, cap: MAX_MATCH_RESULTS, possibly_more: false });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(calledUrl.pathname).toBe("/v3/football/livescores/inplay");
    expect(calledUrl.searchParams.get("filters")).toBe("fixtureLeagues:501");
    expect(calledUrl.searchParams.get("include")).toBe("participants;league");
  });

  it("get_match_preview uses fixture by id plus head-to-head and returns result_info", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T10:00:00"));

    globalThis.fetch = mockFetchJson(
      {
        data: {
          id: 18535517,
          starting_at: "2026-04-09 11:30:00",
          state_id: 1,
          participants: [
            { id: 53, name: "Celtic", meta: { location: "home" } },
            { id: 62, name: "Rangers", meta: { location: "away" } },
          ],
        },
      },
      {
        data: [
          {
            id: 999,
            starting_at: "2026-03-01 12:00:00",
            result_info: "Celtic won",
            participants: [
              { id: 53, name: "Celtic", meta: { location: "home" } },
              { id: 62, name: "Rangers", meta: { location: "away" } },
            ],
            scores: [
              { participant_id: 53, description: "CURRENT", score: { goals: 2 } },
              { participant_id: 62, description: "CURRENT", score: { goals: 1 } },
            ],
          },
        ],
      },
    );

    const result = await toolMap.get("get_match_preview")!.handler({ id: 18535517 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 18535517,
      home_team: "Celtic",
      away_team: "Rangers",
      starting_at: "2026-04-09 11:30:00",
      last_5_h2h_matches: [
        {
          date: "2026-03-01",
          home_team: "Celtic",
          away_team: "Rangers",
          home_score: 2,
          away_score: 1,
          result_info: "Celtic won",
        },
      ],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const fixtureUrl = new URL(fetchMock.mock.calls[0][0]);
    const h2hUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(fixtureUrl.pathname).toBe("/v3/football/fixtures/18535517");
    expect(fixtureUrl.searchParams.get("include")).toBe("participants");
    expect(h2hUrl.pathname).toBe("/v3/football/fixtures/head-to-head/53/62");
    expect(h2hUrl.searchParams.get("include")).toBe("participants;scores");
    expect(h2hUrl.searchParams.get("per_page")).toBe("5");
  });

  it("get_match_preview rejects fixtures that have already started", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 18535517,
        starting_at: "2026-04-09 11:30:00",
        state_id: 2,
        participants: [
          { id: 53, name: "Celtic", meta: { location: "home" } },
          { id: 62, name: "Rangers", meta: { location: "away" } },
        ],
      },
    });

    await expect(toolMap.get("get_match_preview")!.handler({ id: 18535517 })).rejects.toThrow(
      "get_match_preview only works for fixtures that have not started yet",
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("get_fixture_details always includes base fixture data and optional expansions", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 2001,
        starting_at: "2026-04-10 16:00:00",
        state_id: 2,
        league: { id: 501, name: "Premiership" },
        participants: [
          { id: 53, name: "Celtic", meta: { location: "home" } },
          { id: 62, name: "Rangers", meta: { location: "away" } },
        ],
        scores: [
          { participant_id: 53, description: "CURRENT", score: { goals: 2 } },
          { participant_id: 62, description: "CURRENT", score: { goals: 1 } },
        ],
        lineups: [
          {
            player_id: 160208,
            player_name: "Alejandro Grimaldo",
            jersey_number: 20,
            type_id: 11,
            position: { name: "Defender" },
          },
        ],
        events: [
          {
            minute: 23,
            type_id: 301,
            player_name: "Alejandro Grimaldo",
            related_player_name: "Christian Kofane",
            result: "1-0",
            info: "Left foot shot",
            sort_order: 1,
          },
        ],
        statistics: [
          {
            participant_id: 53,
            type_id: 401,
            data: { value: 62 },
          },
          {
            participant_id: 53,
            type_id: 402,
            data: { value: 7 },
          },
        ],
      },
    });

    const result = await toolMap.get("get_fixture_details")!.handler({
      fixture_id: 2001,
      includes: ["lineups", "events", "statistics"],
    });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 2001,
      home_team: { id: 53, name: "Celtic" },
      away_team: { id: 62, name: "Rangers" },
      starting_at: "2026-04-10 16:00:00",
      state: "LIVE",
      league: { id: 501, name: "Premiership" },
      scores: { home: 2, away: 1 },
      lineups: [
        {
          player_id: 160208,
          player_name: "Alejandro Grimaldo",
          team_id: null,
          jersey_number: 20,
          position: "Defender",
          detailed_position: null,
          type: "lineup",
        },
      ],
      events: [
        {
          minute: 23,
          type: "Goal",
          player_name: "Alejandro Grimaldo",
          related_player_name: "Christian Kofane",
          result: "1-0",
          info: "Left foot shot",
        },
      ],
      statistics: [
        {
          team_id: 53,
          team_name: "Celtic",
          stats: {
            possession: 62,
            corners: 7,
          },
        },
      ],
    });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/fixtures/2001");
    expect(calledUrl.searchParams.get("include")).toBe(
      "participants;scores;league;state;lineups.player;lineups.position;lineups.detailedPosition;events;statistics",
    );
  });

  it("get_historic_seasons returns seasons sorted from most recent to oldest", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 501,
        seasons: [
          {
            id: 2,
            name: "2023/2024",
            is_current: false,
            finished: true,
            starting_at: "2023-08-01",
            ending_at: "2024-05-20",
          },
          {
            id: 3,
            name: "2024/2025",
            is_current: true,
            finished: false,
            starting_at: "2024-08-01",
            ending_at: "2025-05-20",
          },
        ],
      },
    });

    const result = await toolMap.get("get_historic_seasons")!.handler({ league_id: 501 });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual([
      {
        id: 3,
        name: "2024/2025",
        is_current: true,
        finished: false,
        starting_at: "2024-08-01",
        ending_at: "2025-05-20",
      },
      {
        id: 2,
        name: "2023/2024",
        is_current: false,
        finished: true,
        starting_at: "2023-08-01",
        ending_at: "2024-05-20",
      },
    ]);

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/leagues/501");
    expect(calledUrl.searchParams.get("include")).toBe("seasons");
  });

  it("get_topscorers resolves the requested type through startup types and applies the limit", async () => {
    globalThis.fetch = mockFetchJson({
      data: [
        {
          position: 1,
          total: 20,
          player: { id: 160208, display_name: "Alejandro Grimaldo" },
          participant: { id: 53, name: "Celtic" },
        },
      ],
    });

    const result = await toolMap.get("get_topscorers")!.handler({
      season_id: 2024,
      type: "goals",
      limit: 5,
    });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        position: 1,
        player: { id: 160208, name: "Alejandro Grimaldo" },
        team: { id: 53, name: "Celtic" },
        total: 20,
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, cap: 5, possibly_more: false });

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/topscorers/seasons/2024");
    expect(calledUrl.searchParams.get("include")).toBe("player;participant;type");
    expect(calledUrl.searchParams.get("filters")).toBe("seasonTopscorerTypes:208");
    expect(calledUrl.searchParams.get("per_page")).toBe("5");
    expect(calledUrl.searchParams.get("order")).toBe("asc");
  });

  it("get_standings uses live league standings and maps detail types through startup type data", async () => {
    globalThis.fetch = mockFetchJson(
      {
        data: { id: 501, name: "Premiership" },
      },
      {
        data: [
          {
            position: 1,
            points: 80,
            participant: { id: 53, name: "Celtic" },
            details: [
              { type_id: 129, value: 32 },
              { type_id: 130, value: 26 },
              { type_id: 131, value: 2 },
              { type_id: 132, value: 4 },
              { type_id: 179, value: 45 },
              { type_id: 187, value: 80 },
            ],
          },
        ],
      },
    );

    const result = await toolMap.get("get_standings")!.handler({ id: 501 });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        position: 1,
        team: { id: 53, name: "Celtic" },
        played: 32,
        won: 26,
        drawn: 2,
        lost: 4,
        gd: 45,
        points: 80,
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, possibly_more: false });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const standingsUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(standingsUrl.pathname).toBe("/v3/football/standings/live/leagues/501");
    expect(standingsUrl.searchParams.get("include")).toBe("participant;details");
    expect(Number(standingsUrl.searchParams.get("per_page"))).toBeGreaterThanOrEqual(36);
  });

  it("get_standings falls back to season standings when live returns 404", async () => {
    globalThis.fetch = mockFetchJson(
      // 1. getEntityReference → /leagues/501
      { data: { id: 501, name: "Premiership" } },
      // 2. live standings → 404 ("No result(s) found... or no subscription access")
      {
        status: 404,
        data: {
          message:
            "No result(s) found matching your request. Either the query did not return any results or you don't have access to it via your current subscription.",
        },
      },
      // 3. fallback → /leagues/501?include=currentseason
      {
        data: {
          id: 501,
          name: "Premiership",
          currentseason: { id: 23456, name: "2025/2026" },
        },
      },
      // 4. /standings/seasons/23456
      {
        data: [
          {
            position: 1,
            points: 80,
            participant: { id: 53, name: "Celtic" },
            details: [
              { type_id: 129, value: 32 },
              { type_id: 130, value: 26 },
              { type_id: 131, value: 2 },
              { type_id: 132, value: 4 },
              { type_id: 179, value: 45 },
              { type_id: 187, value: 80 },
            ],
          },
        ],
      },
    );

    const result = await toolMap.get("get_standings")!.handler({ id: 501 });
    const parsed = parseToolJson(result);

    expect(parsed.data).toEqual([
      {
        position: 1,
        team: { id: 53, name: "Celtic" },
        played: 32,
        won: 26,
        drawn: 2,
        lost: 4,
        gd: 45,
        points: 80,
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 1, possibly_more: false });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const livePath = new URL(fetchMock.mock.calls[1][0]).pathname;
    const fallbackLeaguePath = new URL(fetchMock.mock.calls[2][0]).pathname;
    const fallbackLeagueIncludes = new URL(fetchMock.mock.calls[2][0]).searchParams.get("include");
    const seasonPath = new URL(fetchMock.mock.calls[3][0]).pathname;

    expect(livePath).toBe("/v3/football/standings/live/leagues/501");
    expect(fallbackLeaguePath).toBe("/v3/football/leagues/501");
    expect(fallbackLeagueIncludes).toBe("currentseason");
    expect(seasonPath).toBe("/v3/football/standings/seasons/23456");
  });

  it("get_standings still surfaces non-404 errors from the live endpoint", async () => {
    globalThis.fetch = mockFetchJson(
      // 1. getEntityReference → /leagues/501
      { data: { id: 501, name: "Premiership" } },
      // 2. live standings → 401 (auth error must NOT be swallowed by fallback)
      {
        status: 401,
        data: { message: "Unauthenticated." },
      },
    );

    const handler = toolMap.get("get_standings")!.handler;
    await expect(handler({ id: 501 })).rejects.toMatchObject({
      kind: "authentication_error",
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── get_odds ────────────────────────────────────────────────────────────
  it("get_odds defaults to the pre-match feed and maps the curated odds shape", async () => {
    globalThis.fetch = mockFetchJson({
      data: [
        {
          id: 1, fixture_id: 19665891, market_id: 7, bookmaker_id: 16, label: "Over",
          value: "2.03", total: "2.5", handicap: null, stopped: true,
          latest_bookmaker_update: "2026-06-02 09:59:37",
          market_description: "Goal Line",
          market: { id: 7, name: "Goal Line" }, bookmaker: { id: 16, name: "Marathonbet" },
        },
        {
          id: 2, fixture_id: 19665891, market_id: 1, bookmaker_id: 2, label: "Home",
          value: "1.14", total: null, handicap: null, stopped: false,
          latest_bookmaker_update: "2026-06-10 15:50:15",
          market_description: "Full Time Result",
          market: { id: 1, name: "Fulltime Result" }, bookmaker: { id: 2, name: "bet365" },
        },
      ],
    });

    const result = await toolMap.get("get_odds")!.handler({ fixture_id: 19665891 });
    const parsed = parseToolJson(result);

    // Sorted by market id, so Fulltime Result (market 1) comes first.
    expect(parsed.data).toEqual([
      {
        bookmaker_id: 2, bookmaker_name: "bet365", market_id: 1, market_name: "Fulltime Result",
        label: "Home", value: "1.14", total: null, handicap: null, stopped: false,
        last_updated: "2026-06-10 15:50:15",
      },
      {
        bookmaker_id: 16, bookmaker_name: "Marathonbet", market_id: 7, market_name: "Goal Line",
        label: "Over", value: "2.03", total: "2.5", handicap: null, stopped: true,
        last_updated: "2026-06-02 09:59:37",
      },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 2, cap: DEFAULT_ODDS_RESULTS, possibly_more: false });

    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.pathname).toBe("/v3/football/odds/pre-match/fixtures/19665891");
    expect(url.searchParams.get("include")).toBe("market;bookmaker");
    expect(url.searchParams.get("filters")).toBeNull();
  });

  it("get_odds composes market and bookmaker filters and supports premium", async () => {
    globalThis.fetch = mockFetchJson(
      { data: [{ id: 1, market_id: 1, bookmaker_id: 2, label: "Home", value: "1.14", stopped: false, latest_bookmaker_update: "x", market: { id: 1, name: "Fulltime Result" }, bookmaker: { id: 2, name: "bet365" } }] },
      { data: [{ id: 1, market_id: 1, bookmaker_id: 2, label: "Home", value: "1.14", stopped: false, latest_bookmaker_update: "x", market: { id: 1, name: "Fulltime Result" }, bookmaker: { id: 2, name: "bet365" } }] },
    );

    await toolMap.get("get_odds")!.handler({ fixture_id: 19665891, market_id: 1, bookmaker_id: 2 });
    await toolMap.get("get_odds")!.handler({ fixture_id: 19665891, type: "premium", market_id: 1 });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("filters")).toBe("markets:1;bookmakers:2");
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe("/v3/football/odds/premium/fixtures/19665891");
  });

  it("get_odds caps at the default limit, honors a custom limit, and sorts by market/bookmaker/label", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1, market_id: 60 - i, bookmaker_id: 2, label: "Home", value: "1.5", stopped: false, latest_bookmaker_update: "x",
    }));
    globalThis.fetch = mockFetchJson({ data: entries });
    let parsed = parseToolJson(await toolMap.get("get_odds")!.handler({ fixture_id: 19665891 }));
    expect(parsed.data).toHaveLength(DEFAULT_ODDS_RESULTS);
    expect(parsed.meta).toMatchObject({ cap: DEFAULT_ODDS_RESULTS, possibly_more: true });
    expect(parsed.data[0].market_id).toBe(1);

    globalThis.fetch = mockFetchJson({
      data: [
        { id: 1, market_id: 7, bookmaker_id: 2, label: "Over", value: "1.9", latest_bookmaker_update: "x" },
        { id: 2, market_id: 1, bookmaker_id: 16, label: "Home", value: "1.2", latest_bookmaker_update: "x" },
        { id: 3, market_id: 1, bookmaker_id: 2, label: "Home", value: "1.14", latest_bookmaker_update: "x" },
        { id: 4, market_id: 1, bookmaker_id: 2, label: "Away", value: "19", latest_bookmaker_update: "x" },
      ],
    });
    parsed = parseToolJson(await toolMap.get("get_odds")!.handler({ fixture_id: 19665891 }));
    expect(parsed.data.map((e: { market_id: number; bookmaker_id: number; label: string }) => [e.market_id, e.bookmaker_id, e.label])).toEqual([
      [1, 2, "Away"], [1, 2, "Home"], [1, 16, "Home"], [7, 2, "Over"],
    ]);
  });

  it("get_odds returns an empty envelope for a fixture with no odds and not_found for an unknown fixture", async () => {
    globalThis.fetch = mockFetchJson({ data: [] }, { data: { id: 19714716 } });
    let parsed = parseToolJson(await toolMap.get("get_odds")!.handler({ fixture_id: 19714716 }));
    expect(parsed.data).toEqual([]);
    expect(parsed.meta).toMatchObject({ returned: 0, possibly_more: false });

    globalThis.fetch = mockFetchJson({ data: [] }, { data: [] });
    await expect(
      toolMap.get("get_odds")!.handler({ fixture_id: 999999999 }),
    ).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("Fixture 999999999") });
  });

  it("get_odds surfaces a subscription error for premium when not covered", async () => {
    globalThis.fetch = mockFetchJson({ status: 403, data: { message: "no access", code: 5007 } });
    await expect(
      toolMap.get("get_odds")!.handler({ fixture_id: 19665891, type: "premium" }),
    ).rejects.toMatchObject({
      kind: "authentication_error",
      message: expect.stringContaining("premium odds"),
      howToFix: expect.stringContaining("type='prematch'"),
    });
  });

  // ── get_fixture_details: predictions ──────────────────────────────────────
  it("get_fixture_details maps the four curated prediction types and ignores the rest", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 19712000, starting_at: "2026-06-11 00:00:00", state_id: 1,
        participants: [
          { id: 100, name: "Bolivia", meta: { location: "home" } },
          { id: 101, name: "Algeria", meta: { location: "away" } },
        ],
        predictions: [
          { id: 1, type_id: 237, predictions: { home: 25.49, away: 49.99, draw: 24.52 } },
          { id: 2, type_id: 231, predictions: { yes: 53.4, no: 46.6 } },
          { id: 3, type_id: 235, predictions: { yes: 53.43, no: 46.57 } },
          { id: 4, type_id: 33, predictions: { bet: "2", bookmaker: "dafabet", fair_odd: 1.46, odd: 1.49, stake: 1.35, is_value: false } },
          { id: 5, type_id: 33, predictions: { bet: "X", bookmaker: "1xbet", fair_odd: 3.4, odd: 3.65, stake: 0.8, is_value: true } },
          { id: 6, type_id: 238, predictions: { home_over: 50.1 } },
        ],
      },
    });

    const parsed = parseToolJson(await toolMap.get("get_fixture_details")!.handler({ fixture_id: 19712000, includes: ["predictions"] }));
    expect(parsed.predictions).toEqual({
      home_win: 25.49, draw: 24.52, away_win: 49.99, btts: 53.4, over_2_5: 53.43,
      value_bets: [
        { bet: "2", bookmaker: "dafabet", fair_odd: 1.46, odd: 1.49, stake: 1.35, is_value: false },
        { bet: "X", bookmaker: "1xbet", fair_odd: 3.4, odd: 3.65, stake: 0.8, is_value: true },
      ],
    });
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.searchParams.get("include")).toBe("participants;scores;league;state;predictions");
  });

  it("get_fixture_details returns null predictions fields and empty value_bets when types are missing", async () => {
    globalThis.fetch = mockFetchJson({
      data: { id: 19712000, state_id: 1, participants: [{ id: 100, name: "A", meta: { location: "home" } }, { id: 101, name: "B", meta: { location: "away" } }], predictions: [] },
    });
    const parsed = parseToolJson(await toolMap.get("get_fixture_details")!.handler({ fixture_id: 19712000, includes: ["predictions"] }));
    expect(parsed.predictions).toEqual({ home_win: null, draw: null, away_win: null, btts: null, over_2_5: null, value_bets: [] });
  });

  it("get_fixture_details surfaces a predictions add-on error, but keeps the generic auth error otherwise", async () => {
    globalThis.fetch = mockFetchJson({ status: 403, data: { message: "no predictions include", code: 5002 } });
    await expect(
      toolMap.get("get_fixture_details")!.handler({ fixture_id: 19712000, includes: ["predictions"] }),
    ).rejects.toMatchObject({
      kind: "authentication_error",
      message: expect.stringContaining("predictions add-on"),
      howToFix: expect.stringContaining("without 'predictions'"),
    });

    globalThis.fetch = mockFetchJson({ status: 403, data: { message: "Unauthenticated." } });
    await expect(
      toolMap.get("get_fixture_details")!.handler({ fixture_id: 19712000, includes: ["events"] }),
    ).rejects.toMatchObject({ kind: "authentication_error", message: expect.not.stringContaining("predictions add-on") });
  });

  // ── get_fixture_details: xg ────────────────────────────────────────────────
  it("get_fixture_details maps xg and xg_on_target per team and combines with statistics", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 19683238, state_id: 5,
        participants: [
          { id: 503, name: "FC Bayern München", meta: { location: "home" } },
          { id: 591, name: "Paris Saint Germain", meta: { location: "away" } },
        ],
        statistics: [{ participant_id: 503, type_id: 401, data: { value: 66 } }],
        xgfixture: [
          { id: 1, type_id: 5304, participant_id: 591, data: { value: 1.3669 }, location: "away" },
          { id: 2, type_id: 5304, participant_id: 503, data: { value: 1.799 }, location: "home" },
          { id: 3, type_id: 5305, participant_id: 591, data: { value: 3.0758 }, location: "away" },
          { id: 4, type_id: 5305, participant_id: 503, data: { value: 1.689 }, location: "home" },
          { id: 5, type_id: 9687, participant_id: 503, data: { value: 1.3669 }, location: "home" },
        ],
      },
    });

    const parsed = parseToolJson(await toolMap.get("get_fixture_details")!.handler({ fixture_id: 19683238, includes: ["statistics", "xg"] }));
    expect(parsed.statistics).toEqual([{ team_id: 503, team_name: "FC Bayern München", stats: { possession: 66 } }]);
    expect(parsed.xg).toEqual([
      { team_id: 591, team_name: "Paris Saint Germain", xg: 1.3669, xg_on_target: 3.0758 },
      { team_id: 503, team_name: "FC Bayern München", xg: 1.799, xg_on_target: 1.689 },
    ]);
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.searchParams.get("include")).toBe("participants;scores;league;state;statistics;xGFixture");
    expect(url.searchParams.get("filters")).toBeNull();
  });

  it("get_fixture_details returns an empty xg array when the fixture has no xG data", async () => {
    globalThis.fetch = mockFetchJson({ data: { id: 19609174, state_id: 1, participants: [{ id: 100, name: "A", meta: { location: "home" } }, { id: 101, name: "B", meta: { location: "away" } }], xgfixture: [] } });
    const parsed = parseToolJson(await toolMap.get("get_fixture_details")!.handler({ fixture_id: 19609174, includes: ["xg"] }));
    expect(parsed.xg).toEqual([]);
  });

  // ── get_season_stats ───────────────────────────────────────────────────────
  it("get_season_stats applies player defaults and unwraps single-key stat values", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{
        id: 1, player_id: 154421, team_id: 9, season_id: 25583, has_values: true,
        player: { id: 154421, display_name: "Erling Haaland" }, team: { id: 9, name: "Manchester City" }, season: { id: 25583, name: "2025/2026" },
        details: [
          { type_id: 52, value: { total: 27, goals: 24, penalties: 3 } },
          { type_id: 79, value: { total: 8 } }, { type_id: 119, value: { total: 2960 } },
          { type_id: 321, value: { total: 35 } }, { type_id: 86, value: { total: 59 } },
          { type_id: 80, value: { total: 384 } }, { type_id: 117, value: { total: 25 } },
          { type_id: 78, value: { total: 15 } }, { type_id: 118, value: { average: 7.35, highest: 9.26, lowest: 5.83 } },
          { type_id: 41, value: { total: 43 } },
        ],
      }],
      pagination: { has_more: false },
    });
    const parsed = parseToolJson(await toolMap.get("get_season_stats")!.handler({ entity_id: 154421, entity_type: "player", season_id: 25583 }));
    expect(parsed.data[0]).toEqual({
      entity_id: 154421, entity_name: "Erling Haaland", entity_type: "player", season_id: 25583, season_name: "2025/2026",
      stats: { goals: { total: 27, goals: 24, penalties: 3 }, assists: 8, minutes_played: 2960, appearances: 35, shots_on_target: 59, passes: 384, key_passes: 25, tackles: 15, rating: { average: 7.35, highest: 9.26, lowest: 5.83 } },
      team: { id: 9, name: "Manchester City" },
    });
    expect(parsed.meta).toMatchObject({ returned: 1, cap: MAX_SEASON_STATS_ROWS, stat_types: DEFAULT_PLAYER_STAT_TYPES });
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.pathname).toBe("/v3/football/statistics/seasons/players/154421");
    expect(url.searchParams.get("filters")).toBe("playerstatisticSeasons:25583");
    expect(url.searchParams.get("include")).toBe("player;team;season");
  });

  it("get_season_stats applies team defaults and keeps single-key object values wrapped", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{
        id: 1, team_id: 9, season_id: 25583, has_values: true, team: { id: 9, name: "Manchester City" }, season: { id: 25583, name: "2025/2026" },
        details: [
          { type_id: 52, value: { all: { count: 77 } } }, { type_id: 88, value: { all: { count: 35 } } },
          { type_id: 214, value: { all: { count: 23, percentage: 60.53 } } }, { type_id: 215, value: { all: { count: 9 } } },
          { type_id: 216, value: { all: { count: 6 } } }, { type_id: 194, value: { all: { count: 16 } } },
          { type_id: 1677, value: { total: 594, on_target: 205 } }, { type_id: 27253, value: { total_passes: 22342 } },
          { type_id: 45, value: { count: 2300, average: 60.53 } }, { type_id: 34, value: { count: 244 } },
        ],
      }],
      pagination: { has_more: false },
    });
    const parsed = parseToolJson(await toolMap.get("get_season_stats")!.handler({ entity_id: 9, entity_type: "team", season_id: 25583 }));
    const row = parsed.data[0];
    expect(row.team).toBeUndefined();
    expect(Object.keys(row.stats).sort()).toEqual(["ball_possession", "cleansheets", "goals", "goals_conceded", "pass_stats", "shots", "team_draws", "team_lost", "team_wins"]);
    expect(row.stats.ball_possession).toEqual({ count: 2300, average: 60.53 });
    expect(row.stats.team_wins).toEqual({ all: { count: 23, percentage: 60.53 } });
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.pathname).toBe("/v3/football/statistics/seasons/teams/9");
    expect(url.searchParams.get("filters")).toBe("teamstatisticSeasons:25583");
  });

  it("get_season_stats honors a stat_types override, normalizes spellings, and handles empty/not_found", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{ id: 1, player_id: 154421, season_id: 25583, player: { id: 154421, display_name: "Erling Haaland" }, details: [{ type_id: 52, value: { total: 27 } }, { type_id: 118, value: { value: "7.01" } }] }],
      pagination: { has_more: false },
    });
    let parsed = parseToolJson(await toolMap.get("get_season_stats")!.handler({ entity_id: 154421, entity_type: "player", season_id: 25583, stat_types: ["Goals", "rating"] }));
    expect(Object.keys(parsed.data[0].stats).sort()).toEqual(["goals", "rating"]);
    expect(parsed.data[0].stats.rating).toBe("7.01");
    expect(parsed.meta.stat_types).toEqual(["goals", "rating"]);

    globalThis.fetch = mockFetchJson({ data: [], pagination: { has_more: false } }, { data: { id: 154421, display_name: "Erling Haaland" } });
    parsed = parseToolJson(await toolMap.get("get_season_stats")!.handler({ entity_id: 154421, entity_type: "player", season_id: 28083 }));
    expect(parsed.data).toEqual([]);
    expect(parsed.meta).toMatchObject({ returned: 0, stat_types: DEFAULT_PLAYER_STAT_TYPES });

    globalThis.fetch = mockFetchJson({ data: [], pagination: { has_more: false } }, { data: [] });
    await expect(
      toolMap.get("get_season_stats")!.handler({ entity_id: 999999999, entity_type: "player", season_id: 25583 }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  // ── get_fixture_lineup_stats ───────────────────────────────────────────────
  it("get_fixture_lineup_stats applies the default filter upstream and maps player rows", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 19701372,
        participants: [{ id: 18635, name: "Iceland" }, { id: 18644, name: "Argentina" }],
        lineups: [
          { id: 1, player_id: 100, team_id: 18644, type_id: 11, player_name: "Lionel Messi ", details: [
            { id: 11, player_id: 100, type_id: 52, data: { value: 2 } },
            { id: 12, player_id: 100, type_id: 79, data: { value: 1 } },
            { id: 13, player_id: 100, type_id: 119, data: { value: 90 } },
            { id: 14, player_id: 100, type_id: 118, data: { value: 8.9 } },
          ] },
          { id: 2, player_id: 200, team_id: 18635, type_id: 12, player_name: "Unused Sub", details: [] },
        ],
      },
    });
    const parsed = parseToolJson(await toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 19701372 }));
    expect(parsed.data).toEqual([
      { player_id: 100, player_name: "Lionel Messi", team_id: 18644, team_name: "Argentina", type: "lineup", stats: { goals: 2, assists: 1, minutes_played: 90 } },
      { player_id: 200, player_name: "Unused Sub", team_id: 18635, team_name: "Iceland", type: "bench", stats: {} },
    ]);
    expect(parsed.meta).toMatchObject({ returned: 2, cap: MAX_LINEUP_STATS_ROWS, stat_types: ["goals", "assists", "minutes_played"] });
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.searchParams.get("include")).toBe("lineups.details;participants");
    expect(url.searchParams.get("filters")).toBe("lineupdetailTypes:52,79,119");
  });

  it("get_fixture_lineup_stats resolves overrides (incl. collisions) and filters by player_ids", async () => {
    globalThis.fetch = mockFetchJson(
      { data: { id: 19701372, participants: [{ id: 18644, name: "Argentina" }], lineups: [{ id: 1, player_id: 100, team_id: 18644, type_id: 11, player_name: "Messi", details: [{ id: 11, player_id: 100, type_id: 34, data: { value: 5 } }] }] } },
      { data: { id: 19701372, participants: [{ id: 18644, name: "Argentina" }], lineups: [{ id: 1, player_id: 100, team_id: 18644, type_id: 11, player_name: "Messi", details: [] }, { id: 2, player_id: 200, team_id: 18644, type_id: 11, player_name: "Other", details: [] }] } },
    );
    let parsed = parseToolJson(await toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 19701372, stat_types: ["corners"] }));
    expect(parsed.data[0].stats).toEqual({ corners: 5 });
    // Two types resolve to "corners" (34 and 402) — both ids must be sent.
    expect(new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).searchParams.get("filters")).toBe("lineupdetailTypes:402,34");

    parsed = parseToolJson(await toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 19701372, player_ids: [100] }));
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].player_id).toBe(100);
  });

  it("get_fixture_lineup_stats handles empty lineups and unknown fixtures", async () => {
    globalThis.fetch = mockFetchJson({ data: { id: 19714265, lineups: [], participants: [] } });
    let parsed = parseToolJson(await toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 19714265 }));
    expect(parsed.data).toEqual([]);
    expect(parsed.meta).toMatchObject({ returned: 0, cap: MAX_LINEUP_STATS_ROWS });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch = mockFetchJson({ data: [] });
    await expect(
      toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 999999999 }),
    ).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("Fixture 999999999"), howToFix: expect.stringContaining("get_matches") });
  });

  // ── get_pressure_index ─────────────────────────────────────────────────────
  const pressureFixture = (rows: Array<{ pid: number; minute: number; pressure: number }>) => ({
    data: {
      id: 18804442,
      participants: [
        { id: 9, name: "Manchester City", meta: { location: "home" } },
        { id: 2930, name: "Inter", meta: { location: "away" } },
      ],
      pressure: rows.map((r, i) => ({ id: 941884000 + i, fixture_id: 18804442, participant_id: r.pid, minute: r.minute, pressure: r.pressure })),
    },
  });

  it("get_pressure_index defaults to summary with per-team aggregates and swing minutes", async () => {
    globalThis.fetch = mockFetchJson(pressureFixture([
      { pid: 2930, minute: 1, pressure: 0 }, { pid: 9, minute: 1, pressure: 10 },
      { pid: 9, minute: 2, pressure: 20 }, { pid: 2930, minute: 2, pressure: 0 },
      { pid: 9, minute: 3, pressure: 0 }, { pid: 2930, minute: 3, pressure: 30 },
      { pid: 9, minute: 4, pressure: 40 }, { pid: 2930, minute: 4, pressure: 0 },
    ]));
    const parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442 }));
    expect(parsed.meta).toEqual({ returned: 4, cap: MAX_PRESSURE_TIMELINE_ROWS, possibly_more: false, mode: "summary" });
    expect(parsed.data.teams).toEqual([
      { team_id: 9, team_name: "Manchester City", peak_pressure: 40, average_pressure: 17.5, dominance_share: 75 },
      { team_id: 2930, team_name: "Inter", peak_pressure: 30, average_pressure: 7.5, dominance_share: 25 },
    ]);
    expect(parsed.data.swings).toEqual([
      { minute: 3, team_id: 2930, team_name: "Inter", pressure: 30 },
      { minute: 4, team_id: 9, team_name: "Manchester City", pressure: 40 },
    ]);
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.searchParams.get("include")).toBe("pressure;participants");
  });

  it("get_pressure_index timeline is minute-sorted with redundant fields stripped", async () => {
    globalThis.fetch = mockFetchJson(pressureFixture([
      { pid: 9, minute: 2, pressure: 20 }, { pid: 2930, minute: 2, pressure: 0 },
      { pid: 9, minute: 1, pressure: 10 }, { pid: 2930, minute: 1, pressure: 0 },
      { pid: 2930, minute: 3, pressure: 30 }, { pid: 9, minute: 3, pressure: 0 },
    ]));
    const parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442, mode: "timeline" }));
    expect(parsed.data.teams).toEqual([{ team_id: 9, team_name: "Manchester City" }, { team_id: 2930, team_name: "Inter" }]);
    expect(parsed.data.timeline).toEqual([
      { minute: 1, home: 10, away: 0 }, { minute: 2, home: 20, away: 0 }, { minute: 3, home: 0, away: 30 },
    ]);
    expect(parsed.meta).toEqual({ returned: 3, cap: MAX_PRESSURE_TIMELINE_ROWS, possibly_more: false, mode: "timeline" });
  });

  it("get_pressure_index counts tied minutes toward neither team and defaults absent rows to 0", async () => {
    globalThis.fetch = mockFetchJson(pressureFixture([
      { pid: 9, minute: 1, pressure: 10 }, { pid: 2930, minute: 1, pressure: 0 },
      { pid: 9, minute: 2, pressure: 5 }, { pid: 2930, minute: 2, pressure: 5 },
      { pid: 9, minute: 3, pressure: 0 }, { pid: 2930, minute: 3, pressure: 0 },
      { pid: 9, minute: 4, pressure: 0 }, { pid: 2930, minute: 4, pressure: 20 },
    ]));
    let parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442 }));
    expect(parsed.data.teams[0].dominance_share).toBe(25);
    expect(parsed.data.teams[1].dominance_share).toBe(25);
    expect(parsed.data.swings).toEqual([{ minute: 4, team_id: 2930, team_name: "Inter", pressure: 20 }]);

    const unpaired = pressureFixture([
      { pid: 9, minute: 1, pressure: 8 }, { pid: 9, minute: 2, pressure: 4 }, { pid: 2930, minute: 2, pressure: 0 }, { pid: 2930, minute: 3, pressure: 6 },
    ]);
    globalThis.fetch = mockFetchJson(unpaired, unpaired);
    parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442, mode: "timeline" }));
    expect(parsed.data.timeline).toEqual([{ minute: 1, home: 8, away: 0 }, { minute: 2, home: 4, away: 0 }, { minute: 3, home: 0, away: 6 }]);
    parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442 }));
    expect(parsed.data.teams[0]).toMatchObject({ peak_pressure: 8, average_pressure: 4, dominance_share: 66.67 });
    expect(parsed.data.teams[1]).toMatchObject({ peak_pressure: 6, average_pressure: 2, dominance_share: 33.33 });
  });

  it("get_pressure_index caps the timeline, handles empty data, and not_found across shapes", async () => {
    const rows: Array<{ pid: number; minute: number; pressure: number }> = [];
    for (let m = 1; m <= MAX_PRESSURE_TIMELINE_ROWS + 5; m += 1) { rows.push({ pid: 9, minute: m, pressure: 5 }); rows.push({ pid: 2930, minute: m, pressure: 0 }); }
    globalThis.fetch = mockFetchJson(pressureFixture(rows));
    let parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 18804442, mode: "timeline" }));
    expect(parsed.data.timeline).toHaveLength(MAX_PRESSURE_TIMELINE_ROWS);
    expect(parsed.meta).toMatchObject({ returned: MAX_PRESSURE_TIMELINE_ROWS, possibly_more: true });

    const empty = { data: { id: 19609174, participants: [{ id: 100, name: "A", meta: { location: "home" } }, { id: 101, name: "B", meta: { location: "away" } }], pressure: [] } };
    globalThis.fetch = mockFetchJson(empty, empty);
    parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 19609174 }));
    expect(parsed.data.swings).toEqual([]);
    parsed = parseToolJson(await toolMap.get("get_pressure_index")!.handler({ fixture_id: 19609174, mode: "timeline" }));
    expect(parsed.data.timeline).toEqual([]);

    for (const bad of [{ data: [] }, { data: {} }, { status: 404, data: { message: "x" } }]) {
      globalThis.fetch = mockFetchJson(bad);
      await expect(
        toolMap.get("get_pressure_index")!.handler({ fixture_id: 777777777 }),
      ).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("Fixture 777777777"), howToFix: expect.stringContaining("get_matches") });
    }
  });

  // ── get_transfers ──────────────────────────────────────────────────────────
  const transferRow = (over: Record<string, unknown> = {}) => ({
    id: 479543, player_id: 14685113, type_id: 219, from_team_id: 8295, to_team_id: 13363, date: "2026-06-30", amount: null,
    player: { id: 14685113, name: "Marco Ballini" }, fromteam: { id: 8295, name: "Singha Chiangrai United" }, toteam: { id: 13363, name: "BG Pathum United" },
    ...over,
  });

  it("get_transfers returns latest confirmed transfers with a curated flat shape", async () => {
    globalThis.fetch = mockFetchJson({ data: [transferRow({ amount: null }), transferRow({ id: 479544, type_id: 9688, amount: 5000000 })] });
    const parsed = parseToolJson(await toolMap.get("get_transfers")!.handler({ timeframe: "latest" }));
    expect(parsed.data[0]).toEqual({
      id: 479543, player: { id: 14685113, name: "Marco Ballini" }, from_team: { id: 8295, name: "Singha Chiangrai United" }, to_team: { id: 13363, name: "BG Pathum United" },
      type: "confirmed", transfer_kind: "Transfer", fee: null, date: "2026-06-30",
    });
    expect(parsed.data[1]).toMatchObject({ transfer_kind: "End of loan", fee: 5000000 });
    expect(parsed.meta).toMatchObject({ returned: 2, cap: MAX_TRANSFER_RESULTS, possibly_more: false });
    const url = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url.pathname).toBe("/v3/football/transfers/latest");
    expect(url.searchParams.get("include")).toBe("player;fromteam;toteam");
  });

  it("get_transfers scopes to team/player and uses the rumour feed for rumours", async () => {
    globalThis.fetch = mockFetchJson({ data: [transferRow()] }, { data: [transferRow()] }, { data: [transferRow({ amount: 144000000 })] });
    await toolMap.get("get_transfers")!.handler({ id: 8295, entity_type: "team" });
    await toolMap.get("get_transfers")!.handler({ id: 14685113, entity_type: "player" });
    const parsed = parseToolJson(await toolMap.get("get_transfers")!.handler({ timeframe: "latest", type: "rumour" }));
    expect(parsed.data[0]).toMatchObject({ type: "rumour", fee: 144000000 });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe("/v3/football/transfers/teams/8295");
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe("/v3/football/transfers/players/14685113");
    expect(new URL(fetchMock.mock.calls[2][0]).pathname).toBe("/v3/football/transfer-rumours");
  });

  it("get_transfers queries a date range and caps at 25", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => transferRow({ id: 1000 + i }));
    globalThis.fetch = mockFetchJson({ data: rows, pagination: { has_more: true } });
    const parsed = parseToolJson(await toolMap.get("get_transfers")!.handler({ timeframe: "date_range", start_date: "2026-01-01", end_date: "2026-01-31" }));
    expect(parsed.data).toHaveLength(MAX_TRANSFER_RESULTS);
    expect(parsed.meta).toMatchObject({ returned: 25, cap: 25, possibly_more: true });
    expect(new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).pathname).toBe("/v3/football/transfers/between/2026-01-01/2026-01-31");
  });

  it("get_transfers surfaces a subscription error when rumours are not covered", async () => {
    globalThis.fetch = mockFetchJson({ status: 403, data: { message: "no access", code: 5007 } });
    await expect(
      toolMap.get("get_transfers")!.handler({ timeframe: "latest", type: "rumour" }),
    ).rejects.toMatchObject({
      kind: "authentication_error",
      message: expect.stringContaining("transfer rumours add-on"),
      howToFix: expect.stringContaining("type='confirmed'"),
    });
  });
});

describe("Validation", () => {
  it("rejects empty search queries", async () => {
    await expect(toolMap.get("search")!.handler({ query: "" })).rejects.toThrow(
      "The 'query' field is required",
    );
  });

  it("rejects invalid timeframes", async () => {
    await expect(
      toolMap.get("get_matches")!.handler({ id: 14, type: "team", timeframe: "tomorrow" }),
    ).rejects.toThrow("Invalid 'timeframe' value");
  });

  it("rejects invalid fixture detail includes", async () => {
    await expect(
      toolMap.get("get_fixture_details")!.handler({ fixture_id: 1, includes: ["formations"] }),
    ).rejects.toThrow("Invalid 'includes' value");
  });

  it("rejects get_topscorers limits above the maximum", async () => {
    await expect(
      toolMap.get("get_topscorers")!.handler({ season_id: 2024, type: "goals", limit: 26 }),
    ).rejects.toThrow("must be less than or equal to 25");
  });

  it("rejects invalid standings ids", async () => {
    await expect(toolMap.get("get_standings")!.handler({ id: 0 })).rejects.toThrow(
      "The 'id' field must be a positive integer",
    );
  });

  it("rejects missing or invalid get_coach ids", async () => {
    await expect(toolMap.get("get_coach")!.handler({})).rejects.toThrow("The 'id' field must be a positive integer");
    await expect(toolMap.get("get_coach")!.handler({ id: 0 })).rejects.toThrow("The 'id' field must be a positive integer");
  });

  it("rejects an unsupported search type", async () => {
    await expect(toolMap.get("search")!.handler({ query: "x", type: "stadium" })).rejects.toThrow("Invalid 'type' value");
  });

  it("rejects missing/invalid get_odds fields and limits above the maximum", async () => {
    await expect(toolMap.get("get_odds")!.handler({})).rejects.toThrow("The 'fixture_id' field must be a positive integer");
    await expect(toolMap.get("get_odds")!.handler({ fixture_id: 1, type: "inplay" })).rejects.toThrow("Invalid 'type' value");
    await expect(toolMap.get("get_odds")!.handler({ fixture_id: 1, limit: MAX_ODDS_RESULTS + 1 })).rejects.toThrow(`must be less than or equal to ${MAX_ODDS_RESULTS}`);
  });

  it("rejects missing/invalid get_season_stats fields", async () => {
    await expect(toolMap.get("get_season_stats")!.handler({ entity_type: "player", season_id: 25583 })).rejects.toThrow("The 'entity_id' field must be a positive integer");
    await expect(toolMap.get("get_season_stats")!.handler({ entity_id: 1, entity_type: "league", season_id: 25583 })).rejects.toThrow("Invalid 'entity_type' value");
    await expect(toolMap.get("get_season_stats")!.handler({ entity_id: 1, entity_type: "player" })).rejects.toThrow("The 'season_id' field must be a positive integer");
    await expect(toolMap.get("get_season_stats")!.handler({ entity_id: 1, entity_type: "player", season_id: 1, stat_types: [] })).rejects.toThrow("must be a non-empty array");
  });

  it("rejects missing/invalid get_fixture_lineup_stats fields", async () => {
    await expect(toolMap.get("get_fixture_lineup_stats")!.handler({})).rejects.toThrow("The 'fixture_id' field must be a positive integer");
    await expect(toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 1, player_ids: [] })).rejects.toThrow("must be a non-empty array of positive integers");
    await expect(toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 1, player_ids: [1, "x"] })).rejects.toThrow("entry at index 1 must be a positive integer");
    await expect(toolMap.get("get_fixture_lineup_stats")!.handler({ fixture_id: 1, stat_types: [] })).rejects.toThrow("must be a non-empty array of stat type names");
  });

  it("rejects missing/invalid get_pressure_index fields", async () => {
    await expect(toolMap.get("get_pressure_index")!.handler({})).rejects.toThrow("The 'fixture_id' field must be a positive integer");
    await expect(toolMap.get("get_pressure_index")!.handler({ fixture_id: 1, mode: "graph" })).rejects.toThrow("Invalid 'mode' value");
  });

  it("rejects get_transfers when id lacks entity_type, when neither id nor timeframe given, and bad date ranges", async () => {
    await expect(toolMap.get("get_transfers")!.handler({ id: 8295 })).rejects.toThrow("The 'entity_type' field is required when 'id' is provided");
    await expect(toolMap.get("get_transfers")!.handler({})).rejects.toThrow("Provide either an id (with entity_type) or a timeframe");
    await expect(toolMap.get("get_transfers")!.handler({ type: "confirmed" })).rejects.toThrow("Provide either an id (with entity_type) or a timeframe");
    await expect(toolMap.get("get_transfers")!.handler({ timeframe: "date_range", start_date: "2026-01-01", end_date: "2026-02-02" })).rejects.toThrow("must not exceed 31 days");
    await expect(toolMap.get("get_transfers")!.handler({ timeframe: "date_range", start_date: "2026-03-01", end_date: "2026-01-01" })).rejects.toThrow("must be on or after");
    await expect(toolMap.get("get_transfers")!.handler({ timeframe: "date_range", start_date: "2026-01-01" })).rejects.toThrow("The 'end_date' field must be a date in YYYY-MM-DD format");
    await expect(toolMap.get("get_transfers")!.handler({ timeframe: "date_range", start_date: "01-01-2026", end_date: "2026-03-01" })).rejects.toThrow("The 'start_date' field must be a date in YYYY-MM-DD format");
    // id + date_range can't be served (no date-scoped team/player endpoint) → rejected, not silently ignored.
    await expect(
      toolMap.get("get_transfers")!.handler({ id: 8295, entity_type: "team", timeframe: "date_range", start_date: "2026-01-01", end_date: "2026-01-15" }),
    ).rejects.toThrow("A date range cannot be combined with an id");
  });
});

describe("Resources", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists the documentation and openapi resources", () => {
    expect(resources).toEqual([
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
    ]);
  });

  it("returns the documentation overview text", async () => {
    const resource = await readResource("sportmonks://documentation");
    expect(resource.contents[0].text).toBe(DOCUMENTATION_RESOURCE_TEXT);
  });

  it("fetches the OpenAPI spec lazily on read", async () => {
    const spec = { openapi: "3.0.3", info: { title: "Test" } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(spec),
      text: () => Promise.resolve(JSON.stringify(spec)),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const resource = await readResource("sportmonks://openapi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe("https://vercel-eight-cyan-93.vercel.app/openapi_spec.json");
    expect(resource.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(resource.contents[0].text as string)).toEqual(spec);
  });

  it("wraps upstream failures as upstream_error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    }) as unknown as typeof globalThis.fetch;

    await expect(readResource("sportmonks://openapi")).rejects.toThrow("HTTP 502");
  });

  it("rejects unknown resource URIs", async () => {
    await expect(readResource("sportmonks://unknown")).rejects.toThrow("Unknown resource");
  });
});

describe("Prompt Registry", () => {
  it("registers the three prompts", () => {
    expect(prompts).toHaveLength(3);
    expect(prompts.map((p) => p.name)).toEqual([
      "match_preview",
      "team_overview",
      "league_overview",
    ]);
  });

  it("declares required arguments on each prompt", () => {
    expect(promptMap.get("match_preview")?.arguments).toEqual([
      { name: "fixture_id", description: expect.any(String), required: true },
    ]);
    expect(promptMap.get("team_overview")?.arguments).toEqual([
      { name: "team_id", description: expect.any(String), required: true },
    ]);
    expect(promptMap.get("league_overview")?.arguments).toEqual([
      { name: "league_id", description: expect.any(String), required: true },
    ]);
  });
});

describe("Prompt Handlers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("match_preview returns fixture info and h2h in a user message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T10:00:00"));

    globalThis.fetch = mockFetchJson(
      {
        data: {
          id: 18535517,
          starting_at: "2026-04-09 11:30:00",
          state_id: 1,
          participants: [
            { id: 53, name: "Celtic", meta: { location: "home" } },
            { id: 62, name: "Rangers", meta: { location: "away" } },
          ],
        },
      },
      {
        data: [
          {
            id: 999,
            starting_at: "2026-03-01 12:00:00",
            result_info: "Celtic won",
            participants: [
              { id: 53, name: "Celtic", meta: { location: "home" } },
              { id: 62, name: "Rangers", meta: { location: "away" } },
            ],
            scores: [
              { participant_id: 53, description: "CURRENT", score: { goals: 2 } },
              { participant_id: 62, description: "CURRENT", score: { goals: 1 } },
            ],
          },
        ],
      },
    );

    const result = await getPrompt("match_preview", { fixture_id: "18535517" });
    const text = result.messages[0].content.text;

    expect(result.messages[0].role).toBe("user");
    expect(result.description).toContain("Celtic");
    expect(text).toContain("Do not invent facts");
    expect(text).toContain("Celtic vs Rangers");
    expect(text).toContain("2026-04-09 11:30:00");
    expect(text).toContain("Head-to-Head");
    expect(text).toContain("2-1");
    expect(text).toContain("Celtic won");
  });

  it("team_overview returns entity, matches, and standings in a user message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T10:00:00"));

    globalThis.fetch = mockFetchJson(
      // fetchEntity → GET /teams/14
      {
        data: {
          id: 14,
          name: "Arsenal",
          country: { name: "England" },
          venue: { name: "Emirates Stadium" },
        },
      },
      // fetchMatches → entity reference GET /teams/14
      { data: { id: 14, name: "Arsenal" } },
      // fetchMatches → GET /fixtures/between/...
      {
        data: [
          {
            id: 1001,
            starting_at: "2026-04-10 19:00:00",
            state_id: 1,
            league: { id: 8, name: "Premier League" },
            participants: [
              { id: 14, name: "Arsenal", meta: { location: "home" } },
              { id: 65, name: "Chelsea", meta: { location: "away" } },
            ],
          },
        ],
      },
      // fetchStandings → entity reference GET /leagues/8
      { data: { id: 8, name: "Premier League" } },
      // fetchStandings → GET /standings/live/leagues/8
      {
        data: [
          {
            position: 1,
            points: 80,
            participant: { id: 14, name: "Arsenal" },
            details: [
              { type_id: 129, value: 32 },
              { type_id: 130, value: 26 },
              { type_id: 131, value: 2 },
              { type_id: 132, value: 4 },
              { type_id: 179, value: 45 },
              { type_id: 187, value: 80 },
            ],
          },
        ],
      },
    );

    const result = await getPrompt("team_overview", { team_id: "14" });
    const text = result.messages[0].content.text;

    expect(result.messages[0].role).toBe("user");
    expect(result.description).toContain("Arsenal");
    expect(text).toContain("Do not invent facts");
    expect(text).toContain("Team: Arsenal");
    expect(text).toContain("Emirates Stadium");
    expect(text).toContain("Arsenal vs Chelsea");
    expect(text).toContain("League Standing");
    expect(text).toContain("Pts:80");
  });

  it("league_overview returns entity, standings, and matches in a user message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T10:00:00"));

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      let data: unknown;

      if (path.includes("/standings/live/leagues/")) {
        data = [
          {
            position: 1,
            points: 80,
            participant: { id: 53, name: "Celtic" },
            details: [
              { type_id: 129, value: 32 },
              { type_id: 130, value: 26 },
              { type_id: 131, value: 2 },
              { type_id: 132, value: 4 },
              { type_id: 179, value: 45 },
              { type_id: 187, value: 80 },
            ],
          },
        ];
      } else if (path.includes("/fixtures/between/")) {
        data = [
          {
            id: 2001,
            starting_at: "2026-04-10 16:00:00",
            state_id: 1,
            league: { id: 501, name: "Premiership" },
            participants: [
              { id: 53, name: "Celtic", meta: { location: "home" } },
              { id: 62, name: "Rangers", meta: { location: "away" } },
            ],
          },
        ];
      } else {
        data = { id: 501, name: "Premiership", country: { name: "Scotland" } };
      }

      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data }),
        text: () => Promise.resolve(JSON.stringify({ data })),
      };
    });

    const result = await getPrompt("league_overview", { league_id: "501" });
    const text = result.messages[0].content.text;

    expect(result.messages[0].role).toBe("user");
    expect(result.description).toContain("Premiership");
    expect(text).toContain("Do not invent facts");
    expect(text).toContain("League: Premiership");
    expect(text).toContain("Scotland");
    expect(text).toContain("1. Celtic");
    expect(text).toContain("Pts:80");
    expect(text).toContain("Celtic vs Rangers");
  });

  it("rejects unknown prompt names", async () => {
    await expect(getPrompt("nonexistent", {})).rejects.toThrow("Unknown prompt");
  });

  it("validates prompt arguments", async () => {
    await expect(getPrompt("match_preview", { fixture_id: "abc" })).rejects.toThrow(
      "must be a positive integer",
    );
  });
});
