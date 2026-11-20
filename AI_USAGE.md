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

- While building v2, one of the contract mutation checks (leaving an approval open after a call) survived the first test suite, because the mock router consumed the whole approval. Found by running the mutation; fixed by adding a router that pulls less than approved. A test token with no code made several happy-path tests fail for the wrong reason, found by reading the revert.
- The first live testnet run of the swap drill showed a FAIL row: the router itself refused an under-delivering swap before the guard's own rate-floor check could, so the row did not test what its name said. Fixed by having the simulated attacker set the minimum output to zero.

## What the AI did for v2
- Designed LeashGuardV2 (routes, measured value flows, rate floors), the adapters, the plain-English flow grammar, the monitor rules and the MCP execution tools, and ran them: 25 more contract tests, six mutation checks, a local drill, an MCP end-to-end test and a live testnet run.
- Research on QoreChain's bridge, AMM, payment features and agent harness formats was delegated to a Claude Opus sub-agent working read-only from public documentation; its findings (no live bridge route, native AMM not callable from a contract) shaped what is and is not claimed.
- Wrote the judge's guide, threat model, audit package, FAQ and roadmap, the read-only `pnpm verify` script (which reads the live testnet and compares the deployed bytecode to this source; one changed constant in the source turns it red), and the documentation site at leash.kierkegaard.space, which is built from the same markdown.
- The author decided to extend the project, publish the site, and every action on accounts and funds.

## How the work is verified
The AI's claims are not trusted. They are checked by 21 contract tests (including a fuzz test), 10 compiler tests, a local end-to-end drill, a mutation check that breaks the contract three ways and confirms the drill fails each time, and a run on the real testnet with a genuine ML-DSA-87 signature.

## Demo video
- **Voiceover:** generated locally with Kokoro-82M (Apache-2.0, ONNX build from `onnx-community/Kokoro-82M-v1.0-ONNX`, voice `af_heart`). The script is the author's design, written with the AI. No real person's voice is imitated.
- **Music and sound effects:** original, synthesized locally with numpy (pad, bass, arpeggio, ticks, whooshes, stamps, chimes). No samples and no third-party music.
- **Motion graphics:** built as a HyperFrames project (HTML rendered to video). Every terminal output on screen is copied by script from the real command output, unchanged.
- **How it was made:** the video and the agent research were delegated to Claude Opus sub-agents working under my instructions. I checked the finished file myself (format, loudness, a spread of frames) before publishing. Neither the voice nor the music has been verified by ear by the AI.

## Verification work (written by the AI, results measured)
- An automated mutation-testing tool, 8 stateful invariants, a Slither run and triage, a randomized attack campaign against the live guard with an independent oracle, and 33 more tests. The first mutation round killed only 64.6% of 181 mutants, which is what the AI reported; the survivors were real gaps (events, re-arm cleanup, boundary cases, transfer failures, the V2 payment path, the reentrancy lock). After the new tests the figure is 179 of 181, and the two survivors are equivalent changes.
- Two mistakes caught on the way: a stale build left over from deliberately breaking the contract made the bytecode check fail (found because `pnpm verify` went red; fixed by rebuilding), and the attack-campaign oracle first mislabelled a vault deposit's input token, which showed up as a false violation (fixed in the oracle, not the contract).

## No model at runtime
The plain-English front end is a small deterministic grammar, not a language model. A model may help a person draft the sentence, but the compiler decides: anything it cannot parse exactly is refused.
