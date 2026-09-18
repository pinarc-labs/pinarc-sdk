import { parseEventLogs, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { BondingCurveAbi, CreatorBondAbi, FeePolicyAbi, FloorReserveAbi, LPLockerAbi, PinarcConfigAbi, PinarcFactoryAbi, PinarcTokenAbi, RewardsDistributorAbi, VestingVaultAbi, erc20Abi } from "./abi/index.js";
import { MAINNET, allFactories, type PinarcAddresses } from "./addresses.js";
import { quoteBuy as quoteBuyLocal, quoteSell as quoteSellLocal, type CurveState } from "./curve.js";

export type PinarcClientConfig = {
  publicClient: PublicClient;
  /** Needed for writes. `walletClient.account` must be set. */
  walletClient?: WalletClient;
  addresses?: PinarcAddresses;
};

/** Everything `readCurve` returns: the maths state plus the lifecycle fields. */
export type CurveSnapshot = CurveState & {
  curve: Address;
  token: Address;
  creator: Address;
  lpSupply: bigint;
  graduationUsdg: bigint;
  creatorShareBps: number;
  graduationFeeBps: number;
  antiSniperSeconds: number;
  cooldownSeconds: number;
  maxWallet: bigint;
  maxTx: bigint;
  maxBatchCommit: bigint;
  floorBps: number;
  lpLockSeconds: number;
  launchedAt: bigint;
  batchEndsAt: bigint;
  tradingOpenedAt: bigint;
  graduatedAt: bigint;
  settled: boolean;
  batchUsdg: bigint;
  batchTokensOut: bigint;
  batchRefund: bigint;
  pair: Address;
  lpLockId: bigint;
  teamVestingId: bigint;
  creatorFeesEarned: bigint;
  price18: bigint;
  progressBps: bigint;
  /** Derived from the timestamps: batch → live → graduated. */
  status: "batch" | "live" | "graduated";
};

export type LaunchRequest = {
  name: string;
  symbol: string;
  metadataURI: string;
  /** Share of the raise parked in the floor reserve at graduation, bps (≤ config max). */
  floorBps?: number;
  /** LP lock length at graduation in seconds; 0 burns the LP. */
  lpLockSeconds?: number;
  /** Team allocation in bps of total supply (≤ config max), vested to the creator. */
  teamBps?: number;
  teamCliffSeconds?: number;
  teamDurationSeconds?: number;
  /** Creator bond in USDG base units (0 = none; else ≥ config min). */
  bond?: bigint;
  /** Creator's own first buy, committed to the opening batch and disclosed in TokenCreated. */
  devBuyUsdg?: bigint;
};

export type TxOptions = { to?: Address; slippageBps?: number; deadlineSeconds?: number; /** v2 curves: bind this referrer on the buyer's first referred trade (`buyReferred`). */ referrer?: Address };

const WAD = 10n ** 18n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export function createPinarcClient(cfg: PinarcClientConfig) {
  const { publicClient } = cfg;
  const addresses = cfg.addresses ?? MAINNET;

  function wallet(): WalletClient & { account: NonNullable<WalletClient["account"]> } {
    if (!cfg.walletClient?.account) throw new Error("a walletClient with an account is required for writes");
    return cfg.walletClient as WalletClient & { account: NonNullable<WalletClient["account"]> };
  }

  async function write(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<Hash> {
    const w = wallet();
    const { request } = await publicClient.simulateContract({ ...args, account: w.account, chain: w.chain } as never);
    return w.writeContract(request as never);
  }

  /** Approve `spender` for `amount` of `token` if the current allowance is lower. Returns the tx hash or null. */
  async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<Hash | null> {
    const owner = wallet().account.address;
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (allowance >= amount) return null;
    const hash = await write({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  const client = {
    addresses,

    // ------------------------------------------------------------------ reads

    /** Live platform parameters from PinarcConfig. */
    async getConfig() {
      const [curve, fees, guards] = await Promise.all([
        publicClient.readContract({ address: addresses.config, abi: PinarcConfigAbi, functionName: "curve" }),
        publicClient.readContract({ address: addresses.config, abi: PinarcConfigAbi, functionName: "fees" }),
        publicClient.readContract({ address: addresses.config, abi: PinarcConfigAbi, functionName: "guards" }),
      ]);
      return {
        curve: { virtualTokens: curve[0], curveSupply: curve[1], lpSupply: curve[2], graduationUsdg: curve[3] },
        fees: { tradeFeeBps: fees[0], creatorShareBps: fees[1], graduationFeeBps: fees[2], launchFee: fees[3], treasury: fees[4] },
        guards: { batchSeconds: guards[0], antiSniperSeconds: guards[1], cooldownSeconds: guards[2], maxWalletBps: guards[3], maxTxBps: guards[4], maxBatchCommitBps: guards[5], maxFloorBps: guards[6], maxTeamBps: guards[7], minBond: guards[8], bondLockSeconds: guards[9] },
      };
    },

    /** Addresses of every token launched through a given factory (paged); defaults to the current one. */
    async getTokens(offset = 0, limit = 100, factory: Address = addresses.factory): Promise<Address[]> {
      const total = Number(await publicClient.readContract({ address: factory, abi: PinarcFactoryAbi, functionName: "allTokensLength" }));
      const end = Math.min(total, offset + limit);
      if (end <= offset) return [];
      const res = await publicClient.multicall({
        contracts: Array.from({ length: end - offset }, (_, i) => ({ address: factory, abi: PinarcFactoryAbi, functionName: "allTokens", args: [BigInt(offset + i)] })),
        allowFailure: false,
      });
      return res as Address[];
    },

    /** Every token on the deployment, v2 factory first, then v1. */
    async getAllTokens(): Promise<{ token: Address; factory: Address }[]> {
      const out: { token: Address; factory: Address }[] = [];
      for (const factory of allFactories(addresses)) {
        const n = Number(await publicClient.readContract({ address: factory, abi: PinarcFactoryAbi, functionName: "allTokensLength" }));
        for (let offset = 0; offset < n; offset += 200) for (const token of await client.getTokens(offset, 200, factory)) out.push({ token, factory });
      }
      return out;
    },

    getTokenCount(factory: Address = addresses.factory): Promise<bigint> {
      return publicClient.readContract({ address: factory, abi: PinarcFactoryAbi, functionName: "allTokensLength" });
    },

    /** Curve of a token, looked up on the v2 factory then the v1 factory. Zero address when unknown. */
    async getCurveOf(token: Address): Promise<Address> {
      for (const factory of allFactories(addresses)) {
        const curve = await publicClient.readContract({ address: factory, abi: PinarcFactoryAbi, functionName: "curveOf", args: [token] });
        if (curve !== ZERO) return curve;
      }
      return ZERO;
    },

    // ---------------------------------------------------- fee policy (v2)

    /** The fee (bps) `trader` currently pays on `curve`: base fee after their $PINA tier (v1 curves: base fee). */
    async feeBpsFor(curve: Address, trader: Address): Promise<number> {
      try {
        return Number(await publicClient.readContract({ address: curve, abi: BondingCurveAbi, functionName: "feeBpsFor", args: [trader] }));
      } catch {
        return Number(await publicClient.readContract({ address: curve, abi: BondingCurveAbi, functionName: "tradeFeeBps" }));
      }
    },

    /** Live tier table and referral share from FeePolicy (null when the deployment has none). */
    async getFeePolicy() {
      if (!addresses.feePolicy) return null;
      const fp = { address: addresses.feePolicy, abi: FeePolicyAbi } as const;
      const [n, referralShareBps, pina] = await Promise.all([
        publicClient.readContract({ ...fp, functionName: "tiersLength" }),
        publicClient.readContract({ ...fp, functionName: "referralShareBps" }),
        publicClient.readContract({ ...fp, functionName: "pina" }),
      ]);
      const tiers = await Promise.all(Array.from({ length: Number(n) }, (_, i) => publicClient.readContract({ ...fp, functionName: "tiers", args: [BigInt(i)] })));
      return { pina, referralShareBps: Number(referralShareBps), tiers: tiers.map(([minBalance, discountBps]) => ({ minBalance, discountBps: Number(discountBps) })) };
    },

    /** The referrer bound to `wallet` (zero address = none). */
    async referrerOf(wallet: Address): Promise<Address> {
      if (!addresses.feePolicy) return ZERO;
      return publicClient.readContract({ address: addresses.feePolicy, abi: FeePolicyAbi, functionName: "referrerOf", args: [wallet] });
    },

    async getTokenInfo(token: Address) {
      const c = { address: token, abi: PinarcTokenAbi } as const;
      const [name, symbol, totalSupply, metadataURI, curve, metadataAuthority] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "name" }, { ...c, functionName: "symbol" }, { ...c, functionName: "totalSupply" },
          { ...c, functionName: "metadataURI" }, { ...c, functionName: "curve" }, { ...c, functionName: "metadataAuthority" },
        ],
        allowFailure: false,
      });
      return { address: token, name, symbol, totalSupply, metadataURI, curve, metadataAuthority };
    },

    /** One multicall for everything on a curve. */
    async readCurve(curve: Address): Promise<CurveSnapshot> {
      const c = { address: curve, abi: BondingCurveAbi } as const;
      const names = [
        "token", "creator", "virtualUsdg", "virtualTokens", "curveSupply", "lpSupply", "graduationUsdg", "tradeFeeBps", "creatorShareBps", "graduationFeeBps",
        "antiSniperSeconds", "cooldownSeconds", "maxWallet", "maxTx", "maxBatchCommit", "floorBps", "lpLockSeconds", "usdgRaised", "tokensSold", "launchedAt",
        "batchEndsAt", "tradingOpenedAt", "graduatedAt", "settled", "batchUsdg", "batchTokensOut", "batchRefund", "pair", "lpLockId", "teamVestingId", "creatorFeesEarned", "price", "progressBps",
      ] as const;
      const r = await publicClient.multicall({ contracts: names.map((functionName) => ({ ...c, functionName })) as never, allowFailure: false }) as unknown[];
      const v = Object.fromEntries(names.map((n, i) => [n, r[i]])) as Record<(typeof names)[number], unknown>;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const graduatedAt = v.graduatedAt as bigint, batchEndsAt = v.batchEndsAt as bigint;
      return {
        curve, token: v.token as Address, creator: v.creator as Address,
        virtualUsdg: v.virtualUsdg as bigint, virtualTokens: v.virtualTokens as bigint, curveSupply: v.curveSupply as bigint, lpSupply: v.lpSupply as bigint, graduationUsdg: v.graduationUsdg as bigint,
        tradeFeeBps: Number(v.tradeFeeBps), creatorShareBps: Number(v.creatorShareBps), graduationFeeBps: Number(v.graduationFeeBps),
        antiSniperSeconds: Number(v.antiSniperSeconds), cooldownSeconds: Number(v.cooldownSeconds), maxWallet: v.maxWallet as bigint, maxTx: v.maxTx as bigint, maxBatchCommit: v.maxBatchCommit as bigint,
        floorBps: Number(v.floorBps), lpLockSeconds: Number(v.lpLockSeconds), usdgRaised: v.usdgRaised as bigint, tokensSold: v.tokensSold as bigint,
        launchedAt: v.launchedAt as bigint, batchEndsAt, tradingOpenedAt: v.tradingOpenedAt as bigint, graduatedAt, settled: v.settled as boolean,
        batchUsdg: v.batchUsdg as bigint, batchTokensOut: v.batchTokensOut as bigint, batchRefund: v.batchRefund as bigint, pair: v.pair as Address, lpLockId: v.lpLockId as bigint, teamVestingId: v.teamVestingId as bigint, creatorFeesEarned: v.creatorFeesEarned as bigint,
        price18: v.price as bigint, progressBps: v.progressBps as bigint,
        status: graduatedAt !== 0n ? "graduated" : now < batchEndsAt ? "batch" : "live",
      };
    },

    /** On-chain quote (`BondingCurve.quoteBuy`). Use `quoteBuy` from `./curve` for a local, gas-free version. */
    quoteBuyOnChain(curve: Address, usdgIn: bigint) {
      return publicClient.readContract({ address: curve, abi: BondingCurveAbi, functionName: "quoteBuy", args: [usdgIn] }).then(([tokensOut, usdgUsed, fee]) => ({ tokensOut, usdgUsed, fee }));
    },
    quoteSellOnChain(curve: Address, tokensIn: bigint) {
      return publicClient.readContract({ address: curve, abi: BondingCurveAbi, functionName: "quoteSell", args: [tokensIn] }).then(([usdgOut, fee]) => ({ usdgOut, fee }));
    },

    async getBond(token: Address) {
      const [creator, curve, amount, lockSeconds, status] = await publicClient.readContract({ address: addresses.creatorBond, abi: CreatorBondAbi, functionName: "bonds", args: [token] });
      return { creator, curve, amount, lockSeconds, status: (["none", "active", "released", "slashed"] as const)[status] ?? "none" };
    },

    async getFloor(token: Address) {
      const [reserve, floorPrice18] = await Promise.all([
        publicClient.readContract({ address: addresses.floorReserve, abi: FloorReserveAbi, functionName: "reserveOf", args: [token] }),
        publicClient.readContract({ address: addresses.floorReserve, abi: FloorReserveAbi, functionName: "floorPrice", args: [token] }),
      ]);
      return { reserve, floorPrice18 };
    },

    getLock(id: bigint) {
      return publicClient.readContract({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "getLock", args: [id] });
    },
    locksOf(owner: Address) {
      return publicClient.readContract({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "locksOf", args: [owner] });
    },
    getVesting(id: bigint) {
      return publicClient.readContract({ address: addresses.vestingVault, abi: VestingVaultAbi, functionName: "getSchedule", args: [id] });
    },
    releasableVesting(id: bigint) {
      return publicClient.readContract({ address: addresses.vestingVault, abi: VestingVaultAbi, functionName: "releasable", args: [id] });
    },
    usdgBalance(owner: Address) {
      return publicClient.readContract({ address: addresses.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },

    // ----------------------------------------------------------------- writes

    ensureAllowance,

    /**
     * Launch a token: approves the factory for `launchFee + bond + devBuy` USDG (if needed), sends `createToken`,
     * waits for the receipt and returns the new token and curve addresses from `TokenCreated`.
     */
    async launch(req: LaunchRequest) {
      const cfg = await client.getConfig();
      const bond = req.bond ?? 0n, devBuy = req.devBuyUsdg ?? 0n;
      const total = cfg.fees.launchFee + bond + devBuy;
      const approveHash = total > 0n ? await ensureAllowance(addresses.usdg, addresses.factory, total) : null;
      const hash = await write({
        address: addresses.factory, abi: PinarcFactoryAbi, functionName: "createToken",
        args: [{
          name: req.name, symbol: req.symbol, metadataURI: req.metadataURI,
          floorBps: req.floorBps ?? 0, lpLockSeconds: req.lpLockSeconds ?? 0, teamBps: req.teamBps ?? 0,
          teamCliff: BigInt(req.teamCliffSeconds ?? 0), teamDuration: BigInt(req.teamDurationSeconds ?? 0), bond, devBuyUsdg: devBuy,
        }],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const [created] = parseEventLogs({ abi: PinarcFactoryAbi, logs: receipt.logs, eventName: "TokenCreated" });
      if (!created) throw new Error("TokenCreated event not found in receipt");
      return { hash, approveHash, receipt, token: created.args.token, curve: created.args.curve, creator: created.args.creator };
    },

    async commitBatch(curve: Address, usdgIn: bigint) {
      await ensureAllowance(addresses.usdg, curve, usdgIn);
      return write({ address: curve, abi: BondingCurveAbi, functionName: "commitBatch", args: [usdgIn] });
    },
    settleBatch(curve: Address) {
      return write({ address: curve, abi: BondingCurveAbi, functionName: "settleBatch" });
    },
    claimBatch(curve: Address) {
      return write({ address: curve, abi: BondingCurveAbi, functionName: "claimBatch" });
    },

    /** Buy with `usdgIn`; `minTokensOut` comes from a local quote minus `slippageBps` (default 50 = 0.5%). */
    async buy(curve: Address, usdgIn: bigint, opts: TxOptions = {}) {
      const state = await client.readCurve(curve);
      state.tradeFeeBps = await client.feeBpsFor(curve, wallet().account.address); // the trader's tiered fee (v2)
      const q = quoteBuyLocal(state, usdgIn);
      const minTokensOut = (q.tokensOut * (10_000n - BigInt(opts.slippageBps ?? 50))) / 10_000n;
      await ensureAllowance(addresses.usdg, curve, usdgIn);
      const to = opts.to ?? wallet().account.address;
      const hash = opts.referrer
        ? await write({ address: curve, abi: BondingCurveAbi, functionName: "buyReferred", args: [usdgIn, minTokensOut, to, opts.referrer] })
        : await write({ address: curve, abi: BondingCurveAbi, functionName: "buy", args: [usdgIn, minTokensOut, to] });
      return { hash, quote: q, minTokensOut };
    },

    /** Sell `tokensIn`; `minUsdgOut` from a local quote minus `slippageBps`. */
    async sell(curve: Address, tokensIn: bigint, opts: TxOptions = {}) {
      const state = await client.readCurve(curve);
      state.tradeFeeBps = await client.feeBpsFor(curve, wallet().account.address);
      const q = quoteSellLocal(state, tokensIn);
      const minUsdgOut = (q.usdgOut * (10_000n - BigInt(opts.slippageBps ?? 50))) / 10_000n;
      await ensureAllowance(state.token, curve, tokensIn);
      const hash = await write({ address: curve, abi: BondingCurveAbi, functionName: "sell", args: [tokensIn, minUsdgOut, opts.to ?? wallet().account.address] });
      return { hash, quote: q, minUsdgOut };
    },

    /** Lock any ERC-20 (or LP) amount until `unlockAt` (unix seconds). Returns the tx hash and the lock id. */
    async lock(token: Address, amount: bigint, unlockAt: bigint, owner?: Address) {
      await ensureAllowance(token, addresses.lpLocker, amount);
      const hash = await write({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "lock", args: [token, amount, unlockAt, owner ?? wallet().account.address] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const [locked] = parseEventLogs({ abi: LPLockerAbi, logs: receipt.logs, eventName: "Locked" });
      return { hash, id: locked?.args.id ?? null, receipt };
    },
    extendLock(id: bigint, unlockAt: bigint) {
      return write({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "extend", args: [id, unlockAt] });
    },
    transferLock(id: bigint, to: Address) {
      return write({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "transferLock", args: [id, to] });
    },
    withdrawLock(id: bigint, to?: Address) {
      return write({ address: addresses.lpLocker, abi: LPLockerAbi, functionName: "withdraw", args: [id, to ?? wallet().account.address] });
    },

    /** Burn `amount` tokens for their share of the floor reserve (graduated tokens). */
    async redeemFloor(token: Address, amount: bigint) {
      await ensureAllowance(token, addresses.floorReserve, amount);
      return write({ address: addresses.floorReserve, abi: FloorReserveAbi, functionName: "redeem", args: [token, amount] });
    },
    releaseVesting(id: bigint) {
      return write({ address: addresses.vestingVault, abi: VestingVaultAbi, functionName: "release", args: [id] });
    },
    releaseBond(token: Address) {
      return write({ address: addresses.creatorBond, abi: CreatorBondAbi, functionName: "release", args: [token] });
    },
    // ------------------------------------------------------ rewards (v2)

    async getRewardRound(roundId: bigint) {
      if (!addresses.rewardsDistributor) throw new Error("no RewardsDistributor on this deployment");
      return publicClient.readContract({ address: addresses.rewardsDistributor, abi: RewardsDistributorAbi, functionName: "rounds", args: [roundId] });
    },
    isRewardClaimed(roundId: bigint, index: bigint): Promise<boolean> {
      if (!addresses.rewardsDistributor) throw new Error("no RewardsDistributor on this deployment");
      return publicClient.readContract({ address: addresses.rewardsDistributor, abi: RewardsDistributorAbi, functionName: "isClaimed", args: [roundId, index] });
    },
    /** Claim a Merkle allocation (leaf = keccak256(abi.encodePacked(index, account, amount)), sorted pairs). Anyone may submit it. */
    claimReward(roundId: bigint, index: bigint, account: Address, amount: bigint, proof: Hex[]) {
      if (!addresses.rewardsDistributor) throw new Error("no RewardsDistributor on this deployment");
      return write({ address: addresses.rewardsDistributor, abi: RewardsDistributorAbi, functionName: "claim", args: [roundId, index, account, amount, proof] });
    },

    setMetadataURI(token: Address, uri: string) {
      return write({ address: token, abi: PinarcTokenAbi, functionName: "setMetadataURI", args: [uri] });
    },

    waitForReceipt(hash: Hex) {
      return publicClient.waitForTransactionReceipt({ hash });
    },
  };
  return client;
}

export type PinarcClient = ReturnType<typeof createPinarcClient>;
export { WAD };
