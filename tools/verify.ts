/**
 * verify.ts - read-only check of the live testnet deployment. No keys, nothing is sent.
 *
 *   pnpm verify
 *
 * It reads qorechain-diana through the public EVM RPC and checks the guards, the deployed bytecode against this source,
 * the real transactions the reports claim (a real ML-DSA-87 mandate, five adapter actions, an MCP swap and wrap),
 * and that the drill reports are internally consistent.
 */
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, defineChain, http, toEventSelector, parseAbi, type Address, type Hex } from "viem";

const RPC = process.env.LEASH_RPC?.trim() || "https://evm-testnet.qore.host";
const chain = defineChain({ id: 9800, name: "QoreChain testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const rd = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const has = (p: string) => existsSync(new URL(`../${p}`, import.meta.url));

const OWNER: Address = "0x9fA42BbB41d8a7c13123e3BE086b79bc924B2750";
const GUARD_V1: Address = "0xa0ebb5daf8229da498346f0c824276d126c2a34c";
const GUARD_V2: Address = "0x6781ab2c589469ab91790d1a40a7de1f6d5135eb";
const EXECUTED = toEventSelector("Executed(address,address,address,uint256,address,uint256)");

let failed = 0, passed = 0, skipped = 0;
const out = (kind: "PASS" | "FAIL" | "SKIP", what: string, detail = "") => {
  console.log(`${kind}  ${what}${detail ? "  " + detail : ""}`);
  if (kind === "PASS") passed++; else if (kind === "FAIL") failed++; else skipped++;
};
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); } }
}
const check = async (what: string, fn: () => Promise<string | true>) => {
  try { const r = await fn(); if (r === "skipped") return; out("PASS", what, r === true ? "" : r); } catch (e) { out("FAIL", what, e instanceof Error ? e.message : String(e)); }
};
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;

const guardAbi = parseAbi(["function owner() view returns (address)", "function nonce() view returns (uint256)", "function frozen() view returns (bool)", "function routes() view returns ((address adapter, address target, address tokenIn, address tokenOut, uint256 minOutPerInE18)[])"]);

async function receiptOk(hash: Hex, to?: Address) {
  const r = await retry(() => pub.getTransactionReceipt({ hash }));
  if (r.status !== "success") throw new Error(`transaction ${short(hash)} reverted`);
  if (to && r.to?.toLowerCase() !== to.toLowerCase()) throw new Error(`transaction ${short(hash)} went to ${r.to}, expected ${to}`);
  return r;
}

/** Deployed runtime code with the immutable `owner` zeroed, compared with the local build's runtime code (also zeroed). */
async function sameCode(address: Address, artifact: string) {
  if (!has(artifact)) throw new Error(`no local build at ${artifact}: run 'forge build' first`);
  const art = rd(artifact);
  const local = (art.deployedBytecode.object as string).toLowerCase().replace(/^0x/, "");
  const refs: { start: number; length: number }[] = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat() as never;
  const mask = (hex: string) => { const b = hex.split(""); for (const r of refs) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = "0"; return b.join(""); };
  const onchain = ((await retry(() => pub.getCode({ address }))) ?? "0x").toLowerCase().replace(/^0x/, "");
  if (!onchain) throw new Error("no code at that address");
  if (mask(onchain) !== mask(local)) throw new Error("deployed code differs from this source's build");
  return `${onchain.length / 2} bytes, identical to this source (immutables masked)`;
}

console.log(`Leash verify  ·  ${RPC}\n`);
await check("connected to qorechain-diana (EVM chain id 9800)", async () => { const id = await retry(() => pub.getChainId()); if (id !== 9800) throw new Error(`chain id ${id}`); return true; });

// v1
await check("v1 guard: owner is the registered owner account", async () => { const o = (await retry(() => pub.readContract({ address: GUARD_V1, abi: guardAbi, functionName: "owner" }))) as Address; if (o.toLowerCase() !== OWNER.toLowerCase()) throw new Error(`owner is ${o}`); return o; });
await check("v1 guard: deployed code equals this source", () => sameCode(GUARD_V1, "out/LeashGuard.sol/LeashGuard.json").catch((e) => { if (/forge build/.test(String(e.message))) { out("SKIP", "v1 bytecode check", e.message); return "skipped"; } throw e; }));
const v1 = rd("reports/testnet-drill.json");
await check("v1: applyMandate succeeded, so pqcVerify accepted a real ML-DSA-87 signature", async () => { const r = await receiptOk(v1.applyTx, GUARD_V1); return `${short(v1.applyTx)} gas ${r.gasUsed}`; });

