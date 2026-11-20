# Leash for agent harnesses (MCP server and skill)

An MCP server and an agent skill, so a harness such as Hermes Agent, Claude Code, Cursor or OpenClaw can pay on QoreChain **through a LeashGuard**. The chain enforces the owner's mandate. The agent holds only its own secp256k1 key and has no tool that loosens anything.

```
agent harness ──MCP──> leash server ──agent key──> LeashGuard ──> recipient
                                                     │  caps, allowlist, expiry, freeze
                                                     └─ loosening needs the owner's ML-DSA-87 signature (pqcVerify)
```

## Tools

| Tool | What it does | Sends a transaction |
|---|---|---|
| `leash_status` | Frozen or expired, caps, remaining allowance today, allowlist, guard balance | No |
| `leash_check` | Dry-run a payment; returns `allowed` or the guard's refusal name | No |
| `leash_pay` | Pay from the guard with the agent key. Needs `confirm: true` | Yes |
| `leash_freeze` | Kill switch. The agent may freeze itself; only an owner-signed mandate unfreezes. Needs `confirm: true` | Yes |
| `leash_compile` | Plain-English leash to a validated mandate, plan and gap list. Deterministic, no model | No |
| `leash_loosen_prepare` | Ask for more room: compile the new leash and return the exact message the owner must sign | No |
| `leash_drill_local` | Run the Q-Day drill on a local Anvil node (needs Foundry) | No (local only) |

Against a **LeashGuardV2** the server adds guarded actions. Each one simulates first, shows the expected output, and sends only with `confirm: true`:

| Tool | What it does |
|---|---|
| `leash_routes` | The actions the mandate allows, with each route's target and the owner's rate floor |
| `leash_swap` | Swap through an allowed router (use `QOR` for the native coin); output goes to the guard |
| `leash_wrap`, `leash_unwrap` | Native to wrapped token and back, one for one |
| `leash_vault_deposit`, `leash_vault_redeem` | ERC-4626 vault deposit and redeem; shares stay in the guard |
| `leash_execute` | Raw call data through an adapter, for advanced use. The guard still checks route, caps, output and floor |
| `leash_monitor` | The monitor's rules once, over recent guard events |

Set `LEASH_ADAPTERS` (`{"univ2":"0x…","wrap":"0x…","erc4626":"0x…"}`) so the server can build calls. A v1 guard supports payments only; the server detects the version.

There is deliberately no tool that applies a mandate or signs for the owner.

## Install

```sh
git clone https://github.com/David-glitc/leash && cd leash
pnpm install
pnpm mcp:smoke        # read-only check against the live testnet guard
```

Set these in the harness's server config (the agent's key only, never the owner's):

| Variable | Meaning |
|---|---|
| `LEASH_GUARD` | Guard address (required for on-chain tools) |
| `LEASH_AGENT_KEY` or `LEASH_AGENT_MNEMONIC` | The agent's key, needed for `leash_pay` and `leash_freeze` |
| `LEASH_RPC` | EVM RPC, default `https://evm-testnet.qore.host` |
| `LEASH_CHAIN_ID` | Default `9800` (qorechain-diana) |
| `LEASH_TOKENS` | JSON registry for ERC-20s, e.g. `{"FUSD":{"address":"0x…","decimals":6}}` (QOR is built in) |

Point the harness at the `tsx` binary, not at `pnpm run`: pnpm prints a banner on stdout and breaks the MCP stream.

### Hermes Agent
`~/.hermes/config.yaml` (see [`examples/hermes-config.yaml`](../examples/hermes-config.yaml)), then `/reload-mcp`:

```yaml
mcp_servers:
  leash:
    command: "/path/to/leash/node_modules/.bin/tsx"
    args: ["/path/to/leash/mcp/server.ts"]
    env:
      LEASH_GUARD: "0xa0ebb5daf8229da498346f0c824276d126c2a34c"
      LEASH_AGENT_KEY: "0x..."
```
Skill: copy `skills/leash/` to `~/.hermes/skills/leash/`.

### Claude Code
Project `.mcp.json` (see [`examples/mcp.json`](../examples/mcp.json)) or `claude mcp add -s project leash -e LEASH_GUARD=0x… -e LEASH_AGENT_KEY=0x… -- /path/to/leash/node_modules/.bin/tsx /path/to/leash/mcp/server.ts`. Skill: copy `skills/leash/` to `.claude/skills/leash/`.

### Cursor, OpenClaw
Cursor: the same `mcpServers` block in `.cursor/mcp.json`. OpenClaw: add a server with the same command and arguments (`openclaw mcp add`); the exact config file path is not verified here.

Use it next to QoreChain's own read-only MCP (`npx -y @qorechain/mcp`, 14 tools for chain reads, fee estimates and unsigned transfers). That one never signs; Leash is the part that spends, inside limits.

## Proof on the real testnet
[`reports/mcp-live-demo.json`](../reports/mcp-live-demo.json) is the transcript of an MCP client driving the live guard on qorechain-diana (`pnpm testnet rearm` armed it with a second owner-signed ML-DSA-87 mandate, nonce 2, then `pnpm mcp:live`):

- `leash_pay` of 0.1 QOR succeeded as a real transaction.
- `leash_check` of 5 QOR was refused by the chain: `OverPerTxLimit`.
- `leash_check` to an address off the allowlist was refused: `RecipientNotAllowed`.

## What is not covered, said plainly
- **Swaps are guarded only on EVM routers.** QoreChain's native AMM (`x/amm`) has no precompile, so a Solidity guard cannot call it, and the QoreSwap router address is not published. LeashGuardV2 guards swaps on any Uniswap-V2-style router; the testnet run uses our own test router and test tokens. Rate floors have no price oracle behind them. See [docs/ACTIONS.md](../docs/ACTIONS.md).
- **Bridging is not usable.** The chain's bridge module has configurations but no live route and no bridge validators (docs: do not send assets expecting them to be bridged). The one IBC test channel needs your own relayer and sits outside the guard. Leash does not pretend to protect it.
- **Only the guard's funds are limited.** Bank coins, native-lane staking and anything the agent's own account holds are outside it. Keep that account near zero.
- **A competing primitive exists.** QoreChain's `x/abstractaccount` (testnet only) has chain-level spending rules. Leash's difference is the key split: loosening needs a separate post-quantum signature that the agent and the classical owner key can never produce.
- **Testnet only.** `pqcVerify` and the guard are not active on mainnet. The guard is not audited.
