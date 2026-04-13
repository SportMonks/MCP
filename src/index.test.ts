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
      { id: 129, code: "overall-matches-played", developer_name: "overall-matches-played" },
      { id: 130, code: "overall-won", developer_name: "overall-won" },
      { id: 131, code: "overall-draw", developer_name: "overall-draw" },
      { id: 132, code: "overall-lost", developer_name: "overall-lost" },
      { id: 133, code: "overall-goals-for", developer_name: "overall-goals-for" },
      { id: 134, code: "overall-conceded", developer_name: "overall-conceded" },
      { id: 179, code: "goal-difference", developer_name: "goal-difference" },
      { id: 187, code: "overall-points", developer_name: "overall-points" },
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
    "get_entity",
    "get_matches",
    "get_match_preview",
    "get_standings",
  ];

  it("registers only the five requested tools", () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((tool) => tool.name)).toEqual(expectedTools);
  });

  it("uses typed input schemas and the expected required fields", () => {
    expect(toolMap.get("search")?.inputSchema.required).toEqual(["query"]);
    expect(toolMap.get("get_entity")?.inputSchema.required).toEqual(["id", "type"]);
    expect(toolMap.get("get_matches")?.inputSchema.required).toEqual(["id", "type"]);
    expect(toolMap.get("get_match_preview")?.inputSchema.required).toEqual(["id"]);
    expect(toolMap.get("get_standings")?.inputSchema.required).toEqual(["id"]);

    expect(toolMap.get("get_entity")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_matches")?.inputSchema.properties.id).toMatchObject({ type: "integer" });
    expect(toolMap.get("get_match_preview")?.inputSchema.properties.id).toMatchObject({
      type: "integer",
    });
    expect(toolMap.get("get_standings")?.inputSchema.properties.id).toMatchObject({
      type: "integer",
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

  it("search defaults to all entity types and caps results at 10", async () => {
    globalThis.fetch = mockFetchJson(
      {
        data: [{ id: 2, name: "Zed Player" }],
      },
      {
        data: [{ id: 3, name: "Arsenal" }],
      },
      {
        data: [{ id: 1, name: "Premier League" }],
      },
    );

    const result = await toolMap.get("search")!.handler({ query: "ars" });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual([
      { id: 3, entity_type: "team", name: "Arsenal" },
      { id: 1, entity_type: "league", name: "Premier League" },
      { id: 2, entity_type: "player", name: "Zed Player" },
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    const firstUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(firstUrl.pathname).toBe("/v3/football/players/search/ars");
    expect(firstUrl.searchParams.get("per_page")).toBe(String(MAX_SEARCH_RESULTS));
  });

  it("search uses a single exact endpoint when a specific type is provided", async () => {
    globalThis.fetch = mockFetchJson({
      data: [{ id: 14, name: "Arsenal" }],
    });

    const result = await toolMap.get("search")!.handler({ query: "Arsenal", type: "team" });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual([{ id: 14, entity_type: "team", name: "Arsenal" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const calledUrl = new URL((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/v3/football/teams/search/Arsenal");
  });

  it("get_entity returns the requested player summary using the two-step player and team lookup", async () => {
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

    const result = await toolMap.get("get_entity")!.handler({ id: 758, type: "player" });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 758,
      name: "James Tavernier",
      position: "Right Back",
      nationality: "England",
      date_of_birth: "1991-10-31",
      current_team: { id: 62, name: "Rangers" },
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const playerUrl = new URL(fetchMock.mock.calls[0][0]);
    const teamUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(playerUrl.pathname).toBe("/v3/football/players/758");
    expect(playerUrl.searchParams.get("include")).toBe("position;nationality;teams");
    expect(teamUrl.pathname).toBe("/v3/football/teams/62");
  });

  it("get_entity returns the requested team summary without league data", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 14,
        name: "Arsenal",
        country: { name: "England" },
        venue: { name: "Emirates Stadium" },
      },
    });

    const result = await toolMap.get("get_entity")!.handler({ id: 14, type: "team" });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 14,
      name: "Arsenal",
      country: "England",
      venue: "Emirates Stadium",
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const teamUrl = new URL(fetchMock.mock.calls[0][0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(teamUrl.pathname).toBe("/v3/football/teams/14");
    expect(teamUrl.searchParams.get("include")).toBe("venue;country");
  });

  it("get_entity returns the requested league summary", async () => {
    globalThis.fetch = mockFetchJson({
      data: {
        id: 501,
        name: "Premiership",
        country: { name: "Scotland" },
      },
    });

    const result = await toolMap.get("get_entity")!.handler({ id: 501, type: "league" });
    const parsed = parseToolJson(result);

    expect(parsed).toEqual({
      id: 501,
      name: "Premiership",
      country: "Scotland",
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const leagueUrl = new URL(fetchMock.mock.calls[0][0]);

    expect(leagueUrl.pathname).toBe("/v3/football/leagues/501");
    expect(leagueUrl.searchParams.get("include")).toBe("country");
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

    expect(parsed).toEqual([
      {
        id: 1001,
        home_team: "Arsenal",
        away_team: "Chelsea",
        starting_at: "2026-04-10 19:00:00",
        state: "NS",
        league: { id: 8, name: "Premier League" },
      },
    ]);

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

    expect(parsed).toEqual([
      {
        id: 2001,
        home_team: "Celtic",
        away_team: "Rangers",
        starting_at: "2026-04-08 16:00:00",
        state: "LIVE",
        league: { id: 501, name: "Premiership" },
      },
    ]);

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

    expect(parsed).toEqual([
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

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const standingsUrl = new URL(fetchMock.mock.calls[1][0]);

    expect(standingsUrl.pathname).toBe("/v3/football/standings/live/leagues/501");
    expect(standingsUrl.searchParams.get("include")).toBe("participant;details");
  });
});

describe("Validation", () => {
  it("rejects empty search queries", async () => {
    await expect(toolMap.get("search")!.handler({ query: "" })).rejects.toThrow(
      "The 'query' field is required",
    );
  });

  it("rejects invalid entity types", async () => {
    await expect(toolMap.get("get_entity")!.handler({ id: 1, type: "coach" })).rejects.toThrow(
      "Invalid 'type' value",
    );
  });

  it("rejects invalid timeframes", async () => {
    await expect(
      toolMap.get("get_matches")!.handler({ id: 14, type: "team", timeframe: "tomorrow" }),
    ).rejects.toThrow("Invalid 'timeframe' value");
  });

  it("rejects invalid standings ids", async () => {
    await expect(toolMap.get("get_standings")!.handler({ id: 0 })).rejects.toThrow(
      "The 'id' field must be a positive integer",
    );
  });
});

describe("Resources", () => {
  it("lists the documentation resource", () => {
    expect(resources).toEqual([
      {
        uri: "sportmonks://documentation",
        name: "Sportmonks Football MCP Overview",
        description: "Overview of the five-tool Sportmonks football MCP server.",
        mimeType: "text/plain",
      },
    ]);
  });

  it("returns the documentation overview text", async () => {
    const resource = await readResource("sportmonks://documentation");
    expect(resource.contents[0].text).toBe(DOCUMENTATION_RESOURCE_TEXT);
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