// v2
await check("v2 guard: owner is the registered owner account", async () => { const o = (await retry(() => pub.readContract({ address: GUARD_V2, abi: guardAbi, functionName: "owner" }))) as Address; if (o.toLowerCase() !== OWNER.toLowerCase()) throw new Error(`owner is ${o}`); return o; });
await check("v2 guard: at least two owner-signed mandates applied (nonce)", async () => { const n = (await retry(() => pub.readContract({ address: GUARD_V2, abi: guardAbi, functionName: "nonce" }))) as bigint; if (n < 2n) throw new Error(`nonce is ${n}`); return `nonce ${n}`; });
await check("v2 guard: six routes in the mandate (2 swaps, wrap, unwrap, deposit, redeem)", async () => { const r = (await retry(() => pub.readContract({ address: GUARD_V2, abi: guardAbi, functionName: "routes" }))) as unknown[]; if (r.length !== 6) throw new Error(`${r.length} routes`); return true; });
await check("v2 guard: deployed code equals this source", () => sameCode(GUARD_V2, "out/LeashGuardV2.sol/LeashGuardV2.json").catch((e) => { if (/forge build/.test(String(e.message))) { out("SKIP", "v2 bytecode check", e.message); return "skipped"; } throw e; }));
const v2 = rd("reports/testnet-v2-drill.json");
await check("v2: applyMandate with routes succeeded (a real ML-DSA-87 signature)", async () => { const r = await receiptOk(v2.applyTx, GUARD_V2); return `${short(v2.applyTx)} gas ${r.gasUsed}`; });
for (const t of v2.tour as { kind: string; tx: Hex }[]) {
  await check(`v2: ${t.kind} through the guard succeeded and emitted Executed`, async () => {
    const r = await receiptOk(t.tx, GUARD_V2);
    if (!r.logs.some((l) => l.address.toLowerCase() === GUARD_V2.toLowerCase() && l.topics[0] === EXECUTED)) throw new Error("no Executed event from the guard");
    return short(t.tx);
  });
}

// MCP transactions
const mcp = rd("reports/mcp-live-demo-v2.json");
for (const c of mcp.calls as { tool: string; result: { sent?: boolean; txHash?: Hex } }[]) {
  if (c.result && typeof c.result === "object" && c.result.sent && c.result.txHash) {
    const h = c.result.txHash;
    await check(`MCP: ${c.tool} made by an MCP client succeeded`, async () => { await receiptOk(h, GUARD_V2); return short(h); });
  }
}

// Reports are internally consistent
const count = (file: string, expected: number) => check(`${file}: ${expected} of ${expected} rows as expected`, async () => {
  const rows = rd(file).results as { pass: boolean }[];
  const p = rows.filter((r) => r.pass).length;
  if (rows.length !== expected || p !== expected) throw new Error(`${p} of ${rows.length}`);
  return true;
});
await count("reports/testnet-drill.json", 13);
await count("reports/testnet-v2-drill.json", 15);
await count("reports/local-drill.json", 14);
await count("reports/local-v2-drill.json", 16);

if (has("reports/attack-campaign.json")) {
  await check("attack campaign report: zero violations across all attacks", async () => {
    const c = rd("reports/attack-campaign.json");
    if (c.violations !== 0) throw new Error(`${c.violations} violations`);
    if (c.attempts < 500) throw new Error(`only ${c.attempts} attacks`);
    return `${c.attempts} attacks, ${c.accepted} accepted (all inside the mandate)`;
  });
}
if (has("reports/mutation.json")) {
  await check("mutation report present and consistent", async () => {
    const m = rd("reports/mutation.json").summary;
    if (m.killed + m.survived !== m.valid) throw new Error("report is inconsistent");
    return `${m.killed} of ${m.valid} mutants killed (${m.kill_rate}%)`;
  });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}.`);
process.exit(failed ? 1 : 0);
