import { describe, expect, it } from "vitest";
import { PinarcApiError, createPinarcApi } from "../src/index.js";

const fetchMock = (routes: Record<string, unknown | number>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const key = u.pathname + (u.search || "");
    const hit = routes[key];
    if (hit === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    if (typeof hit === "number") return new Response(JSON.stringify({ error: "nope" }), { status: hit });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("api client", () => {
  const api = createPinarcApi({
    baseUrl: "https://dapp.pinarc.io/api/v1/",
    fetch: fetchMock({
      "/api/v1/health": { ok: true, ts: 1 },
      "/api/v1/tokens?tab=new&limit=5": { tokens: [{ address: "0x1", symbol: "ROBIN" }] },
      "/api/v1/tokens/0x1/trades?limit=2": { trades: [{ side: "buy" }, { side: "sell" }] },
      "/api/v1/tokens/0x1/candles?tf=1h": { tf: "1h", candles: [], price: 0.1, status: "live" },
      "/api/v1/metadata/abc.json": { name: "Robin", symbol: "ROBIN" },
      "/api/v1/tokens/0xdead": 404,
    }),
  });
  it("strips the trailing slash and builds query strings", async () => {
    expect(api.baseUrl).toBe("https://dapp.pinarc.io/api/v1");
    expect((await api.health()).ok).toBe(true);
    expect((await api.tokens({ tab: "new", limit: 5 }))[0]!.symbol).toBe("ROBIN");
    expect((await api.trades("0x1", 2)).length).toBe(2);
    expect((await api.candles("0x1", { tf: "1h" })).status).toBe("live");
    expect((await api.metadata("abc")).symbol).toBe("ROBIN");
  });
  it("throws a typed error with the status", async () => {
    await expect(api.token("0xdead")).rejects.toBeInstanceOf(PinarcApiError);
    await expect(api.token("0xdead")).rejects.toMatchObject({ status: 404 });
  });
});
