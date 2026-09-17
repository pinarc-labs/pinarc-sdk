import { describe, expect, it } from "vitest";
import { BPS, DEFAULT_LAUNCH_PARAMS, applyBuy, applySell, claimShare, graduationPlan, initialState, marketCapUsdg, price18, progressBps, quoteBuy, quoteSell, settleBatch, splitFee, usdgForTokens } from "../src/index.js";

const USDG = (n: number) => BigInt(Math.round(n * 1e6));
const WAD = 10n ** 18n;
const P = DEFAULT_LAUNCH_PARAMS;
const TOTAL_SUPPLY = P.curveSupply + P.lpSupply;

describe("initialState", () => {
  it("derives the virtual USDG reserve so the raise at sell-out is graduationUsdg", () => {
    const s = initialState(P);
    // 2,500 × (1,073M − 800M) / 800M = 853.125 USDG
    expect(s.virtualUsdg).toBe(USDG(853.125));
    expect(s.curveSupply).toBe(P.curveSupply);
    // buying everything costs exactly the graduation raise (net of fees)
    const q = quoteBuy(s, USDG(1_000_000));
    expect(q.usdgUsed).toBe(P.graduationUsdg);
    expect(q.tokensOut).toBe(P.curveSupply);
    expect(q.graduates).toBe(true);
    expect(q.refund).toBe(USDG(1_000_000) - q.usdgUsed - q.fee);
    // fee on a sell-out is charged on what was used: 2,500 × 1% / 99% ≈ 25.25
    expect(q.fee).toBe((P.graduationUsdg * 100n) / (BPS - 100n));
  });
  it("takes the team allocation out of the curve and keeps the raise constant", () => {
    const team = 50_000_000n * WAD; // 5% of supply
    const s = initialState({ ...P, teamAllocation: team });
    expect(s.curveSupply).toBe(P.curveSupply - team);
    // integer division on the derived virtual reserve can leave the raise one base unit (0.000001 USDG) short
    expect(P.graduationUsdg - quoteBuy(s, USDG(1_000_000)).usdgUsed).toBeLessThanOrEqual(1n);
  });
  it("rejects impossible parameters", () => {
    expect(() => initialState({ ...P, virtualTokens: P.curveSupply })).toThrow();
  });
});

describe("prices and quotes", () => {
  const s = initialState(P);
  it("starts at virtualUsdg / virtualTokens", () => {
    // 853.125 USDG / 1,073M tokens = 0.000000795… USDG per token
    expect(price18(s)).toBe((USDG(853.125) * 10n ** 30n) / P.virtualTokens);
    expect(progressBps(s)).toBe(0n);
    expect(marketCapUsdg(s, TOTAL_SUPPLY)).toBe((price18(s) * TOTAL_SUPPLY) / 10n ** 30n);
  });
  it("a 100 USDG buy: 1% fee, tokens from the constant product, price and progress move", () => {
    const q = quoteBuy(s, USDG(100));
    expect(q.fee).toBe(USDG(1));
    expect(q.usdgUsed).toBe(USDG(99));
    expect(q.refund).toBe(0n);
    // tokensOut = t − ceil(k / (u + 99)) with u = 853.125, t = 1,073M
    const u = USDG(853.125), t = P.virtualTokens, k = u * t;
    const expected = t - ((k - 1n) / (u + USDG(99)) + 1n);
    expect(q.tokensOut).toBe(expected);
    expect(q.tokensOut).toBeGreaterThan(111_000_000n * WAD); // ≈ 111.6M tokens
    expect(q.tokensOut).toBeLessThan(112_000_000n * WAD);
    expect(q.priceAfter18).toBeGreaterThan(price18(s));
    expect(q.priceImpactBps).toBeGreaterThan(0n);
    // 99 USDG on an 853 USDG virtual reserve moves the average price by ~11.6%
    expect(q.priceImpactBps).toBeGreaterThan(1100n);
    expect(q.priceImpactBps).toBeLessThan(1200n);
    const after = applyBuy(s, q);
    expect(progressBps(after)).toBe((q.tokensOut * BPS) / P.curveSupply);
  });
  it("selling back what you bought returns less than you paid (fees + rounding), and restores the state", () => {
    const buy = quoteBuy(s, USDG(500));
    const after = applyBuy(s, buy);
    const sell = quoteSell(after, buy.tokensOut);
    expect(sell.gross).toBeLessThanOrEqual(buy.usdgUsed);
    expect(sell.usdgOut).toBeLessThan(USDG(500));
    expect(sell.fee).toBe((sell.gross * 100n) / BPS);
    const back = applySell(after, { tokensIn: buy.tokensOut, gross: sell.gross });
    expect(back.tokensSold).toBe(0n);
    expect(back.usdgRaised).toBeGreaterThanOrEqual(0n);
    expect(back.usdgRaised).toBeLessThan(USDG(0.01)); // rounding dust stays on the curve
  });
  it("price is monotonic over a sequence of buys", () => {
    let st = s, last = price18(st);
    for (let i = 0; i < 20; i++) {
      const q = quoteBuy(st, USDG(100)); // 2,000 USDG in total: stays below the 2,500 sell-out
      st = applyBuy(st, q);
      expect(price18(st)).toBeGreaterThan(last);
      last = price18(st);
    }
    expect(progressBps(st)).toBeGreaterThan(0n);
  });
  it("refuses to sell more than the curve sold", () => {
    expect(() => quoteSell(s, 1n)).toThrow();
    expect(() => quoteBuy(s, 0n)).toThrow();
  });
  it("usdgForTokens is the inverse of quoteBuy", () => {
    const want = 10_000_000n * WAD;
    const r = usdgForTokens(s, want)!;
    const q = quoteBuy(s, r.usdgIn);
    expect(q.tokensOut).toBeGreaterThanOrEqual(want);
    expect(q.tokensOut - want).toBeLessThan(want / 1_000_000n); // ceil-division rounding: a few wei per token
    expect(usdgForTokens(s, P.curveSupply + 1n)).toBeNull();
  });
});

