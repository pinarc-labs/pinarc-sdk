/** Typed client for the public read-only API served by the Pinarc app (`https://dapp.pinarc.io/api/v1`). */

export type TokenStatus = "batch" | "live" | "graduated";
export type DiscoverTab = "trending" | "new" | "graduating" | "graduated";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** One indexed token; numbers are already in human units (USDG, whole tokens, unix seconds). */
export type ApiToken = {
  address: string; curve: string; creator: string; name: string; symbol: string;
  metadata_uri: string; description: string; image: string | null; website: string | null; x_url: string | null; telegram_url: string | null; color: string;
  status: TokenStatus; created_at: number; created_block: number; create_tx: string; batch_ends_at: number; anti_sniper_until: number;
  total_supply: number; curve_supply: number; lp_supply: number; virtual_tokens: number; graduation_usdg: number;
  trade_fee_bps: number; creator_share_bps: number; max_wallet: number; max_tx: number; cooldown_seconds: number;
  floor_bps: number; lp_lock_seconds: number; team_allocation: number; team_vesting_id: number | null;
  bond_usdg: number; bond_status: "none" | "active" | "released" | "slashed"; dev_buy_usdg: number;
  batch_usdg: number; batch_settled: number; batch_clearing_price: number | null; batch_tokens_out: number | null; batch_refund: number | null;
  price_usdg: number; usdg_raised: number; tokens_sold: number; curve_progress: number; mcap_usdg: number; liquidity_usdg: number;
  holders: number; volume_24h: number; buys_24h: number; sells_24h: number; change_1h: number | null; change_24h: number | null;
  top10_pct: number; creator_pct: number; creator_sold: number; creator_fees_usdg: number; floor_reserve_usdg: number; last_trade_at: number | null;
  graduated_at: number | null; pair: string | null; lp_lock_id: number | null; lp_burned: number; lp_usdg: number | null; lp_tokens: number | null;
};
export type ApiTrade = { tx_hash: string; log_index: number; token: string; block: number; ts: number; side: "buy" | "sell"; venue: "batch" | "curve" | "dex"; usdg: number; amount: number; price: number; fee: number; wallet: string };
export type ApiHolder = { token: string; wallet: string; amount: number };
export type ApiCandle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type ApiStats = Record<string, number | string | null> & { last_block?: number; synced_at?: number };
export type ApiHealth = { ok: boolean; chain?: string; last_block?: number; synced_at?: number; ts: number };
export type TokenMetadata = { name: string; symbol: string; description?: string; image?: string; website?: string; x?: string; telegram?: string };

export type PinarcApiOptions = { baseUrl?: string; fetch?: typeof globalThis.fetch; headers?: Record<string, string> };

export class PinarcApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); this.name = "PinarcApiError"; }
}

export const DEFAULT_API_URL = "https://dapp.pinarc.io/api/v1";

export function createPinarcApi(opts: PinarcApiOptions = {}) {
  const base = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const fetchFn = opts.fetch ?? globalThis.fetch;
  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const res = await fetchFn(`${base}${path}${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json", ...opts.headers } });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw new PinarcApiError(res.status, (body as { error?: string })?.error ?? `HTTP ${res.status}`, body);
    return body as T;
  }
  return {
    baseUrl: base,
    health: () => get<ApiHealth>("/health"),
    stats: () => get<ApiStats>("/stats"),
    /** Discovery feed; `limit` ≤ 200. */
    tokens: (q: { tab?: DiscoverTab; sort?: string; dir?: "asc" | "desc"; limit?: number } = {}) => get<{ tokens: ApiToken[] }>("/tokens", q).then((r) => r.tokens),
    /** One token with its latest 30 trades and top 50 holders. */
    token: (address: string) => get<{ token: ApiToken; trades: ApiTrade[]; holders: ApiHolder[] }>(`/tokens/${address}`),
    trades: (address: string, limit = 50) => get<{ trades: ApiTrade[] }>(`/tokens/${address}/trades`, { limit }).then((r) => r.trades),
    candles: (address: string, q: { tf?: Timeframe; limit?: number } = {}) => get<{ tf: Timeframe; candles: ApiCandle[]; price: number; status: TokenStatus }>(`/tokens/${address}/candles`, q),
    /** The metadata document a token's `metadataURI` points at (`<id>.json`). */
    metadata: (id: string) => get<TokenMetadata & { image?: string }>(`/metadata/${id.endsWith(".json") ? id : `${id}.json`}`),
  };
}

export type PinarcApi = ReturnType<typeof createPinarcApi>;
