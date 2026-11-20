# How Leash is verified

A claim about a contract that holds an agent's money is only worth what has been done to try to break it. Leash is checked eight ways, each of which can fail, and every number below is reproducible with one command.

| # | Layer | Result | Reproduce |
|---|---|---|---|
| 1 | **Unit and attack tests** (Foundry) | 79 tests pass: 29 for `LeashGuard`, 42 for `LeashGuardV2` and its adapters, 8 invariants | `forge test` |
| 2 | **Invariant testing** (stateful fuzzing) | 8 invariants hold over 15,360 random calls each (256 runs of depth 60) | `forge test --match-contract LeashInvariants` |
| 3 | **Automated mutation testing** | **179 of 181 mutants killed (98.9%)** across all five contracts; survivors listed and triaged below | `python3 tools/mutate.py` |
| 4 | **Static analysis** (Slither, 81 detectors) | 0 high, 2 medium (triaged), 10 low, 5 optimization; none exploitable | `slither . --filter-paths "lib\|test\|mocks"` |
| 5 | **Attack campaign on the live testnet** | 800 random hostile calls, **0 violations**; 138 accepted, all inside the mandate | `pnpm campaign --n 800 --seed 20261120` |
| 6 | **The Q-Day drill** | 15 of 15 on the real testnet, 16 of 16 locally (a leaked agent key and a leaked owner key) | `pnpm demo:local:v2` |
| 7 | **Live-chain verification** | 22 read-only checks, including that the deployed bytecode equals this source | `pnpm verify`, or the [Try it page](https://leash.kierkegaard.space/try/) in your browser |
| 8 | **Real transactions** | A real ML-DSA-87 mandate accepted by `pqcVerify`, five adapter actions, an MCP swap and wrap | `pnpm verify` |

`pnpm check` runs layers 1, 2 and the TypeScript tests, and the local end-to-end demos. The documentation site builds separately (`pip install markdown && python3 site/build.py`). The same checks are written as a GitHub Actions workflow (`ci/github-actions.yml`) that is not enabled yet, because GitHub currently refuses to start jobs for the account (billing lock).

## 1 and 2: tests and invariants

The invariant handler fires random sequences of agent actions (payments, swaps with random under-delivery, swaps that send the output to an attacker), attacker and owner-key calls, freezes by owner, agent and stranger, time warps up to two days, and fresh owner-signed mandates. After every step these must hold:

- the USD moved by the agent in any 24-hour bucket never exceeds the daily cap, payments and swaps together;
- the spent counter never exceeds the cap;
- no one who must not act ever succeeds, and the attacker never receives a token;
- no action succeeds while frozen;
- every swap that succeeded met the owner's rate floor;
- no approval is left open;
- a receive-only token only ever grows through the guard's own events;
- the nonce never goes backwards.

We checked the invariants can fail: removing the cap charge, or letting the output go to anyone, each turns one of them red.

## 3: mutation testing

`tools/mutate.py` breaks the contracts one small change at a time in an isolated copy (a deleted check, a flipped comparison, a swapped operator, a removed `delete`, a dropped event, a changed constant, a removed modifier) and runs the whole suite against each break. A mutant the tests catch is *killed*; one that passes is a *survivor* and is either an equivalent change or a gap in the tests.

**Round 1** (the original 46 tests): 117 of 181 killed, 64.6%. The 64 survivors were real gaps: events never asserted, storage not checked after re-arming a mandate, exact-boundary cases (spending exactly the cap, exactly 16 items, exactly one day), failed-transfer handling, the V2 payment path, the reentrancy lock and the three defence-in-depth outflow checks.

**Round 2** (79 tests, written to kill those survivors): 179 of 181 killed, 98.9%.

**The two survivors are equivalent mutants** (the change cannot alter behaviour), so they are not gaps:

| Mutant | Why it is equivalent |
|---|---|
| `LeashGuard.sol:196` `spent >= daily` changed to `spent > daily` in `remainingToday` | When `spent` equals `daily`, both forms return 0 (`daily - spent` is 0). |
| `LeashGuardV2.sol:188` `a < b` changed to `a <= b` in the outflow check | When `a` equals `b`, `b - a` is 0, which is never greater than `amountIn`, so the revert condition is false either way. |

The full per-mutant results are in [`reports/mutation.json`](../reports/mutation.json).

## 4: static analysis

[`reports/static-analysis.json`](../reports/static-analysis.json) holds the Slither output. Nothing high. Triage:

| Finding | Where | Decision |
|---|---|---|
| `unused-return` (medium) | `pqcKeyStatus` ignores `algorithmId` | Intentional. The chain returns `algorithmId` 1 for the registered ML-DSA-87 key (2,592-byte public key). `pqcVerify` only accepts a key of that algorithm, so a key of another kind simply fails verification. |
| `missing-zero-check` (low) | constructor `owner_` | A zero owner makes the guard permanently frozen at deployment (`pqcKeyStatus(0)` is never registered). It is a self-inflicted dead guard, not a loss of funds. Accepted. |
| `timestamp` (low, 7) | expiry and the 24-hour bucket | Intended. The mandate is time-bounded by design; a validator can shift a timestamp by seconds, not hours. |
| `calls-loop` (low) | `_balance` inside `execute` | Bounded by `MAX_ITEMS` (16) and intended: the guard measures every listed token. |
| `cache-array-length` (optimization, 5) | loops over storage arrays | Gas only. We left the deployed contracts unchanged. |

## 5: the attack campaign

`tools/campaign.ts` fires random hostile calls at the **live** guard as a leaked agent key, the owner's classical key and a stranger: payments and swaps with boundary and hostile arguments (zero, cap, cap plus one, remaining, remaining plus one), wrong routers, unlisted tokens, outputs sent elsewhere, junk call data, forged mandates with empty, short and 4,627-byte random signatures, and freezes. Calls are simulated with `eth_call`, so nothing is sent.

An independent oracle, written from the mandate alone, decides for every *accepted* call whether the mandate allowed it. Any accepted call it did not allow is a violation. The result is 0 violations in 800 calls, with 65 legitimate agent actions accepted, so the campaign is not "refuse everything". 22 within-mandate calls were refused, and they are explained: the mandate deliberately includes a router that under-delivers (`BelowRateFloor`), and some swaps or redeems were larger than the test balance (`ExecFailed`). The run is reproducible from its seed.

## What this still does not prove

- It is **not an audit**. Layers 1 to 5 test the code against our own idea of correct. An independent reviewer may disagree with that idea.
- The EVM tests use a **stand-in** for the post-quantum precompiles. The real `pqcVerify` was exercised only on the testnet, by the live runs.
- The three outflow checks inside `execute` are defence in depth and are exercised only with deliberately misbehaving mock tokens.
- No formal verification (Halmos, Certora) and no long-running invariant campaign beyond the figures above.
- Everything is testnet. See the [threat model](THREAT_MODEL.md) and the [audit package](AUDIT_PACKAGE.md).
