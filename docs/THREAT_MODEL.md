# Threat model

Leash protects the funds an AI agent controls. This page lists who can do what, what we assume, and what stops each attack. Every "stopped by" points at a test or a run you can reproduce.

## Assets

1. **The guard's funds** (native QOR and ERC-20s held by a `LeashGuard` or `LeashGuardV2`).
2. **The mandate**: the caps, recipients, routes and rate floors the owner signed.
3. **The kill switch**: the ability to stop spending quickly.

## Actors and keys

| Actor | Holds | May |
|---|---|---|
| Agent | a secp256k1 key | spend and act inside the mandate; freeze |
| Owner, classical | a secp256k1 key (the guard's immutable `owner`) | **freeze only** |
| Owner, post-quantum | an ML-DSA-87 key registered on chain | sign a new mandate (start, loosen, re-arm) |
| Anyone | nothing | submit a signed mandate |

## Assumptions

- The ML-DSA-87 key is safe. If it leaks, the owner's authority is lost. See "Owner post-quantum key" below.
- QoreChain's `pqcVerify` (0x…0a01) and `pqcKeyStatus` (0x…0a02) behave as documented. The guard reads the owner's public key from the chain's registry, so a caller cannot substitute one.
- The EVM executes the contract as written. The contract has not been independently audited.

## Attacks and what stops them

| # | Attack | Stopped by | Evidence |
|---|---|---|---|
| 1 | Agent key leaks; attacker spends more than the cap | per-action and daily caps, shared by payments and actions | `test_capsApplyToActions_andShareTheBucketWithSpend`, fuzz test `testFuzz_dailyCapHoldsAcrossActions` |
| 2 | Attacker pays an address that is not allowed | recipient allowlist | drill row `RecipientNotAllowed` |
| 3 | Attacker loosens its own limits | `applyMandate` needs an ML-DSA-87 signature over the whole mandate | `test_agentCannotLoosenRoutes`, drill rows `BadPqcSignature` (testnet: real chain) |
| 4 | Owner's **classical** key leaks; attacker grants itself power | classical key can only `freeze`; `applyMandate` has no classical path | drill: "owner key grant itself a bigger mandate" is blocked |
| 5 | Replay an old or foreign signature | the signed message binds the chain id, this guard, a nonce and the mandate hash | `test_mandateNeedsTheOwnersPqSignature`; drill: replay from a different guard blocked |
| 6 | Quantum computer breaks secp256k1 | both classical keys can only stop things; loosening is post-quantum | design; the whole drill |
| 7 | Router under-delivers or lies about a quote | rate floor checked on the **measured** balance change | `test_rateFloorIsEnforcedOnWhatWasReceived`, `test_vaultThatSkimsDepositsIsCaught`; testnet drill row `BelowRateFloor` |
| 8 | Router sends the output to the attacker | output recipient must be the guard, and received amount is measured | `test_outputMustGoToTheGuard`, `test_routerThatDivertsOutputIsCaughtByMeasurement` |
| 9 | Call data that the adapter does not understand | adapter reverts; no route, no action | `test_unsupportedCallDataIsRefused`; drill row `BadAction` |
| 10 | Action through an unlisted router or adapter | route lookup | `test_unknownRouterOrAdapterIsNotARoute`; drill row `RouteNotAllowed` |
| 11 | Approval left open to a router | approvals are exact and reset to zero after every call | `test_noApprovalIsLeftOpen_evenIfTheRouterPullsLess` |
| 12 | Reentrancy through a malicious target | lock on `spend` and `execute`; callers other than the agent are refused anyway | `test_reentrancyIsBlocked` |
| 13 | Target is the guard itself or a precompile | refused | `test_cannotTargetTheGuardOrPrecompiles` |
| 14 | Stale mandate keeps spending | expiry; the guard starts frozen | `test_expiryStopsActions` |
| 15 | Fast drain by a leaked key before anyone notices | the monitor flags bursts and unexplained outflows and can freeze with a stop-only key | `pnpm demo:monitor`; `tools/monitor.test.ts` |

## Not stopped, on purpose or by limitation

| Limit | Why it matters | What to do |
|---|---|---|
| **No price oracle.** A rate floor is the owner's own number. | A stale floor blocks good trades or allows bad ones. Market moves and sandwiches inside the floor are not prevented. | Set tight floors, short expiries, small caps; review floors when prices move. |
| **Route targets are trusted.** | A malicious or upgraded router is bounded by the floor and the caps, not removed. | Route only to contracts you have read; prefer immutable routers. |
| **Owner post-quantum key leak.** | The attacker can sign any mandate. | Hardware-backed storage; short mandates; the monitor flags `mandate-changed`; freeze first, then rotate the guard. |
| **Owner post-quantum key loss.** | Mandates cannot change. | The kill switch still works. Deploy a new guard and migrate. |
| **Funds outside the guard.** | Limits cover only what the guard holds. | Keep the agent's own account near zero. |
| **Fixed 24-hour daily bucket.** | An agent can spend one cap at the end of a bucket and another at the start of the next. | Choose caps that are safe doubled. |
| **Window renewals.** | The chain caps an EVM window at about 6 hours; long mandates need a keeper holding the agent account's ML-DSA-87 key. | Keep that key off the agent's machine. |
| **Unaudited code.** | Bugs may exist despite 46 tests and mutation checks. | Independent audit before any mainnet use ([AUDIT_PACKAGE.md](AUDIT_PACKAGE.md)). |
| **Testnet only.** | `pqcVerify` is not active on mainnet. | See [ROADMAP.md](ROADMAP.md). |
| **Native AMM and bridges** | QoreChain's native AMM cannot be called from a contract; no bridge route is live. | Out of scope. Leash does not claim to guard them. |

## Defence in depth inside `execute`

After every action the guard checks that no *other* listed token's balance fell and that the spent token fell by at most the declared amount. With well-behaved tokens a route cannot trigger these checks, so our tests cover them only as far as the mocks allow. They are there for the day a listed token or target misbehaves.
