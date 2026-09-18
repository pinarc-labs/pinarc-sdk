import { decodeEventLog, toEventSelector, type AbiEvent, type Address, type Hex, type Log } from "viem";
import { BondingCurveAbi, CreatorBondAbi, FeePolicyAbi, FloorReserveAbi, LPLockerAbi, PinarcFactoryAbi, PinarcTokenAbi, RewardsDistributorAbi, VestingVaultAbi } from "./abi/index.js";

/** Which contract family emits an event; disambiguates e.g. CreatorBond.Released from VestingVault.Released. */
export type EventSource = "factory" | "curve" | "bond" | "floor" | "locker" | "vault" | "token" | "policy" | "rewards";

type AbiWithEvents = readonly { type: string; name?: string }[];
const eventsOf = (abi: AbiWithEvents): AbiEvent[] => abi.filter((i): i is AbiEvent => i.type === "event");

/** Every event the protocol emits, grouped by source. Feed a group to the getLogs chunker's `events`. */
export const PINARC_EVENTS: Record<EventSource, AbiEvent[]> = {
  factory: eventsOf(PinarcFactoryAbi),
  curve: eventsOf(BondingCurveAbi),
  bond: eventsOf(CreatorBondAbi),
  floor: eventsOf(FloorReserveAbi),
  locker: eventsOf(LPLockerAbi),
  vault: eventsOf(VestingVaultAbi),
  token: eventsOf(PinarcTokenAbi),
  policy: eventsOf(FeePolicyAbi),
  rewards: eventsOf(RewardsDistributorAbi),
};

const BY_TOPIC = new Map<Hex, { source: EventSource; event: AbiEvent }[]>();
for (const [source, events] of Object.entries(PINARC_EVENTS) as [EventSource, AbiEvent[]][]) {
  for (const event of events) {
    const topic = toEventSelector(event);
    const list = BY_TOPIC.get(topic) ?? [];
    if (!list.some((e) => e.source === source && e.event.name === event.name)) list.push({ source, event });
    BY_TOPIC.set(topic, list);
  }
}

export type DecodedPinarcEvent = {
  source: EventSource;
  name: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  /** The raw log, for anything not surfaced above. */
  log: Log;
};

/** Contracts whose address pins the source; curve/token logs come from per-launch clones and are matched by topic. */
export type KnownAddresses = Partial<Record<Exclude<EventSource, "curve" | "token">, Address | undefined>>;

/**
 * Decode Pinarc logs into `{ source, name, args }` records, sorted by block and log index. Unknown topics are
 * skipped. When `known` is given, singleton contracts are matched by address; ERC-20 `Transfer` from any
 * address decodes as `token`.
 */
export function decodePinarcLogs(logs: readonly Log[], known: KnownAddresses = {}): DecodedPinarcEvent[] {
  const byAddress = new Map<string, EventSource>();
  for (const [source, address] of Object.entries(known)) if (address) byAddress.set(address.toLowerCase(), source as EventSource);
  const out: DecodedPinarcEvent[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0];
    if (!topic0) continue;
    const candidates = BY_TOPIC.get(topic0);
    if (!candidates?.length) continue;
    const pinned = byAddress.get(log.address.toLowerCase());
    const match = candidates.find((c) => c.source === pinned) ?? (pinned ? undefined : candidates[0]);
    if (!match) continue;
    try {
      const decoded = decodeEventLog({ abi: [match.event], data: log.data, topics: log.topics, strict: true });
      out.push({ source: match.source, name: decoded.eventName, args: (decoded.args ?? {}) as Record<string, unknown>, address: log.address, blockNumber: log.blockNumber ?? 0n, transactionHash: log.transactionHash ?? "0x", logIndex: log.logIndex ?? 0, log });
    } catch {
      // A foreign contract reusing a Pinarc topic with a different layout; ignore it.
    }
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

/** topic0 of a named Pinarc event, e.g. `eventTopic("curve", "Trade")`. */
export function eventTopic(source: EventSource, name: string): Hex {
  const ev = PINARC_EVENTS[source].find((e) => e.name === name);
  if (!ev) throw new Error(`unknown event ${source}.${name}`);
  return toEventSelector(ev);
}