describe("batch settlement", () => {
  const s = initialState(P);
  it("fills the whole batch at one clearing price and shares it pro-rata", () => {
    const batch = USDG(1_000);
    const r = settleBatch(s, batch);
    expect(r.fee).toBe(USDG(10));
    expect(r.usdgUsed).toBe(USDG(990));
    expect(r.refund).toBe(0n);
    expect(r.graduates).toBe(false);
    expect(r.clearingPrice18).toBe((r.usdgUsed * 10n ** 30n) / r.tokensOut);
    const a = claimShare(r, batch, USDG(750)), b = claimShare(r, batch, USDG(250));
    expect(a.tokensOut + b.tokensOut).toBeLessThanOrEqual(r.tokensOut);
    expect(r.tokensOut - (a.tokensOut + b.tokensOut)).toBeLessThan(2n);
    expect(a.tokensOut).toBe((r.tokensOut * 3n) / 4n);
  });
  it("a batch bigger than the curve sells it out and refunds the rest", () => {
    const batch = USDG(5_000);
    const r = settleBatch(s, batch);
    expect(r.usdgUsed).toBe(P.graduationUsdg);
    expect(r.tokensOut).toBe(P.curveSupply);
    expect(r.graduates).toBe(true);
    expect(r.fee).toBe((P.graduationUsdg * 100n) / (BPS - 100n));
    expect(r.refund).toBe(batch - r.usdgUsed - r.fee);
    expect(claimShare(r, batch, batch)).toEqual({ tokensOut: r.tokensOut, refund: r.refund });
  });
  it("an empty batch settles to nothing", () => {
    expect(settleBatch(s, 0n)).toMatchObject({ usdgUsed: 0n, tokensOut: 0n, refund: 0n, clearingPrice18: price18(s) });
    expect(claimShare({ tokensOut: 5n, refund: 5n }, 0n, 0n)).toEqual({ tokensOut: 0n, refund: 0n });
  });
});

describe("fees and graduation", () => {
  it("splits the trade fee 40/60 by default", () => {
    expect(splitFee(USDG(1), 4000)).toEqual({ toCreator: USDG(0.4), toTreasury: USDG(0.6) });
  });
  it("plans graduation: 2% fee, floor share, the rest paired with the LP supply", () => {
    const s = initialState(P);
    const g = graduationPlan(s, { graduationFeeBps: 200, floorBps: 1500, lpSupply: P.lpSupply, totalSupply: TOTAL_SUPPLY });
    expect(g.raised).toBe(P.graduationUsdg);
    expect(g.graduationFee).toBe(USDG(50));
    expect(g.floorUsdg).toBe(USDG(375));
    expect(g.liquidityUsdg).toBe(USDG(2_500 - 50 - 375));
    expect(g.liquidityTokens).toBe(P.lpSupply);
    // top-of-curve price: (853.125 + 2500) / (1073M − 800M) = 0.0000123… USDG
    expect(g.priceAtGraduation18).toBe(((USDG(853.125) + P.graduationUsdg) * 10n ** 30n) / (P.virtualTokens - P.curveSupply));
    expect(g.marketCapUsdg).toBe((g.priceAtGraduation18 * TOTAL_SUPPLY) / 10n ** 30n);
    expect(g.marketCapUsdg).toBeGreaterThan(USDG(12_200));
    expect(g.marketCapUsdg).toBeLessThan(USDG(12_300));
    expect(g.poolPrice18).toBe((g.liquidityUsdg * 10n ** 30n) / P.lpSupply);
    expect(g.floorPrice18).toBe((g.floorUsdg * 10n ** 30n) / TOTAL_SUPPLY);
  });
});
