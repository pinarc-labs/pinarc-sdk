/**
 * The Pinarc bonding curve, in TypeScript, with the same integer arithmetic as `BondingCurve.sol`
 * (constant product on virtual reserves, ceil-division where the contract uses `Math.ceilDiv`).
 * All amounts are bigint base units: USDG has 6 decimals, tokens 18, prices are 18-decimal USDG per whole token.
 */

export const BPS = 10_000n;
const PRICE_SCALE = 10n ** 30n; // 6-dec USDG per 1e18 tokens → 18-dec price

/** Ceil division for positive integers, as OpenZeppelin's `Math.ceilDiv`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a === 0n) return 0n;
  return (a - 1n) / b + 1n;
}

/** Everything the maths needs from a curve; read it with `readCurveState` or build it with `initialState`. */
export type CurveState = {
  virtualUsdg: bigint;
  virtualTokens: bigint;
  /** Curve supply after the team allocation was taken out (what the contract stores). */
  curveSupply: bigint;
  usdgRaised: bigint;
  tokensSold: bigint;
  tradeFeeBps: bigint | number;
};

export type LaunchParams = {
  virtualTokens: bigint;
  curveSupply: bigint;
  lpSupply: bigint;
  graduationUsdg: bigint;
  teamAllocation?: bigint;
  tradeFeeBps: bigint | number;
};

/** Platform defaults (PinarcConfig on mainnet since block 65,558,085, 2026-09-18: graduation lowered from 12,400 to 2,500 USDG). */
export const DEFAULT_LAUNCH_PARAMS: LaunchParams = {
  virtualTokens: 1_073_000_000n * 10n ** 18n,
  curveSupply: 800_000_000n * 10n ** 18n,
  lpSupply: 200_000_000n * 10n ** 18n,
  graduationUsdg: 2_500n * 10n ** 6n,
  teamAllocation: 0n,
  tradeFeeBps: 100,
};

/**
 * State of a fresh curve. The team allocation comes out of the curve supply and the virtual USDG reserve is
 * derived so the raise at sell-out is always `graduationUsdg` (see `BondingCurve.initialize`).
 */
export function initialState(p: LaunchParams): CurveState {
  const supplyOnCurve = p.curveSupply - (p.teamAllocation ?? 0n);
  if (supplyOnCurve <= 0n || p.virtualTokens <= supplyOnCurve) throw new Error("virtualTokens must exceed the curve supply");
  return {
    virtualUsdg: (p.graduationUsdg * (p.virtualTokens - supplyOnCurve)) / supplyOnCurve,
    virtualTokens: p.virtualTokens,
    curveSupply: supplyOnCurve,
    usdgRaised: 0n,
    tokensSold: 0n,
    tradeFeeBps: p.tradeFeeBps,
  };
}

export function reserves(s: CurveState): { u: bigint; t: bigint } {
  return { u: s.virtualUsdg + s.usdgRaised, t: s.virtualTokens - s.tokensSold };
}

/** Spot price, 18-decimal USDG per whole token (`BondingCurve.price`). */
export function price18(s: CurveState): bigint {
  const { u, t } = reserves(s);
  return (u * PRICE_SCALE) / t;
}

/** Progress toward graduation in bps (`BondingCurve.progressBps`). */
export function progressBps(s: CurveState): bigint {
  return (s.tokensSold * BPS) / s.curveSupply;
}

export function remainingSupply(s: CurveState): bigint {
  return s.curveSupply - s.tokensSold;
}

/** `_quoteBuy`: tokens out for `net` USDG (fee already removed), capped at the remaining supply. */
export function quoteBuyNet(s: CurveState, net: bigint): { tokensOut: bigint; usdgUsed: bigint } {
  const { u, t } = reserves(s);
  const k = u * t;
  const remaining = remainingSupply(s);
  let tokensOut = t - ceilDiv(k, u + net);
  let usdgUsed: bigint;
  if (tokensOut >= remaining) {
    tokensOut = remaining;
    usdgUsed = ceilDiv(k, t - remaining) - u;
    if (usdgUsed > net) usdgUsed = net;
  } else {
    usdgUsed = net;
  }
  return { tokensOut, usdgUsed };
}

