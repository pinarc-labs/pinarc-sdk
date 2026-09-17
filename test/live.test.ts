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
    expect(cfg.curve.graduationUsdg).toBe(12_400n * 10n ** 6n);
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
