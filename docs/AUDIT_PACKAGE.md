# Audit package

Everything an auditor needs to start, in one page. The contracts are small on purpose: 642 lines of Solidity in total.

## Scope

| File | Lines | Role |
|---|---|---|
| `src/LeashGuard.sol` | 206 | v1: payments, freeze, post-quantum-gated mandate |
| `src/LeashGuardV2.sol` | 338 | v2: v1 plus guarded actions (`execute`), routes, rate floors |
| `src/adapters/UniV2Adapter.sol` | 43 | decodes V2-router swaps (3 selectors) |
| `src/adapters/WrapAdapter.sol` | 23 | decodes `deposit()` and `withdraw(uint256)` |
| `src/adapters/Erc4626Adapter.sol` | 32 | decodes ERC-4626 `deposit` and `redeem` |

Out of scope: the TypeScript tooling, the MCP server, the mocks under `test/mocks`, and QoreChain's precompiles themselves.

Solidity 0.8.28, optimizer on (200 runs), Foundry. No upgradeability, no proxies, no external libraries; `forge-std` is used for tests only.

## External dependencies the contracts trust

| Dependency | Address | Used for |
|---|---|---|
| `pqcVerify` | `0x…0a01` | verify an ML-DSA-87 signature (raw message bytes) |
| `pqcKeyStatus` | `0x…0a02` | read the owner's registered ML-DSA-87 key and whether possession was proven |
| Route targets and tokens | owner-chosen | trusted only as far as the rate floor, caps and measurements |

## Invariants we believe hold

| # | Invariant | Tests |
|---|---|---|
| I1 | Only the agent can call `spend` and `execute`; both fail while frozen or expired | `test_onlyTheAgent_notFrozen_notExpired`, `test_expiryStopsActions` |
| I2 | Starting or loosening anything requires a valid ML-DSA-87 signature by the owner's registered key; the nonce increments | `test_mandateNeedsTheOwnersPqSignature`, `test_agentCannotLoosenRoutes` |
| I3 | A signature is bound to chain id, guard, nonce and mandate hash (and a v1/v2 domain string) | `test_mandateNeedsTheOwnersPqSignature` |
| I4 | The classical owner key and the agent can only call `freeze` | v1 and v2 drill rows |
| I5 | Within one 24-hour bucket, the total of `spend` and `execute` inputs of a token never exceeds its daily cap | `testFuzz_dailyCapHoldsAcrossActions` |
| I6 | `execute` only runs along a route that exists in the current mandate; replacing the mandate removes old routes | `test_unknownRouterOrAdapterIsNotARoute`, `test_replacingTheMandateClearsOldRoutes` |
| I7 | After `execute`, the guard's balance of `tokenOut` rose by at least `amountIn * floor / 1e18` | `test_rateFloorIsEnforcedOnWhatWasReceived`, `test_vaultThatSkimsDepositsIsCaught`, `test_routerThatDivertsOutputIsCaughtByMeasurement` |
| I8 | The adapter-reported output recipient is the guard | `test_outputMustGoToTheGuard` |
| I9 | Approvals granted during `execute` are zero afterwards | `test_noApprovalIsLeftOpen_evenIfTheRouterPullsLess` |
| I10 | No other listed token's balance falls; the input token falls by at most `amountIn` | defence in depth; see "Test limits" |
| I11 | `execute` cannot target the guard or the two precompiles | `test_cannotTargetTheGuardOrPrecompiles` |
| I12 | A route cannot be added with a zero floor, an unlisted token, an unspendable input, or as a duplicate | `test_badRoutesAreRefusedAtApply` |
| I13 | Reentrancy into `spend` or `execute` is impossible | `test_reentrancyIsBlocked` |

## Reproduce

```sh
git clone https://github.com/David-glitc/leash && cd leash
pnpm install
forge install foundry-rs/forge-std --no-git
forge test                         # 79 tests: unit, fuzz and 8 stateful invariants
pnpm test                          # plus 30 TypeScript tests
pnpm verify                        # read-only check of the live testnet deployment
```

### Mutation testing

`python3 tools/mutate.py` generates 181 mutants across the five contracts (deleted checks, flipped comparisons, swapped operators, removed `delete`s and events, changed constants, a removed modifier) and runs the whole suite against each in an isolated copy. **179 of 181 are killed (98.9%).** The two survivors are equivalent mutants (details in [VERIFICATION.md](VERIFICATION.md)). The first round killed 64.6%; the survivors exposed real gaps, which the current 79 tests close.

### Static analysis, attack campaign

Slither: 0 high, 2 medium (triaged in [VERIFICATION.md](VERIFICATION.md)). `pnpm campaign` fires 800 random hostile calls at the live guard and checks every accepted call against an independent oracle: 0 violations.

## Deployed on qorechain-diana

| Contract | Address |
|---|---|
| LeashGuard (v1) | `0xa0ebb5daf8229da498346f0c824276d126c2a34c` |
| LeashGuardV2 | `0x6781ab2c589469ab91790d1a40a7de1f6d5135eb` |
| UniV2Adapter | `0xdf0c745e0452fce3d6b9d8aa65f9b5440939c6e7` |
| WrapAdapter | `0x6b2b670408d2ae86199a25246e3e70848ee54865` |
| Erc4626Adapter | `0x93c687e94d5f2cad1578ca1179cb560da7710fcd` |

`pnpm verify` compares the deployed v2 runtime code to the local build (immutables masked).

## Test limits, plainly

- Invariant I10 is now exercised with deliberately misbehaving mock tokens (a token whose balance falls during a call), in addition to being defence in depth.

- The EVM tests use a **stand-in** for the precompiles (a signature is valid when it equals `keccak256("ok", pubkey, message)`). The real `pqcVerify` was exercised only on the testnet, by the live runs.
- The fuzz test covers swaps and payments of one token against one cap; multi-token interactions are covered by example tests only.
- No formal verification, no invariant-testing campaign beyond the fuzz test, no independent review.

## Questions we would like an auditor to answer

1. Is the measured-balance approach in `execute` sound for tokens with fees on transfer, rebasing, or callbacks?
2. Can a hostile adapter (one the owner was tricked into allowing) do more than the floor and caps allow?
3. Is the fixed 24-hour bucket a weakness we should replace with a rolling window?
4. Are there gas-griefing or ordering issues around `applyMandate` being callable by anyone?
5. Is it safe to read the owner's key from `pqcKeyStatus` on every `applyMandate` call, including during a key rotation?
