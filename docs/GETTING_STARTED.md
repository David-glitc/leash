# Getting started

Needs [Foundry](https://getfoundry.sh), Node 22 and pnpm.

```sh
git clone https://github.com/David-glitc/leash && cd leash
pnpm install
forge install foundry-rs/forge-std --no-git
pnpm test
```

## 1. Write a leash

```sh
pnpm compile "agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 up to 3 QOR a day, at most 1 QOR per payment, only to 0x90F79bf6EB2c4f870365E785982E1f101E93b906 for 3 hours"
```

You get a validated mandate, an on-chain plan, and a list of findings: errors (refused), warnings (defaults applied) and gaps (what the chain does not enforce). Vague input is refused, never guessed.

To describe swaps, wraps and vault flows, see the [flow language](FLOW_LANGUAGE.md).

## 2. Run it on a local node

```sh
pnpm demo:local:v2    # deploys everything on Anvil, tours every adapter, runs the Q-Day drill
pnpm demo:monitor     # a burst and an unexplained outflow are caught; the watcher freezes with a stop-only key
```

## 3. Run it on the QoreChain testnet

```sh
pnpm accounts                 # writes .env with two throwaway testnet accounts (never commit it)
# fund the owner account from the faucet, then:
pnpm testnet register         # register both accounts' ML-DSA-87 keys
pnpm testnet:v2               # deploy, sign a mandate with a real ML-DSA-87 key, run the adapter tour and the drill
pnpm verify                   # read-only check of a deployment
```

The testnet scripts open hybrid-signed EVM windows (QoreChain admits EVM transactions only from a registered account with an open window). Opening a window advances the account's nonce; the scripts wait for it.

## 4. Give an agent a leash

See [Agents and MCP](../mcp/README.md): Hermes Agent, Claude Code and Cursor setup, the 15 tools, and a skill that teaches the agent the rules.

## 5. Watch a guard

```sh
LEASH_GUARD=0x… pnpm monitor --once                 # one pass
LEASH_GUARD=0x… LEASH_WATCHER_KEY=0x… pnpm monitor --auto-freeze   # freeze on a critical alert
```

The watcher key is a *classical* key that can only freeze, so it is safe to hold on a monitoring host.
