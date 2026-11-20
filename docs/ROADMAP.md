# Roadmap

## Done

- LeashGuard (v1): payments inside a post-quantum-gated mandate.
- LeashGuardV2: guarded actions (swap, wrap, ERC-4626) with measured rate floors.
- A deterministic plain-English compiler with value flows.
- A monitor with stop-only auto-freeze.
- An MCP server with 15 tools, and a skill.
- Real testnet runs: a real ML-DSA-87 mandate accepted by `pqcVerify`, five adapter actions, a 15 of 15 drill, an MCP swap.

## Before any mainnet use

1. **Independent audit** of the five contracts ([audit package](AUDIT_PACKAGE.md)), then a bug bounty.
2. **Chain support**: `pqcVerify` and the key registry active on mainnet. This is out of our hands.
3. **Owner key custody**: hardware-backed storage for the ML-DSA-87 key, and a signing flow people can use (wallet support for signing arbitrary messages, or a small signer app).
4. **A keeper** for window renewals, holding the agent account's ML-DSA-87 key off the agent's machine.
5. **A deployed monitor** with a stop-only freezer key and alerts someone answers.
6. **Real routers and tokens** (the QoreSwap router address is not published yet).
7. **A migration plan**: the guard is immutable, so a fix means a new guard.
8. **Staged rollout**: tiny caps, short expiries, one real route.

## Ideas

- A rolling window instead of a fixed 24-hour bucket.
- A threshold of post-quantum owners for high-value guards.
- Per-recipient caps and per-route caps.
- Guarded cross-VM calls, if QoreChain lets a contract move funds across VMs.
- A signer app and a hosted monitor.

## Questions for the QoreChain team

1. When will `pqcVerify` (0x…0a01) and `pqcKeyStatus` (0x…0a02) be active on mainnet, and is the gas cost stable?
2. What is the QoreSwap router address on testnet, and will it be on mainnet?
3. Is a precompile for the native AMM (`x/amm`) planned, so a contract can swap there?
4. Will QoreX sign arbitrary messages with the ML-DSA-87 key, so an owner can sign a mandate from a wallet?
5. Are EVM windows going to stay capped at about 6 hours?
6. Is there a published list of audited or recommended routers and vaults?
