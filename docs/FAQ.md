# FAQ

## Why not just use QoreChain's own spending rules?

QoreChain's account-abstraction module (testnet only) already has chain-level spending rules, and Leash is built to sit beside them. They differ in three ways. First, the chain's EVM window counts an ERC-20 transfer as zero value, so token caps need a contract. Second, loosening a QoreChain rule does not need a separate post-quantum signature; in Leash, loosening needs an ML-DSA-87 signature that neither the agent nor the classical owner key can produce. Third, Leash measures what an action actually returned and enforces the owner's rate floor on it.

## What does the post-quantum signature actually protect?

The authority to change the leash. A quantum computer can forge secp256k1 signatures, so any rule that a secp256k1 key can change is only as strong as secp256k1. In Leash, secp256k1 keys can only freeze. Raising a cap, adding a route or unfreezing needs the ML-DSA-87 signature, which `pqcVerify` checks on chain against the key the owner registered.

## Is the compiler an AI?

No. It is a deterministic grammar with a test suite. A model may help a person draft the sentence, but the compiler decides: anything it cannot parse exactly is refused, and every default it applies is reported as a warning.

## What if the owner's post-quantum key leaks?

The attacker can sign any mandate, which is the worst case. The monitor reports `mandate-changed`, short mandates limit the window, and the classical kill switch still works. Store the key in hardware-backed storage and keep mandates short. See the [threat model](THREAT_MODEL.md).

## What if the owner's post-quantum key is lost?

The mandate cannot change. The classical owner key can still freeze, so you can stop spending. Deploy a new guard and migrate funds.

## Why is the testnet router a test contract?

QoreSwap's router address is not published, and QoreChain's native AMM cannot be called from a contract. The guard works with any Uniswap-V2-style router, so the testnet run uses our own test router and test tokens. That is why the demo says so.

## The testnet drill's blocked rows are simulated. Is that a weakness?

A blocked call sends no transaction, so there is nothing to mine. The simulations are `eth_call`s against the live guard, so they hit the same code that would run. Everything that *succeeds* in the drill (the control swap, the freeze, the mandate) is a real transaction, and the local drill runs every row against a real node. `pnpm verify` lets you check the real transactions yourself.

## How much was written by AI?

A lot. [AI_USAGE.md](../AI_USAGE.md) says what the AI did, what the author decided, and three places the AI was wrong and how each was caught (including a mutation check that first survived). The code is tested against its claims, not trusted.

## Is it production-ready?

No. The contracts are unaudited, mainnet does not have `pqcVerify` yet, and rate floors have no price oracle. See the [roadmap](ROADMAP.md).

## Can an agent drain the guard with many small actions?

Not past the daily cap. Payments and actions share one bucket per token, and a fuzz test checks that random mixes of swaps and payments never move more than the cap in a bucket. The fixed 24-hour bucket means an agent can use one cap at the end of a bucket and another at the start of the next, so choose caps that are safe doubled.

## Why does the guard start frozen?

So that a freshly deployed guard cannot spend until the owner's first signed mandate. Applying a mandate unfreezes it.

## Can anyone submit a mandate?

Yes, and that is safe: the signature binds the chain id, the guard, a nonce and the whole mandate, so a submitter cannot change anything or reuse it. This lets a relayer pay the gas.

## Does it work on other chains?

The pattern needs an on-chain verifier for a post-quantum signature. QoreChain provides it as the `pqcVerify` precompile; on a chain without one you would need a verifier contract, which is expensive. We built it for QoreChain.

## How does an agent use it?

Through the MCP server and skill. The agent calls `leash_status`, `leash_check` and then `leash_pay`, `leash_swap` and friends. Every action simulates first and sends only with `confirm: true`. There is no tool that loosens a mandate.
