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
};

/** Phase 1 deployment on Robinhood Chain mainnet (2026-09-17), from pinarc-contracts/deployments/4663.json. */
export const MAINNET: PinarcAddresses = {
  chainId: 4663,
  startBlock: 65_381_613n,
  factory: "0x0cF1cdf2e85b324Ea422AeA5Bd16764217703c5E",
  config: "0xE2B2aF83537C56995294d189a5E80b281c3B2F7e",
  curveImplementation: "0xcf6D0a9D28A44200C862774Cb4F0fe528564706b",
  creatorBond: "0xFe16E9e6FA0F95F6b3a1d4849Af0e66AA1A25390",
  floorReserve: "0x02c2e0460B75A68C9E76F3015A378dfFA8Ef4F42",
  lpLocker: "0xC49ade379b89F0bD1Cb08D21eE6440B12Ad9894d",
  vestingVault: "0x380b3D5fafbfDaC70108d3A1D4208d6f4b4BBf88",
  usdg: CONTRACTS.usdg,
  uniswapV2Router: CONTRACTS.uniswapV2.router02,
  treasury: "0x4db8587bb156FA02501b23800cC302D0Ba3e656E",
};

export const DEPLOYMENTS: Record<number, PinarcAddresses> = { 4663: MAINNET };

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
