# The flow language

You describe what the agent may do in plain English. A deterministic grammar (not a model) turns it into a mandate. Anything it cannot read exactly is refused, and it says why.

## Caps, agent, expiry

```
agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
up to 100 FUSD a day, at most 40 FUSD per payment
only to 0x90F79bf6EB2c4f870365E785982E1f101E93b906
for 3 days
```

- `agent 0x…` names the agent's address (required).
- `up to N TOKEN a day` and `at most N TOKEN per payment` set the daily and per-action caps. A missing cap is defaulted from the other one, with a warning.
- `only to 0x…` is the payment allowlist. It is required unless you describe flows.
- `for 3 hours` or `for 3 days` sets the expiry; the default is 24 hours, with a warning.

## Flows

| You write | Meaning |
|---|---|
| `swap FUSD for FETH on 0xROUTER at no worse than 0.0004 FETH per FUSD` | swap through a V2-style router, with a rate floor |
| `wrap QOR into WQOR on 0xWQOR` | native to wrapped, one for one |
| `unwrap WQOR to QOR on 0xWQOR` | wrapped to native, one for one |
| `deposit FUSD into vault 0xV as VFUSD at no worse than 0.99 VFUSD per FUSD` | ERC-4626 deposit with a share floor |
| `redeem VFUSD from vault 0xV for FUSD at no worse than 0.99 FUSD per VFUSD` | ERC-4626 redeem with an asset floor |

The spent token of every flow needs a cap. The output token is listed **receive-only** (zero caps) automatically.

## Rate floors

`at no worse than R OUT per IN` is the minimum the guard must actually receive per unit it spends. The compiler converts it to raw units using each token's decimals. There is no price oracle on QoreChain, so the floor is your own number: set it just under the price you accept, and review it when prices move.

## What gets refused

| Finding | Meaning |
|---|---|
| `flow-no-floor` | a swap, deposit or redeem without a rate floor |
| `flow-floor-units` | the floor is not in `OUT per IN` for that flow |
| `flow-floor-zero` | the floor rounds to zero in raw units (it would allow any rate) |
| `flow-uncapped` | the token the flow spends has no cap |
| `no-adapter` | no adapter address is configured for this kind of flow |
| `unknown-token` | the token is not in your token registry |
| `duplicate-flow` | the same route twice |
| `flow-unreadable` | a flow was mentioned but could not be parsed |

## What it tells you it cannot do

Every flow adds gaps to the report: the floor has no oracle; a route trusts its target contract; multi-hop swaps measure only the first input and the last output; QoreChain's native AMM cannot be called from a contract.

## Try it

```sh
pnpm compile "agent 0x7099… up to 100 FUSD a day, at most 40 FUSD per payment, swap FUSD for FETH on 0xROUTER at no worse than 0.0004 FETH per FUSD for 3 days" --tokens tokens.json --adapters adapters.json
```

`tokens.json` maps symbols to `{ "address": "0x…", "decimals": 18 }`; `adapters.json` is `{ "univ2": "0x…", "wrap": "0x…", "erc4626": "0x…" }`.
