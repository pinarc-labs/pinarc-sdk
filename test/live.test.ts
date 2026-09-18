import { describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
import { createFallbackTransport, robinhoodChain } from "@pinarc-labs/robinhood-chain-kit";
import { MAINNET, createPinarcApi, createPinarcClient, initialState, quoteBuy } from "../src/index.js";

// `pnpm test:live` — reads mainnet; skipped in CI.
describe.skipIf(!process.env.PINARC_LIVE)("live", () => {
  it("reads the config from mainnet and agrees with the local maths defaults", async () => {
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: createFallbackTransport() });
    const pinarc = createPinarcClient({ publicClient, addresses: MAINNET });
    const cfg = await pinarc.getConfig();
    expect(cfg.curve.graduationUsdg).toBe(2_500n * 10n ** 6n);
    const s = initialState({ ...cfg.curve, tradeFeeBps: cfg.fees.tradeFeeBps });
    expect(quoteBuy(s, 10n ** 12n).usdgUsed).toBe(cfg.curve.graduationUsdg);
    const count = await pinarc.getTokenCount();
    expect(count).toBeGreaterThanOrEqual(0n);
    if (count > 0n) {
      const [token] = await pinarc.getTokens(0, 1);
      const curve = await pinarc.getCurveOf(token!);
      const snap = await pinarc.readCurve(curve);
      // the local quote must match the contract's quote exactly
      const onchain = await pinarc.quoteBuyOnChain(curve, 50n * 10n ** 6n);
      if (snap.status !== "graduated") expect(quoteBuy(snap, 50n * 10n ** 6n).tokensOut).toBe(onchain.tokensOut);
    }
    const api = createPinarcApi();
    expect((await api.health()).ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!process.env.PINARC_LIVE)("live v2", () => {
  it("reads the FeePolicy tiers and referral share from mainnet", async () => {
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: createFallbackTransport() });
    const pinarc = createPinarcClient({ publicClient, addresses: MAINNET });
    const fp = (await pinarc.getFeePolicy())!;
    expect(fp.pina.toLowerCase()).toBe(MAINNET.pina!.toLowerCase());
    expect(fp.referralShareBps).toBe(2000);
    expect(fp.tiers).toEqual([{ minBalance: 5_000_000n * 10n ** 9n, discountBps: 5000 }, { minBalance: 500_000n * 10n ** 9n, discountBps: 2500 }]);
    const all = await pinarc.getAllTokens();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const v1 = all.find((t) => t.factory === MAINNET.factoryV1), v2 = all.find((t) => t.factory === MAINNET.factory);
    if (v2) expect(await pinarc.feeBpsFor(await pinarc.getCurveOf(v2.token), "0x0000000000000000000000000000000000000001")).toBe(100);
    if (v1) expect(await pinarc.feeBpsFor(await pinarc.getCurveOf(v1.token), "0x0000000000000000000000000000000000000001")).toBe(100);
  }, 90_000);
});
