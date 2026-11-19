/**
 * accounts.ts - create two THROWAWAY testnet accounts (owner and agent) and write them to .env.
 * Prints addresses only. The .env is gitignored and mode 600. Testnet only: never reuse these on mainnet.
 *
 *   pnpm accounts
 */
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { generateMnemonic, deriveUnifiedAccount } from "@qorechain/sdk";

if (existsSync(".env")) { console.error(".env already exists. Delete it first if you really want new accounts."); process.exit(1); }
const owner = generateMnemonic(256);
const agent = generateMnemonic(256);
writeFileSync(".env", `# Throwaway QoreChain TESTNET accounts. Never commit. Never use on mainnet.\nQORE_NETWORK=testnet\nOWNER_MNEMONIC="${owner}"\nAGENT_MNEMONIC="${agent}"\n`, { mode: 0o600 });
chmodSync(".env", 0o600);
for (const [name, m] of [["owner", owner], ["agent", agent]] as const) {
  const a = await deriveUnifiedAccount(m, 0);
  console.log(`${name.padEnd(6)} cosmos ${a.cosmos}   evm ${a.evm}`);
}
console.log("\nFund both from https://dashboard.qorechain.io/faucet (the cosmos qor1... addresses).");
