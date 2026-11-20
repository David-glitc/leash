/**
 * leash.ts - command line.
 *
 *   pnpm compile "agent 0x… may spend up to 50 fUSD a day, at most 20 fUSD per payment, only to 0x… for 3 days"
 *       [--tokens tokens.json] [--adapters adapters.json] [--guard 0x…] [--json]
 *
 * Prints the mandate, the on-chain plan, and every finding: errors (refused), warnings (defaults
 * applied) and gaps (what the chain does not enforce for this setup).
 */
import { readFileSync } from "node:fs";
import { compile, describe, DEFAULT_TOKENS, type TokenRegistry } from "./policy.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const text = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--json")).join(" ").trim();
if (!text || args[0] === "compile" && !args[1]) { console.error('Usage: pnpm compile "agent 0x… may spend up to 50 fUSD a day … only to 0x… for 3 days" [--tokens tokens.json] [--adapters adapters.json] [--guard 0x…] [--json]'); process.exit(1); }
const tf = flag("tokens");
const tokens: TokenRegistry = { ...DEFAULT_TOKENS, ...(tf ? JSON.parse(readFileSync(tf, "utf8")) : {}) };
const af = flag("adapters");
const adapters = af ? JSON.parse(readFileSync(af, "utf8")) : undefined;
const r = compile(text.replace(/^compile\s+/, ""), { tokens, adapters, guard: flag("guard") as `0x${string}` | undefined });

if (args.includes("--json")) {
  console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} else {
  console.log(r.ok ? `LEASH OK: ${describe(r.mandate!, tokens)}\n` : "LEASH REFUSED\n");
  for (const f of r.findings) console.log(`  [${f.severity}] ${f.message}`);
  if (r.plan) { console.log("\nPlan:"); for (const s of r.plan.steps) console.log(`  ${s}`); }
}
process.exit(r.ok ? 0 : 1);