export type BuyQuote = {
  tokensOut: bigint;
  /** USDG that moved onto the curve (excludes the fee). */
  usdgUsed: bigint;
  fee: bigint;
  /** USDG the caller keeps because the curve sold out (`usdgIn - usdgUsed - fee`). */
  refund: bigint;
  /** Effective price paid, 18-decimal. */
  executionPrice18: bigint;
  /** Spot price after the buy. */
  priceAfter18: bigint;
  /** (executionPrice / spotBefore - 1) in bps. */
  priceImpactBps: bigint;
  graduates: boolean;
};

/** `BondingCurve.quoteBuy` plus the derived numbers the app shows. Fee is charged on the USDG actually used. */
export function quoteBuy(s: CurveState, usdgIn: bigint): BuyQuote {
  if (usdgIn <= 0n) throw new Error("usdgIn must be positive");
  const feeBps = BigInt(s.tradeFeeBps);
  let fee = (usdgIn * feeBps) / BPS;
  const { tokensOut, usdgUsed } = quoteBuyNet(s, usdgIn - fee);
  if (usdgUsed < usdgIn - fee) fee = (usdgUsed * feeBps) / (BPS - feeBps);
  const after = applyBuy(s, { tokensOut, usdgUsed });
  const spot = price18(s);
  const executionPrice18 = tokensOut > 0n ? (usdgUsed * PRICE_SCALE) / tokensOut : spot;
  return {
    tokensOut,
    usdgUsed,
    fee,
    refund: usdgIn - usdgUsed - fee,
    executionPrice18,
    priceAfter18: price18(after),
    priceImpactBps: spot > 0n ? ((executionPrice18 - spot) * BPS) / spot : 0n,
    graduates: after.tokensSold === s.curveSupply,
  };
}

/** `_quoteSell`: gross USDG for `tokensIn`, before the fee. */
export function quoteSellGross(s: CurveState, tokensIn: bigint): bigint {
  const { u, t } = reserves(s);
  return u - ceilDiv(u * t, t + tokensIn);
}

export type SellQuote = { usdgOut: bigint; fee: bigint; gross: bigint; executionPrice18: bigint; priceAfter18: bigint; priceImpactBps: bigint };

/** `BondingCurve.quoteSell` (fee deducted from the proceeds). Throws when selling more than was sold by the curve. */
export function quoteSell(s: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) throw new Error("tokensIn must be positive");
  if (tokensIn > s.tokensSold) throw new Error("tokensIn exceeds tokens sold on the curve");
  const gross = quoteSellGross(s, tokensIn);
  const fee = (gross * BigInt(s.tradeFeeBps)) / BPS;
  const usdgOut = gross - fee;
  const spot = price18(s);
  const executionPrice18 = (gross * PRICE_SCALE) / tokensIn;
  return { usdgOut, fee, gross, executionPrice18, priceAfter18: price18(applySell(s, { tokensIn, gross })), priceImpactBps: spot > 0n ? ((spot - executionPrice18) * BPS) / spot : 0n };
}

export function applyBuy(s: CurveState, q: { tokensOut: bigint; usdgUsed: bigint }): CurveState {
  return { ...s, usdgRaised: s.usdgRaised + q.usdgUsed, tokensSold: s.tokensSold + q.tokensOut };
}

export function applySell(s: CurveState, q: { tokensIn: bigint; gross: bigint }): CurveState {
  return { ...s, usdgRaised: s.usdgRaised - q.gross, tokensSold: s.tokensSold - q.tokensIn };
}

export type BatchSettlement = { usdgUsed: bigint; tokensOut: bigint; fee: bigint; refund: bigint; clearingPrice18: bigint; graduates: boolean };

/** `_settleBatch`: fill the whole batch at one clearing price; refund pro-rata when the batch alone sells out the curve. */
export function settleBatch(s: CurveState, batchUsdg: bigint): BatchSettlement {
  if (batchUsdg === 0n) return { usdgUsed: 0n, tokensOut: 0n, fee: 0n, refund: 0n, clearingPrice18: price18(s), graduates: false };
  const feeBps = BigInt(s.tradeFeeBps);
  let fee = (batchUsdg * feeBps) / BPS;
  const { tokensOut, usdgUsed } = quoteBuyNet(s, batchUsdg - fee);
  if (usdgUsed < batchUsdg - fee) fee = (usdgUsed * feeBps) / (BPS - feeBps);
  const refund = batchUsdg - usdgUsed - fee;
  return { usdgUsed, tokensOut, fee, refund, clearingPrice18: (usdgUsed * PRICE_SCALE) / tokensOut, graduates: s.tokensSold + tokensOut === s.curveSupply };
}

