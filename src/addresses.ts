import type { Address } from "viem";
import { CONTRACTS } from "@pinarc-labs/robinhood-chain-kit";

export type PinarcAddresses = {
  chainId: number;
  /** Block the factory was deployed at; indexers start here. */
  startBlock: bigint;
  factory: Address;
  config: Address;
  curveImplementation: Address;
  creatorBond: Address;
  floorReserve: Address;
  lpLocker: Address;
  vestingVault: Address;
  usdg: Address;
  uniswapV2Router: Address;
  treasury: Address;
  /** v2 (2026-09-18): $PINA holder fee tiers + on-chain referrals; absent on a v1-only deployment. */
  feePolicy?: Address;
  /** v2: Merkle-claimable reward rounds. */
  rewardsDistributor?: Address;
  /** The $PINA token FeePolicy reads balances from (9 decimals). */
  pina?: Address;
  /** The v1 factory, still indexed; launches made through it keep the flat fee. */
  factoryV1?: Address;
  curveImplementationV1?: Address;
  creatorBondV1?: Address;
};

/** $PINA on Robinhood Chain: ERC-20, 9 decimals, 1,000,000,000 supply, no owner. */
export const PINA_ADDRESS: Address = "0x050a18c9e14D2a13dE99762AC28CB70C8D702303";
export const PINA_DECIMALS = 9 as const;

/**
 * Robinhood Chain mainnet: the v2 deployment (2026-09-18, pinarc-contracts/deployments/4663.v2.json) for new
 * launches, with the v1 addresses (2026-09-17, deployments/4663.json) kept for the launches made before it.
 * Config, FloorReserve, LPLocker and VestingVault are shared by both.
 */
export const MAINNET: PinarcAddresses = {
  chainId: 4663,
  startBlock: 65_381_613n,
  factory: "0xA2f9201875548De77AeECDDed362fB869ddB156d",
  config: "0xE2B2aF83537C56995294d189a5E80b281c3B2F7e",
  curveImplementation: "0xCE128400d506af33aF37DBAba7354daa4aC139fe",
  creatorBond: "0x9C5d9Cf4aDef103937c889F48C98A735E018AA3f",
  feePolicy: "0xaF51a2373AC05e52ad2A9b55639A2783Cdcb61d3",
  rewardsDistributor: "0x123508dFCe1Bd5Dc5e25f627030F6a7C754429b1",
  pina: PINA_ADDRESS,
  factoryV1: "0x0cF1cdf2e85b324Ea422AeA5Bd16764217703c5E",
  curveImplementationV1: "0xcf6D0a9D28A44200C862774Cb4F0fe528564706b",
  creatorBondV1: "0xFe16E9e6FA0F95F6b3a1d4849Af0e66AA1A25390",
  floorReserve: "0x02c2e0460B75A68C9E76F3015A378dfFA8Ef4F42",
  lpLocker: "0xC49ade379b89F0bD1Cb08D21eE6440B12Ad9894d",
  vestingVault: "0x380b3D5fafbfDaC70108d3A1D4208d6f4b4BBf88",
  usdg: CONTRACTS.usdg,
  uniswapV2Router: CONTRACTS.uniswapV2.router02,
  treasury: "0x4db8587bb156FA02501b23800cC302D0Ba3e656E",
};

/** The original Phase 1 addresses only (flat fee, no referrals). */
export const MAINNET_V1: PinarcAddresses = {
  ...MAINNET,
  factory: MAINNET.factoryV1!,
  curveImplementation: MAINNET.curveImplementationV1!,
  creatorBond: MAINNET.creatorBondV1!,
  feePolicy: undefined,
  rewardsDistributor: undefined,
};

export const DEPLOYMENTS: Record<number, PinarcAddresses> = { 4663: MAINNET };

/** Every factory that has launched tokens on a deployment (v2 first). Indexers watch all of them. */
export function allFactories(a: PinarcAddresses): Address[] {
  return [a.factory, ...(a.factoryV1 && a.factoryV1 !== a.factory ? [a.factoryV1] : [])];
}

/** Build addresses for a local fork / testnet from env-style values (unset fields fall back to mainnet). */
export function addressesFrom(partial: Partial<Record<keyof PinarcAddresses, string | bigint | number | undefined>>, base: PinarcAddresses = MAINNET): PinarcAddresses {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || v === "") continue;
    if (k === "startBlock") out[k] = BigInt(v as string | number | bigint);
    else if (k === "chainId") out[k] = Number(v);
    else out[k] = v as Address;
  }
  return out as PinarcAddresses;
}
