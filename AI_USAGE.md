# AI usage

Leash was built with Claude Code (Claude Sonnet 5.5) working alongside the author, over three days.

## What the AI did
- Read QoreChain's documentation and the organisers' sample repository, and summarised the precompile interfaces, window rules and spending-rule behaviour.
- Proposed the design (the "classical key can only stop" rule) and wrote the first versions of `LeashGuard.sol`, its Foundry tests, the policy compiler, the attack suite and the testnet pipeline.
- Ran the tests, the local drill and the testnet run, and wrote this documentation.

## What the author decided
- Which track and which idea to build, the scope for three days, and every action on accounts and funds. The author signed in to the faucet; the AI claimed tokens for a throwaway testnet address only.
- Registration for the fest, and publishing.

## Where the AI was wrong, and how it was caught
- A test used `vm.expectRevert` and then called a helper that made its own external call, so three tests failed for the wrong reason. Found by running the tests; fixed by computing the signatures first.
- An edit to the testnet script dropped the last lines, so a command ran silently with exit code 0. Found because the output was empty; fixed and rerun.
- The first full testnet run stopped on a transient network error after deploying and arming the guard. The drill was made resumable so the guard was not redeployed.

## How the work is verified
The AI's claims are not trusted. They are checked by 21 contract tests (including a fuzz test), 10 compiler tests, a local end-to-end drill, a mutation check that breaks the contract three ways and confirms the drill fails each time, and a run on the real testnet with a genuine ML-DSA-87 signature.

## No model at runtime
The plain-English front end is a small deterministic grammar, not a language model. A model may help a person draft the sentence, but the compiler decides: anything it cannot parse exactly is refused.
