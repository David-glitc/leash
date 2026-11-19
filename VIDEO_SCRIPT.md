# Demo video script (target 2:40, limit 3:00)

Record the terminal at 1080p, font large. Cover image on screen for the first 3 seconds. No music needed.

| Time | Show | Say |
|---|---|---|
| 0:00 | `cover.png` | "AI agents hold a classical key. If it leaks, or quantum breaks it, the agent can be drained, and a spending limit doesn't help if the same key can raise it. Leash fixes that with one rule: a classical key can only stop things." |
| 0:20 | README table (Agent / Owner classical key / Owner ML-DSA-87 key) | "The agent spends inside a mandate. The owner's classical key can only freeze. Starting or loosening anything needs an ML-DSA-87 signature, verified on chain by the pqcVerify precompile." |
| 0:45 | `pnpm compile "agent 0x… up to 3 QOR a day, at most 1 QOR per payment, only to 0x… for 3 hours"` | "You write the leash in plain English. A small deterministic compiler turns it into a mandate and an on-chain plan, and it lists the gaps the chain does not enforce." |
| 1:05 | `pnpm compile "agent 0x… spend lots of money"` | "Anything vague is refused. No silent defaults." |
| 1:15 | Explorer page for the guard and `reports/testnet-drill.json` (`applyTx`) | "On the QoreChain testnet, the owner signs the mandate with a real ML-DSA-87 key and the guard accepts it on chain." |
| 1:35 | `pnpm testnet drill` output | "Then the Q-Day drill: a leaked agent key and a leaked owner key attack the guard. Overspending, wrong recipient, forged signature, replay across guards, spending as the owner: all blocked. The freeze works. A legitimate payment succeeds, so it isn't just refusing everything." |
| 2:05 | Mutation check: break the guard, drill fails (`13/14`, `9/14`) | "And the drill can fail: when I deliberately remove the per-payment cap, or the post-quantum check, it catches it." |
| 2:25 | README "Honest limits" | "Honest limits: the blocked checks on testnet are simulated calls, token limits are proven locally, and the guard isn't audited." |
| 2:40 | Repo URL and the cover | "Leash. Open source, Apache 2.0." |

Before recording: `pnpm testnet status` to confirm the accounts still have QOR. For the mutation segment, temporarily delete the per-payment check in `src/LeashGuard.sol`, run `forge build && pnpm demo:local`, then `git checkout src/LeashGuard.sol`.