/** `claimBatch`: a committer's share of the settled batch. */
export function claimShare(settled: { tokensOut: bigint; refund: bigint }, batchUsdg: bigint, committed: bigint): { tokensOut: bigint; refund: bigint } {
  if (batchUsdg === 0n || committed === 0n) return { tokensOut: 0n, refund: 0n };
  return { tokensOut: (settled.tokensOut * committed) / batchUsdg, refund: (settled.refund * committed) / batchUsdg };
}

/** Trade-fee split (`_payFees`): creator share first, remainder to the treasury. */
export function splitFee(fee: bigint, creatorShareBps: bigint | number): { toCreator: bigint; toTreasury: bigint } {
  const toCreator = (fee * BigInt(creatorShareBps)) / BPS;
  return { toCreator, toTreasury: fee - toCreator };
}

export type GraduationPlan = {
  /** USDG raised at sell-out (equals `graduationUsdg` when nothing was sold back). */
  raised: bigint;
  graduationFee: bigint;
  floorUsdg: bigint;
  liquidityUsdg: bigint;
  liquidityTokens: bigint;
  /** Spot price at the top of the curve, 18-decimal. */
  priceAtGraduation18: bigint;
  /** Fully diluted market cap at that price, in USDG base units (6 decimals). */
  marketCapUsdg: bigint;
  /** Opening price of the Uniswap pool = liquidityUsdg / liquidityTokens, 18-decimal. */
  poolPrice18: bigint;
  /** Redeemable floor per whole token right after graduation, 18-decimal (`FloorReserve.floorPrice`). */
  floorPrice18: bigint;
};

/** `_graduate` numbers for a curve that just sold out (or a plan for a fresh launch when `state` is initial). */
export function graduationPlan(
  s: CurveState,
  p: { graduationFeeBps: bigint | number; floorBps: bigint | number; lpSupply: bigint; totalSupply: bigint },
): GraduationPlan {
  const full: CurveState = { ...s, tokensSold: s.curveSupply, usdgRaised: s.usdgRaised + quoteBuyNet(s, 2n ** 120n).usdgUsed };
  const raised = full.usdgRaised;
  const graduationFee = (raised * BigInt(p.graduationFeeBps)) / BPS;
  const floorUsdg = (raised * BigInt(p.floorBps)) / BPS;
  const liquidityUsdg = raised - graduationFee - floorUsdg;
  const liquidityTokens = p.lpSupply;
  const priceAtGraduation18 = price18(full);
  return {
    raised,
    graduationFee,
    floorUsdg,
    liquidityUsdg,
    liquidityTokens,
    priceAtGraduation18,
    marketCapUsdg: (priceAtGraduation18 * p.totalSupply) / PRICE_SCALE,
    poolPrice18: liquidityTokens > 0n ? (liquidityUsdg * PRICE_SCALE) / liquidityTokens : 0n,
    floorPrice18: p.totalSupply > 0n ? (floorUsdg * PRICE_SCALE) / p.totalSupply : 0n,
  };
}

/** Market cap of the whole supply at the current spot price, in USDG base units. */
export function marketCapUsdg(s: CurveState, totalSupply: bigint): bigint {
  return (price18(s) * totalSupply) / PRICE_SCALE;
}

/** USDG needed (fee included) to buy exactly `tokensOut` from the current state; null if more than remains. */
export function usdgForTokens(s: CurveState, tokensOut: bigint): { usdgIn: bigint; usdgUsed: bigint; fee: bigint } | null {
  if (tokensOut <= 0n || tokensOut > remainingSupply(s)) return null;
  const { u, t } = reserves(s);
  const usdgUsed = ceilDiv(u * t, t - tokensOut) - u;
  const feeBps = BigInt(s.tradeFeeBps);
  // fee is taken from the gross input: net = in - in*fee/BPS → in = ceil(net * BPS / (BPS - fee))
  const usdgIn = ceilDiv(usdgUsed * BPS, BPS - feeBps);
  return { usdgIn, usdgUsed, fee: usdgIn - usdgUsed };
}
