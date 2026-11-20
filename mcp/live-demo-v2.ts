/**
 * Live demo on the testnet: an MCP client drives guarded actions on the LeashGuardV2 that `pnpm testnet:v2` deployed
 * (re-armed with `pnpm testnet v2rearm`). Uses the AGENT's mnemonic from .env only.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const l of readFileSync(".env", "utf8").split("\n")) { const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim()); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!; }
const st = JSON.parse(readFileSync("reports/testnet-v2-state.json", "utf8"));
const tokens = Object.fromEntries(Object.entries(st.tokens as Record<string, string>).map(([k, v]) => [k, { address: v, decimals: 18 }]));
const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, LEASH_GUARD: st.guard, LEASH_AGENT_MNEMONIC: process.env.AGENT_MNEMONIC!, LEASH_TOKENS: JSON.stringify(tokens), LEASH_ADAPTERS: JSON.stringify(st.adapters) };
const client = new Client({ name: "leash-live-demo-v2", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.ts"], env }));
const log: unknown[] = [];
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text as string;
  let out: unknown = t; try { out = JSON.parse(t); } catch { /* text */ }
  console.log(`> ${name} ${JSON.stringify(args)}${r.isError ? "  [error]" : ""}`);
  console.log(typeof out === "string" ? out : JSON.stringify(out).slice(0, 220));
  log.push({ tool: name, args, isError: !!r.isError, result: out });
  return out;
};
const s = await call("leash_status");
await call("leash_routes");
await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "10" }); // two routers are allowed for this pair: the tool asks which
await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "10", router: st.router });
await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "10", router: st.router, confirm: true });
await call("leash_wrap", { amount: "0.5", confirm: true });
await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "90", router: st.router }); // over the 40 USD per-action cap: the chain refuses
await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "10", router: st.unlistedRouter }); // a router the owner did not allow
await call("leash_monitor");
await client.close();
mkdirSync("reports", { recursive: true });
writeFileSync("reports/mcp-live-demo-v2.json", JSON.stringify({ network: "qorechain-diana", guard: st.guard, nonce: s.nonce, calls: log }, null, 2));
