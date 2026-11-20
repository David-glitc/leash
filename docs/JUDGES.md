# Judge's guide: verify Leash in five minutes

Leash is a spending and action leash for AI agents on QoreChain. A classical key can only **stop** things; starting or loosening anything needs an **ML-DSA-87** signature, verified on chain by `pqcVerify`. This page tells you where to check each claim yourself. Nothing here asks you to trust our words: every row has a command or a link.

## The fest checklist

| Requirement | Where it is |
|---|---|
| Public repository, Apache-2.0 | <https://github.com/David-glitc/leash> ([LICENSE](../LICENSE)) |
| README | [README.md](../README.md) |
| Cover image (16:9, 1600x900) | [cover.png](../cover.png) |
| Video, under 3 minutes | 2:56, <https://david-film-library.pages.dev/media/leash-demo.mp4> |
| Testnet addresses | `qor1n7jzhw6pmznuzvfruwlqs6mehjfykf6sdqru99` (owner), `qor18cfh4g3ryryesszuj9a23f6dvllj83c9s689ud` (agent) |
| Commits during the fest | `git log` (every commit is dated November 2026) |
| AI-Native award: `AI_USAGE.md` | [AI_USAGE.md](../AI_USAGE.md): what the AI did, what the author decided, where the AI was wrong |
| Kits used | `@qorechain/sdk` and `@qorechain/evm` (verified by the fest site), hybrid transactions, key registration, scoped EVM windows, `pqcVerify` and `pqcKeyStatus` from Solidity |

## Check the chain yourself (no install)

All of this is public on `qorechain-diana` (EVM chain id 9800). The guard and transactions below are real.

```sh
RPC=https://evm-testnet.qore.host
# 1. the v2 guard has code on chain
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x6781ab2c589469ab91790d1a40a7de1f6d5135eb","latest"]}' | head -c 120
# 2. the transaction where the owner's real ML-DSA-87 signature was accepted by pqcVerify (status 0x1)
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xd588cfa9e6f77c7a65a815a439bb0e572fed0002ecbb6dd6037d626414fd58bc"]}' | head -c 400
```

## Check everything with one command

```sh
git clone https://github.com/David-glitc/leash && cd leash
pnpm install
pnpm verify
```

`pnpm verify` is read-only and needs no keys (22 checks). It reads the live testnet and checks:

- both guards exist and their owner is the registered owner account;
- the deployed v2 bytecode equals what this source compiles to (immutables masked);
- the two `applyMandate` transactions (v1 and v2) succeeded, so `pqcVerify` accepted a real ML-DSA-87 signature;
- the five adapter transactions (wrap, unwrap, vault deposit, vault redeem, swap) succeeded and each emitted the guard's `Executed` event;
- the two MCP transactions (a swap and a wrap made by an MCP client) succeeded;
- the drill reports are internally consistent (15 of 15 on testnet, 16 of 16 locally);
- the attack-campaign report (800 random attacks, zero violations) and the mutation report (179 of 181 mutants killed) are present and consistent.

See [How Leash is verified](VERIFICATION.md) for the eight layers and how to reproduce each.

## Run the tests and demos locally

Needs [Foundry](https://getfoundry.sh), Node 22 and pnpm.

```sh
pnpm test            # 79 contract tests (incl. 8 invariants) + 30 TypeScript tests
pnpm demo:local:v2   # every adapter, then the Q-Day drill for actions (16 checks)
pnpm demo:monitor    # the monitor catches a burst and an unexplained outflow and freezes with a stop-only key
pnpm mcp:e2e         # an MCP client drives swaps, wraps and vaults through the server (24 checks)
```

## What is real, and what is simulated

| Thing | Status |
|---|---|
| ML-DSA-87 signature verified by `pqcVerify` on testnet | **Real.** The owner's actual key signed; the chain accepted it. |
| Guard deployment, mandates, the five adapter actions, the MCP swap and wrap | **Real transactions** on qorechain-diana. |
| The "blocked" rows of the testnet drill | **Simulated calls** that revert as expected (`eth_call`). A blocked call sends no transaction. |
| Router, tokens, vault used in the testnet run | **Our own test contracts.** QoreSwap's router address is not published. |
| Expiry check | Proven on a local node, where time can be moved. |
| Mainnet | **Not available.** `pqcVerify` is testnet-only today. |

## Where to look in the code

| File | What it is |
|---|---|
| [src/LeashGuardV2.sol](../src/LeashGuardV2.sol) | The guard: payments, guarded actions, the freeze, the post-quantum-gated mandate |
| [src/adapters/](../src/adapters) | Three stateless adapters: V2 router, wrapped native, ERC-4626 vault |
| [test/LeashGuardV2.t.sol](../test/LeashGuardV2.t.sol), [test/LeashInvariants.t.sol](../test/LeashInvariants.t.sol) | 42 tests, a fuzz test, and 8 stateful invariants |
| [tools/policy.ts](../tools/policy.ts) | The plain-English compiler (a grammar, not a model) |
| [tools/attack-v2.ts](../tools/attack-v2.ts) | The Q-Day drill: a leaked agent key and a leaked owner key |
| [tools/monitor.ts](../tools/monitor.ts) | The monitor and its stop-only auto-freeze |
| [mcp/server.ts](../mcp/server.ts) | The MCP server (15 tools) |

## What we did not do

We did not audit the contracts, we did not run on mainnet, and we did not build bridging. [THREAT_MODEL.md](THREAT_MODEL.md) lists every known limit, and [FAQ.md](FAQ.md) answers the questions we expect.
