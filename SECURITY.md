# Security

Leash holds simulated value on a testnet today and is **unaudited**. Do not put funds you cannot lose into it.

## Reporting a vulnerability

Please report privately through GitHub: **Security, then "Report a vulnerability"** on <https://github.com/David-glitc/leash>. Do not open a public issue for a vulnerability. We will acknowledge within a few days. There is no bounty yet.

## Scope

In scope: `src/` (the guards and adapters), `tools/policy.ts` (the compiler), `mcp/server.ts` (the MCP server), `tools/monitor.ts`.

Out of scope: QoreChain itself and its precompiles, third-party routers and tokens, the test mocks.

## What we already know

The [threat model](docs/THREAT_MODEL.md) lists the known limits: no price oracle, trusted route targets, owner post-quantum key custody, fixed daily bucket, testnet only. The [audit package](docs/AUDIT_PACKAGE.md) lists the invariants and the test limits.

## Keys

Never commit a private key or mnemonic. `.env` is gitignored. The testnet scripts use throwaway accounts only.
