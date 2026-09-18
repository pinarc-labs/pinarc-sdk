import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { BondingCurveAbi, CreatorBondAbi, MAINNET, PINARC_EVENTS, PinarcFactoryAbi, VestingVaultAbi, decodePinarcLogs, eventTopic } from "../src/index.js";

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222";
const log = (over: Partial<Log>): Log => ({ address: A, blockNumber: 1n, blockHash: "0x", transactionHash: "0xabc", transactionIndex: 0, logIndex: 0, removed: false, data: "0x", topics: [], ...over } as Log);

describe("events", () => {
  it("lists every protocol event by source", () => {
    expect(PINARC_EVENTS.curve.map((e) => e.name).sort()).toEqual(["BatchClaimed", "BatchCommitted", "BatchSettled", "Graduated", "Launched", "ReferralPaid", "Trade"]);
    expect(PINARC_EVENTS.factory.map((e) => e.name)).toEqual(["TokenCreated"]);
    expect(PINARC_EVENTS.curve.map((e) => e.name)).toContain("ReferralPaid");
    expect(PINARC_EVENTS.policy.map((e) => e.name).sort()).toEqual(["FactorySet", "OwnershipTransferStarted", "OwnershipTransferred", "ReferralShareSet", "ReferrerBound", "TiersSet"]);
    expect(PINARC_EVENTS.rewards.map((e) => e.name)).toContain("Claimed");
    expect(eventTopic("curve", "Trade")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => eventTopic("curve", "Nope")).toThrow();
  });
  it("decodes a Trade and a TokenCreated and sorts by block/log index", () => {
    const trade = log({
      address: B, blockNumber: 10n, logIndex: 3,
      topics: encodeEventTopics({ abi: BondingCurveAbi, eventName: "Trade", args: { trader: A, isBuy: true } }) as never,
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [99_000000n, 5n * 10n ** 18n, 4_000_000_000_000n, 1_000000n]),
    });
    const created = log({
      address: MAINNET.factory, blockNumber: 9n, logIndex: 7,
      topics: encodeEventTopics({ abi: PinarcFactoryAbi, eventName: "TokenCreated", args: { token: A, curve: B, creator: A } }) as never,
      data: encodeAbiParameters([{ type: "uint16" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1500, 31536000, 0n, 500_000000n, 300_000000n]),
    });
    const out = decodePinarcLogs([trade, created], { factory: MAINNET.factory });
    expect(out.map((e) => `${e.source}.${e.name}`)).toEqual(["factory.TokenCreated", "curve.Trade"]);
    expect(out[1]!.args).toMatchObject({ trader: A, isBuy: true, usdgAmount: 99_000000n, tokenAmount: 5n * 10n ** 18n, fee: 1_000000n });
    expect(out[0]!.args).toMatchObject({ token: A, curve: B, floorBps: 1500, bond: 500_000000n, devBuyUsdg: 300_000000n });
  });
  it("tells CreatorBond.Released and VestingVault.Released apart by address and skips unknown topics", () => {
    const bond = log({
      address: MAINNET.creatorBond, blockNumber: 2n,
      topics: encodeEventTopics({ abi: CreatorBondAbi, eventName: "Released", args: { token: A, creator: B } }) as never,
      data: encodeAbiParameters([{ type: "uint256" }], [500_000000n]),
    });
    const vest = log({
      address: MAINNET.vestingVault, blockNumber: 3n,
      topics: encodeEventTopics({ abi: VestingVaultAbi, eventName: "Released", args: { id: 1n, beneficiary: B } }) as never,
      data: encodeAbiParameters([{ type: "uint256" }], [7n]),
    });
    const junk = log({ topics: ["0x" + "ab".repeat(32)] as never });
    const out = decodePinarcLogs([junk, vest, bond], { bond: MAINNET.creatorBond, vault: MAINNET.vestingVault });
    expect(out.map((e) => `${e.source}.${e.name}`)).toEqual(["bond.Released", "vault.Released"]);
    expect(out[0]!.args).toMatchObject({ token: A, amount: 500_000000n });
    expect(out[1]!.args).toMatchObject({ id: 1n, amount: 7n });
  });
});
