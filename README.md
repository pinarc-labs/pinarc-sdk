# @pinarc-labs/sdk

TypeScript SDK for [Pinarc](https://pinarc.io), the permissionless USDG launchpad on Robinhood Chain.

- **ABIs + addresses** of the eight Phase 1 contracts (generated from `pinarc-contracts`, mainnet deployment included).
- **The curve maths**, line for line from `BondingCurve.sol`: quotes, batch settlement, fee split, graduation plan, market cap — pure functions on bigints, no RPC needed.
- **A client** for reads (`readCurve` in one multicall, config, bonds, floors, locks, vesting) and writes (`launch`, `commitBatch`, `claimBatch`, `buy`, `sell`, `lock`, `redeemFloor`, …) with automatic USDG approvals and slippage from a local quote.
- **Event decoding** for every protocol event (`decodePinarcLogs`), ready for indexers.
- **A typed client for the public API** (`dapp.pinarc.io/api/v1`): tokens, trades, candles, holders, metadata.

Built on [viem](https://viem.sh) and [`@pinarc-labs/robinhood-chain-kit`](https://github.com/pinarc-labs/robinhood-chain-kit).

```sh
pnpm add @pinarc-labs/sdk @pinarc-labs/robinhood-chain-kit viem
```

## Quotes without a node

```ts
import { DEFAULT_LAUNCH_PARAMS, initialState, quoteBuy, quoteSell, applyBuy, graduationPlan } from "@pinarc-labs/sdk";

const s = initialState(DEFAULT_LAUNCH_PARAMS);          // a fresh curve: 800M on the curve, graduates at 12,400 USDG
const q = quoteBuy(s, 100_000000n);                      // 100 USDG (6 decimals)
q.tokensOut;        // 24,5xx,xxx tokens (18 decimals)
q.fee;              // 1 USDG
q.priceImpactBps;   // ~233
q.graduates;        // false

const after = applyBuy(s, q);
quoteSell(after, q.tokensOut).usdgOut;                   // a little under 98 USDG (1% fee each way + rounding)

graduationPlan(s, { graduationFeeBps: 200, floorBps: 1500, lpSupply: DEFAULT_LAUNCH_PARAMS.lpSupply, totalSupply: 1_000_000_000n * 10n ** 18n });
// { raised: 12400 USDG, graduationFee: 248, floorUsdg: 1860, liquidityUsdg: 10292, marketCapUsdg: ~60.9k, poolPrice18, floorPrice18 }
```

The same functions run in the app's launch simulator; `pnpm test:live` checks them against the contracts on mainnet.

## Reading the chain

```ts
import { createPublicClient } from "viem";
import { createFallbackTransport, robinhoodChain } from "@pinarc-labs/robinhood-chain-kit";
import { createPinarcClient, MAINNET } from "@pinarc-labs/sdk";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: createFallbackTransport() });
const pinarc = createPinarcClient({ publicClient, addresses: MAINNET });

const cfg = await pinarc.getConfig();                    // live PinarcConfig: curve, fees, guards
const tokens = await pinarc.getTokens(0, 50);            // addresses from the factory
const curve = await pinarc.getCurveOf(tokens[0]);
const snap = await pinarc.readCurve(curve);              // reserves, batch state, status, price18, pair, lock id… (one multicall)
```

## Writing

```ts
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const walletClient = createWalletClient({ account: privateKeyToAccount(process.env.PK as `0x${string}`), chain: robinhoodChain, transport: http() });
const pinarc = createPinarcClient({ publicClient, walletClient });

const { token, curve } = await pinarc.launch({
  name: "Robin", symbol: "ROBIN", metadataURI: "https://dapp.pinarc.io/api/v1/metadata/<id>.json",
  floorBps: 1500, lpLockSeconds: 365 * 86400, teamBps: 500, teamCliffSeconds: 30 * 86400, teamDurationSeconds: 180 * 86400,
  bond: parseUnits("500", 6), devBuyUsdg: parseUnits("300", 6),
});                                                       // approves launchFee + bond + devBuy, sends createToken, parses TokenCreated

await pinarc.commitBatch(curve, parseUnits("250", 6));   // during the 30 s opening batch
await pinarc.claimBatch(curve);                           // after it closes (settles if nobody did)
await pinarc.buy(curve, parseUnits("50", 6), { slippageBps: 100 });
await pinarc.sell(curve, 1_000_000n * 10n ** 18n);
await pinarc.lock(token, 10n ** 24n, BigInt(Math.floor(Date.now() / 1000) + 90 * 86400));
```

Every write simulates first (`simulateContract`) so reverts surface as typed errors before a transaction is sent.

## Events

```ts
import { getLogsChunked } from "@pinarc-labs/robinhood-chain-kit";
import { decodePinarcLogs, PINARC_EVENTS, MAINNET } from "@pinarc-labs/sdk";

const logs = await getLogsChunked(publicClient, { address: MAINNET.factory, events: PINARC_EVENTS.factory, fromBlock: MAINNET.startBlock, toBlock: await publicClient.getBlockNumber() });
for (const e of decodePinarcLogs(logs, { factory: MAINNET.factory })) console.log(e.name, e.args);   // TokenCreated { token, curve, creator, … }
```

`PINARC_EVENTS.curve` (`Launched`, `BatchCommitted`, `BatchSettled`, `BatchClaimed`, `Trade`, `Graduated`), `.bond`, `.floor`, `.locker`, `.vault`, `.token` give you the ABI events for any filter. See [pinarc-indexer](https://github.com/pinarc-labs/pinarc-indexer) for a full chain → SQLite pipeline built on this.

## Public API

```ts
import { createPinarcApi } from "@pinarc-labs/sdk";
const api = createPinarcApi();                            // https://dapp.pinarc.io/api/v1
await api.tokens({ tab: "trending", limit: 20 });
await api.token("0x…");                                   // { token, trades, holders }
await api.candles("0x…", { tf: "5m", limit: 300 });
```

## Regenerating the ABIs

```sh
git clone https://github.com/pinarc-labs/pinarc-contracts ../pinarc-contracts && (cd ../pinarc-contracts && forge build)
pnpm gen-abi
```

## Development

```sh
pnpm install     # expects ../robinhood-chain-kit checked out and built (file: dependency until npm)
pnpm test        # unit tests, no network
pnpm test:live   # PINARC_LIVE=1: reads mainnet and checks the maths against the deployed config
pnpm build
```

## License

MIT © Pinarc Labs
