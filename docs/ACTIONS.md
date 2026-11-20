# Leash v2: guarded on-chain actions, a value-flow language, and monitoring

v1 let an agent **pay**. v2 lets it **act**: swap, wrap, deposit into a vault. The rule has not changed: a classical key can only stop things, and starting or loosening anything needs the owner's ML-DSA-87 signature. What is new is how the guard keeps an *action* inside the owner's intent.

## How `execute` stays honest

`LeashGuardV2.execute(adapter, target, data, value)` is callable only by the agent, only while unfrozen and unexpired, and only along a **route** the owner signed:

```
Route = (adapter, target, tokenIn, tokenOut, minOutPerIn)
```

The guard does **not** trust the call data. It enforces the value flow by measurement:

1. An **adapter** (a stateless contract) decodes the call into `(tokenIn, amountIn, tokenOut, recipient)`. The guard calls it with `STATICCALL`.
2. The route must exist. The output **recipient must be the guard itself**.
3. `amountIn` is charged against the **same per-action and daily caps as `spend`**, so swaps and payments share one budget.
4. Approvals are exact, and are **reset to zero** afterwards, even if the target pulled less than approved.
5. After the call, the guard's balance of `tokenOut` must have risen by at least `amountIn * minOutPerIn`. That is the owner's **rate floor, checked on what was actually received**, not on what the call data promised. A router that diverts the output, under-delivers, or lies about a quote is refused and the whole transaction reverts.
6. No other listed token's balance may fall, and `tokenIn` may fall by at most `amountIn`.

The floor is the owner's own number. There is no price oracle on QoreChain, so the floor bounds slippage; it does not protect against the market moving. The compiler says so in a finding every time.

## Adapters

| Adapter | Decodes | Needs |
|---|---|---|
| `UniV2Adapter` | `swapExactTokensForTokens`, `swapExactETHForTokens`, `swapExactTokensForETH` on a Uniswap-V2-style router; paths of 2 to 4 tokens | a V2-style router address |
| `WrapAdapter` | `deposit()` and `withdraw(uint256)` on a WETH9-style wrapped native token | the wrapped token address |
| `Erc4626Adapter` | `deposit(uint256,address)` and `redeem(uint256,address,address)` on an ERC-4626 vault; redeem must burn the guard's own shares | the vault address |

Adding an adapter is writing one `inspect` function. It holds no funds and no state, so a mistake in an adapter is bounded by the measurements above, not by trust.

## Describing value flows in plain English

The compiler (`tools/policy.ts`) is a deterministic grammar, not a model. Caps and duration work as in v1; flows are new:

| You write | Meaning |
|---|---|
| `swap FUSD for FETH on 0xROUTER at no worse than 0.0004 FETH per FUSD` | a swap route with a rate floor |
| `wrap QOR into WQOR on 0xWQOR` | native to wrapped, one for one |
| `unwrap WQOR to QOR on 0xWQOR` | wrapped to native, one for one |
| `deposit FUSD into vault 0xV as VFUSD at no worse than 0.99 VFUSD per FUSD` | vault deposit with a share floor |
| `redeem VFUSD from vault 0xV for FUSD at no worse than 0.99 FUSD per VFUSD` | vault redeem with an asset floor |

```sh
pnpm compile "agent 0x7099… up to 100 FUSD a day, at most 40 FUSD per payment, swap FUSD for FETH on 0xROUTER at no worse than 0.0004 FETH per FUSD for 3 days" --tokens tokens.json --adapters adapters.json
```

It refuses what it cannot read exactly: a swap with no rate floor, a floor in the wrong units, a floor that rounds to zero, a spent token with no cap, a flow with no configured adapter. The output token is listed **receive-only** (zero caps) automatically. Every flow adds gaps to the report: the floor has no oracle, a route trusts its target contract, multi-hop paths measure only the first input and the last output, and QoreChain's native AMM cannot be called from a contract.

## Monitoring

`pnpm monitor --guard 0x…` polls the guard and applies rules (`tools/monitor.ts`, pure and unit-tested):

| Rule | Fires when | Severity |
|---|---|---|
| `unexplained-outflow` | a balance falls by more than the guard's own events explain (native balance is always watched) | critical, asks for a freeze |
| `burst` | 5 or more guard actions within 60 seconds | critical, asks for a freeze |
| `frozen`, `expired`, `expiring-soon` | state | critical, warn, warn |
| `daily-burn`, `large-action` | 80% of a daily cap used; one action over half a cap | warn |
| `mandate-changed`, `agent-changed` | a new owner-signed mandate or agent | warn |

`--auto-freeze` makes the watcher call `freeze()` when a critical rule fires. It holds **only a classical key** (`LEASH_WATCHER_KEY`, the owner's or the agent's). That is the Leash rule applied to monitoring: a classical key can only stop things, so a monitor that holds one is safe even if the monitor itself is compromised. `--webhook` posts alerts to a URL you choose; nothing is sent anywhere by default. `pnpm demo:monitor` shows both bad days on a local node.

## For agent harnesses

The MCP server adds `leash_routes`, `leash_swap`, `leash_wrap`, `leash_unwrap`, `leash_vault_deposit`, `leash_vault_redeem`, `leash_execute` and `leash_monitor`. Every action tool simulates first, shows the expected output, and sends only with `confirm: true`. See [mcp/README.md](../mcp/README.md).

## What is proven, and what is not

- 25 Foundry tests for the guard and adapters, including a fuzz test (swaps plus payments never exceed the daily cap). Six deliberate breakages of the contract (no rate floor, output to anywhere, caps skipped, approval left open, native value unchecked, no route needed) are each caught by the tests.
- 11 compiler tests for the flow language, 9 for the monitor rules.
- `pnpm demo:local:v2`: a tour through every adapter with the TypeScript builders, then the Q-Day drill for actions (16 of 16).
- `pnpm mcp:e2e`: an MCP client drives swap, native swap, wrap, unwrap and vault through the server, with refusals, a monitor read and a freeze (24 checks).
- `pnpm demo:monitor`: a burst and an unexplained outflow are caught and the guard is frozen by a stop-only key.
- The on-chain run: see the testnet section of the README.

Limits, plainly:

- **No price oracle.** A rate floor is a number the owner wrote. A stale floor blocks good trades or allows bad ones.
- **Routes trust their target.** A malicious or upgraded router is bounded by the floor and the caps, not removed. Route only to contracts you have read.
- **Only EVM routers, wrapped tokens and ERC-4626 vaults.** QoreChain's native AMM (`x/amm`) has no precompile, so a contract cannot call it. The QoreSwap router address is not published, so the testnet run uses our own test router and test tokens.
- **No bridging.** No bridge route is live on QoreChain today. Leash does not claim to guard one.
- **Only the guard's funds are limited.** Keep the agent's own account near zero.
- **Unaudited.** The unexpected-outflow checks inside `execute` are defence in depth: with well-behaved tokens they cannot be triggered by a route, so their tests are limited to what the mocks can express.
- **Testnet only.** `pqcVerify` is not active on mainnet.
