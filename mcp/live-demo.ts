/**
 * Live demo through the MCP server on the testnet: an agent harness checks, pays, and gets refused by the chain.
 * Needs .env from `pnpm accounts` (uses the AGENT's mnemonic only) and a guard armed by `pnpm testnet rearm`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const l of readFileSync(".env", "utf8").split("\n")) { const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim()); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!; }
const st = JSON.parse(readFileSync("reports/testnet-state.json", "utf8"));
const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, LEASH_GUARD: st.guard, LEASH_AGENT_MNEMONIC: process.env.AGENT_MNEMONIC! };
const client = new Client({ name: "leash-live-demo", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.ts"], env }));
const log: unknown[] = [];
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text as string;
  console.log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? "  [error]" : ""}\n${t}`);
  let out: unknown = t; try { out = JSON.parse(t); } catch { /* text */ }
  log.push({ tool: name, args, isError: !!r.isError, result: out });
  return out;
};
const s0 = await call("leash_status", {});
const to = s0.recipients[0];
await call("leash_check", { token: "QOR", to, amount: "0.1" });
await call("leash_pay", { token: "QOR", to, amount: "0.1", confirm: true });
await call("leash_check", { token: "QOR", to, amount: "5" }); // over the 1 QOR per-payment cap: the chain refuses
await call("leash_check", { token: "QOR", to: "0x000000000000000000000000000000000000dEaD", amount: "0.1" }); // not on the allowlist
await call("leash_status", {});
await client.close();
mkdirSync("reports", { recursive: true });
writeFileSync("reports/mcp-live-demo.json", JSON.stringify({ network: "qorechain-diana", guard: st.guard, calls: log }, null, 2));
