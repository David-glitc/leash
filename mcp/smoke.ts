/** Read-only smoke test against the live testnet guard: lists tools, compiles, reads status, dry-runs a payment. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GUARD = process.env.LEASH_GUARD ?? "0xa0ebb5daf8229da498346f0c824276d126c2a34c";
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.ts"], env: { ...process.env as Record<string, string>, LEASH_GUARD: GUARD, LEASH_AGENT_KEY: process.env.LEASH_AGENT_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" } });
const client = new Client({ name: "leash-smoke", version: "0.0.1" });
await client.connect(transport);
const text = (r: any) => r.content?.[0]?.text as string;
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
const c = JSON.parse(text(await client.callTool({ name: "leash_compile", arguments: { sentence: "agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 up to 3 QOR a day, at most 1 QOR per payment, only to 0x90F79bf6EB2c4f870365E785982E1f101E93b906 for 3 hours" } })));
console.log("compile ok:", c.ok, "findings:", c.findings.length);
const st = JSON.parse(text(await client.callTool({ name: "leash_status", arguments: {} })));
console.log("status:", { guard: st.guard, frozen: st.frozen, nonce: st.nonce, owner: st.owner, limits: st.limits });
const chk = JSON.parse(text(await client.callTool({ name: "leash_check", arguments: { token: "QOR", to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", amount: "0.5" } })));
console.log("check:", chk);
const lp = JSON.parse(text(await client.callTool({ name: "leash_loosen_prepare", arguments: { sentence: "agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 up to 10 QOR a day, at most 2 QOR per payment, only to 0x90F79bf6EB2c4f870365E785982E1f101E93b906 for 6 hours" } })));
console.log("loosen_prepare:", { ready: lp.ready, nonce: lp.nonce, messageBytes: (lp.messageToSign.length - 2) / 2 });
await client.close();
