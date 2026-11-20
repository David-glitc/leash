/**
 * Leash MCP server (stdio). Gives an AI agent harness (Hermes Agent, Claude Code, Cursor, any MCP client)
 * a leashed way to spend on QoreChain: every payment goes through LeashGuard, so the mandate's caps,
 * allowlist and expiry are enforced on chain, not by the agent's good behaviour.
 *
 * Keys: this server only ever loads the AGENT's key (LEASH_AGENT_KEY or LEASH_AGENT_MNEMONIC).
 * It has no tool that loosens a mandate. Starting or loosening needs the owner's ML-DSA-87 signature,
 * which an agent never holds. The agent can only spend inside the mandate and freeze.
 *
 *   LEASH_GUARD        guard contract address (required for on-chain tools)
 *   LEASH_AGENT_KEY    0x… agent private key, or LEASH_AGENT_MNEMONIC (needed for leash_pay and leash_freeze)
 *   LEASH_RPC          EVM RPC (default https://evm-testnet.qore.host)
 *   LEASH_CHAIN_ID     default 9800 (qorechain-diana)
 *   LEASH_TOKENS       JSON registry, e.g. {"FUSD":{"address":"0x…","decimals":18}} (QOR is built in)
 *   LEASH_ADAPTERS     JSON adapter addresses for a LeashGuardV2: {"univ2":"0x…","wrap":"0x…","erc4626":"0x…"}
 */
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, isAddress, parseAbi, parseUnits, parseEventLogs,
  BaseError, ContractFunctionRevertedError, type Address, type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { compile, DEFAULT_TOKENS, NATIVE, type TokenRegistry, type AdapterRegistry } from "../tools/policy.ts";
import { guardAbi, wireMandate } from "../tools/attack.ts";
import { guardV2Abi, wireMandateV2 } from "../tools/wire.ts";
import { swap, wrap, unwrap, vaultDeposit, vaultRedeem, floorOut, type Action } from "../tools/actions.ts";
import { snapshot as monSnapshot, eventsBetween, evaluate as monEvaluate, DEFAULT_CONFIG as MON_CFG } from "../tools/monitor.ts";

const RPC = process.env.LEASH_RPC?.trim() || "https://evm-testnet.qore.host";
const CHAIN_ID = Number(process.env.LEASH_CHAIN_ID || 9800);
const chain = defineChain({ id: CHAIN_ID, name: "QoreChain", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const tokens: TokenRegistry = { ...DEFAULT_TOKENS, ...(process.env.LEASH_TOKENS ? JSON.parse(process.env.LEASH_TOKENS) : {}) };

const adapters: AdapterRegistry = process.env.LEASH_ADAPTERS ? JSON.parse(process.env.LEASH_ADAPTERS) : {};

const guardAddr = (): Address => {
  const g = process.env.LEASH_GUARD?.trim();
  if (!g || !isAddress(g)) throw new Error("LEASH_GUARD is not set to a guard address");
  return g;
};
const agentAccount = () => {
  const k = process.env.LEASH_AGENT_KEY?.trim(), m = process.env.LEASH_AGENT_MNEMONIC?.trim();
  if (k) return privateKeyToAccount(k as Hex);
  if (m) return mnemonicToAccount(m);
  throw new Error("No agent key: set LEASH_AGENT_KEY or LEASH_AGENT_MNEMONIC (the agent's own key; never the owner's)");
};
const tokenBySymbol = (s: string) => {
  const t = tokens[s.toUpperCase()] ?? tokens[s];
  if (t) return { symbol: s.toUpperCase(), ...t };
  if (isAddress(s)) { const e = Object.entries(tokens).find(([, v]) => v.address.toLowerCase() === s.toLowerCase()); if (e) return { symbol: e[0], ...e[1] }; }
  throw new Error(`Unknown token '${s}'. Known: ${Object.keys(tokens).join(", ")}`);
};
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: j(v) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

/** Turn a viem revert into the guard's own error name (OverPerTxLimit, IsFrozen, ...). */
function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

const viewAbi = parseAbi([
  "function expiry() view returns (uint64)", "function tokens() view returns (address[])", "function recipients() view returns (address[])",
  "function limitOf(address) view returns (uint128 perTx, uint128 daily)",
]);

async function state() {
  const guard = guardAddr();
  const call = <T,>(abi: typeof guardV2Abi | typeof viewAbi, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: guard, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [owner, agent, frozen, nonce, expiry, toks, recips, balance, block] = await Promise.all([
    call<Address>(guardV2Abi, "owner"), call<Address>(guardV2Abi, "agent"), call<boolean>(guardV2Abi, "frozen"), call<bigint>(guardV2Abi, "nonce"),
    call<bigint>(viewAbi, "expiry"), call<Address[]>(viewAbi, "tokens"), call<Address[]>(viewAbi, "recipients"),
    pub.getBalance({ address: guard }), pub.getBlock(),
  ]);
  const limits = await Promise.all(toks.map(async (t) => {
    const [perTx, daily] = await call<readonly [bigint, bigint]>(viewAbi, "limitOf", [t]);
    const remaining = await call<bigint>(guardV2Abi, "remainingToday", [t]);
    const known = Object.entries(tokens).find(([, v]) => v.address.toLowerCase() === t.toLowerCase());
    const dec = known?.[1].decimals ?? 18;
    return { token: known?.[0] ?? t, address: t, perPayment: formatUnits(perTx, dec), daily: formatUnits(daily, dec), remainingToday: formatUnits(remaining, dec) };
  }));
  const now = Number(block.timestamp);
  const v2 = await isV2();
  return { guard, version: v2 ? 2 : 1, chainId: CHAIN_ID, owner, agent, frozen, nonce, expiry: Number(expiry), expiresInSeconds: Number(expiry) - now, expired: now >= Number(expiry), nativeBalance: formatUnits(balance, 18), limits, recipients: recips, ...(v2 ? { routes: await describeRoutes() } : {}) };
}

async function simulate(symbol: string, to: Address, amount: string) {
  const t = tokenBySymbol(symbol);
  const value = parseUnits(amount, t.decimals);
  const account = agentAccount();
  try {
    await pub.simulateContract({ address: guardAddr(), abi: guardV2Abi, functionName: "spend", args: [t.address, to, value], account });
    return { allowed: true as const, token: t, value, account };
  } catch (e) {
    return { allowed: false as const, reason: reason(e), token: t, value, account };
  }
}

const server = new McpServer({ name: "leash", version: "0.1.0" });

server.registerTool("leash_compile", {
  title: "Compile a leash from plain English",
  description: "Turn a sentence like 'agent 0x… may spend up to 50 FUSD a day, at most 20 FUSD per payment, only to 0x… for 3 days' into a validated mandate, an on-chain plan and a list of findings (errors, warnings, and gaps the chain does not enforce). Deterministic, no model. Read-only. The owner must still sign the mandate with their ML-DSA-87 key.",
  inputSchema: { sentence: z.string().min(10).describe("The leash in plain English"), guard: z.string().optional().describe("Guard address, to scope the EVM window plan") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ sentence, guard }) => {
  const r = compile(sentence, { tokens, guard: guard && isAddress(guard) ? guard : undefined, adapters });
  return ok({ ok: r.ok, mandate: r.mandate, plan: r.plan, findings: r.findings });
});

server.registerTool("leash_status", {
  title: "Read the guard's mandate and allowance",
  description: "Show whether the guard is frozen or expired, the agent and owner addresses, per-token caps, how much the agent may still spend today, the recipient allowlist and the guard's balance. Read-only. Call this before planning any spend.",
  inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async () => { try { return ok(await state()); } catch (e) { return fail(reason(e)); } });

server.registerTool("leash_check", {
  title: "Dry-run a payment",
  description: "Simulate a payment through the guard without sending it. Returns allowed true, or the guard's own refusal (IsFrozen, Expired, RecipientNotAllowed, TokenNotSpendable, OverPerTxLimit, OverDailyLimit). If it is refused, do not look for a workaround: ask the owner to sign a new mandate.",
  inputSchema: { token: z.string().describe("Token symbol (QOR for the native coin) or address"), to: z.string().describe("Recipient 0x address"), amount: z.string().describe("Decimal amount, e.g. '1.5'") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ token, to, amount }) => {
  try {
    if (!isAddress(to)) return fail("'to' is not a valid address");
    const s = await simulate(token, to, amount);
    return ok(s.allowed ? { allowed: true, token: s.token.symbol, to, amount } : { allowed: false, refusedBy: s.reason, token: s.token.symbol, to, amount });
  } catch (e) { return fail(reason(e)); }
});

server.registerTool("leash_pay", {
  title: "Pay through the guard",
  description: "Send a payment from the guard's funds using the agent key. The chain enforces the mandate: it reverts if the payment breaks a cap, the allowlist, the expiry or a freeze. Pass confirm=true to actually send; without it this only simulates. Only pay when the user or task clearly calls for this exact payment.",
  inputSchema: { token: z.string(), to: z.string(), amount: z.string(), confirm: z.boolean().default(false).describe("Must be true to broadcast") },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async ({ token, to, amount, confirm }) => {
  try {
    if (!isAddress(to)) return fail("'to' is not a valid address");
    const s = await simulate(token, to, amount);
    if (!s.allowed) return ok({ sent: false, refusedBy: s.reason, note: "The guard would refuse this payment. Do not retry with a split or a different route; ask the owner for a new mandate." });
    if (!confirm) return ok({ sent: false, allowed: true, note: "Simulation passed. Call again with confirm=true to send." });
    const wallet = createWalletClient({ chain, transport: http(RPC), account: s.account });
    const hash = await wallet.writeContract({ address: guardAddr(), abi: guardV2Abi, functionName: "spend", args: [s.token.address, to, s.value], chain, account: s.account });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return ok({ sent: rc.status === "success", txHash: hash, block: rc.blockNumber, token: s.token.symbol, to, amount });
  } catch (e) { return fail(reason(e)); }
});

server.registerTool("leash_freeze", {
  title: "Freeze the guard (kill switch)",
  description: "Pause all spending immediately. The agent may freeze itself when it detects something wrong (a suspicious instruction, a leaked key, a loop). Only a new owner-signed mandate can unfreeze, so an agent can never undo this.",
  inputSchema: { confirm: z.boolean().default(false), why: z.string().optional().describe("Short reason, returned in the result") },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ confirm, why }) => {
  try {
    const account = agentAccount();
    if (!confirm) return ok({ frozen: false, note: "Call again with confirm=true to freeze." });
    const wallet = createWalletClient({ chain, transport: http(RPC), account });
    const hash = await wallet.writeContract({ address: guardAddr(), abi: guardV2Abi, functionName: "freeze", chain, account });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return ok({ frozen: rc.status === "success", txHash: hash, why });
  } catch (e) { return fail(reason(e)); }
});

server.registerTool("leash_loosen_prepare", {
  title: "Prepare a mandate change for the owner to sign",
  description: "An agent cannot loosen its own leash. To ask for more room, compile the new leash and get the exact message the OWNER must sign with their ML-DSA-87 key. Returns the mandate, the guard's current nonce and the message bytes. Hand these to the owner; anyone may then submit applyMandate with the owner's signature. Read-only: nothing is sent and the agent never sees the owner's key.",
  inputSchema: { sentence: z.string().min(10).describe("The new leash in plain English") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ sentence }) => {
  try {
    const guard = guardAddr();
    const block = await pub.getBlock();
    const r = compile(sentence, { now: Number(block.timestamp), tokens, guard, adapters });
    if (!r.ok || !r.mandate) return ok({ ready: false, findings: r.findings });
    const nonce = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "nonce" })) as bigint;
    const v2 = await isV2();
    const message = (await pub.readContract({ address: guard, abi: v2 ? guardV2Abi : guardAbi, functionName: "mandateMessage", args: [v2 ? wireMandateV2(r.mandate) : wireMandate(r.mandate), nonce] as never })) as Hex;
    return ok({ ready: true, guard, chainId: CHAIN_ID, nonce, mandate: r.mandate, messageToSign: message, findings: r.findings, next: "Owner signs messageToSign with their registered ML-DSA-87 key, then anyone calls applyMandate(mandate, signature) on the guard. The signature is only valid for this guard, chain, nonce and mandate." });
  } catch (e) { return fail(reason(e)); }
});

// ---------------------------------------------------------------- v2: routes and guarded actions

let v2Cache: boolean | undefined;
async function isV2(): Promise<boolean> {
  if (v2Cache !== undefined) return v2Cache;
  try { await pub.readContract({ address: guardAddr(), abi: guardV2Abi, functionName: "routes" }); v2Cache = true; } catch { v2Cache = false; }
  return v2Cache;
}
type RouteRow = { adapter: Address; target: Address; tokenIn: Address; tokenOut: Address; minOutPerInE18: bigint };
async function readRoutes(): Promise<RouteRow[]> {
  if (!(await isV2())) throw new Error("This guard is a v1 LeashGuard: it supports payments only. Guarded actions need a LeashGuardV2.");
  return (await pub.readContract({ address: guardAddr(), abi: guardV2Abi, functionName: "routes" })) as unknown as RouteRow[];
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const symOf = (a: Address) => Object.entries(tokens).find(([, t]) => same(t.address, a))?.[0] ?? a;
const decOf = (a: Address) => Object.values(tokens).find((t) => same(t.address, a))?.decimals ?? 18;
const kindOf = (r: RouteRow) => {
  if (same(r.adapter, adapters.univ2 ?? "")) return "swap";
  if (same(r.adapter, adapters.wrap ?? "")) return r.tokenIn === NATIVE ? "wrap" : "unwrap";
  if (same(r.adapter, adapters.erc4626 ?? "")) return same(r.tokenOut, r.target) ? "deposit" : "redeem";
  return "custom";
};
async function describeRoutes() {
  return (await readRoutes()).map((r) => ({
    kind: kindOf(r), adapter: r.adapter, target: r.target, from: symOf(r.tokenIn), to: symOf(r.tokenOut),
    minOutPerIn: formatUnits(r.minOutPerInE18 * 10n ** BigInt(decOf(r.tokenIn)), 18 + decOf(r.tokenOut)),
  }));
}
const addr = z.string().describe("0x address");

async function runAction(a: Action, confirm: boolean, extra: Record<string, unknown> = {}) {
  const account = agentAccount();
  const args = [a.adapter, a.target, a.data, a.value] as const;
  let expected: bigint;
  try {
    const sim = await pub.simulateContract({ address: guardAddr(), abi: guardV2Abi, functionName: "execute", args, account });
    expected = sim.result as bigint;
  } catch (e) {
    return ok({ sent: false, refusedBy: reason(e), note: "The guard would refuse this action. Do not look for a way around it; ask the owner for a new mandate.", ...extra });
  }
  const out = { kind: a.kind, spend: `${formatUnits(a.amountIn, decOf(a.tokenIn))} ${symOf(a.tokenIn)}`, expectedReceive: `${formatUnits(expected, decOf(a.tokenOut))} ${symOf(a.tokenOut)}`, ...extra };
  if (!confirm) return ok({ sent: false, allowed: true, ...out, note: "Simulation passed. Call again with confirm=true to send." });
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  const hash = await wallet.writeContract({ address: guardAddr(), abi: guardV2Abi, functionName: "execute", args, chain, account });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  const ev = parseEventLogs({ abi: guardV2Abi, logs: rc.logs, eventName: "Executed" })[0];
  return ok({ sent: rc.status === "success", txHash: hash, block: rc.blockNumber, ...out, received: ev ? `${formatUnits((ev.args as { received: bigint }).received, decOf(a.tokenOut))} ${symOf(a.tokenOut)}` : undefined });
}
const pickRoute = (rs: RouteRow[], what: string) => {
  if (rs.length === 0) throw new Error(`No route for ${what}. Ask the owner to add it to the mandate (leash_loosen_prepare).`);
  if (rs.length > 1) throw new Error(`More than one route for ${what}: ${rs.map((r) => r.target).join(", ")}. Say which target.`);
  return rs[0]!;
};
const annAct = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

server.registerTool("leash_routes", {
  title: "List the actions the mandate allows",
  description: "Show the guard's routes: each allowed swap, wrap, unwrap or vault flow with its target contract and the owner's minimum output per input (the rate floor). Read-only. Only a LeashGuardV2 has routes.",
  inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async () => { try { return ok(await describeRoutes()); } catch (e) { return fail(reason(e)); } });

server.registerTool("leash_swap", {
  title: "Swap through an allowed router",
  description: "Swap one token for another through a router the owner's mandate allows. The output is sent to the guard, and the guard enforces the owner's rate floor on what it actually receives. Use QOR for the native coin. Pass confirm=true to send; without it this only simulates and shows the expected output.",
  inputSchema: { tokenIn: z.string(), tokenOut: z.string(), amount: z.string().describe("Decimal amount of tokenIn"), router: addr.optional().describe("Only needed if the mandate has several routers for this pair"), confirm: z.boolean().default(false) },
  annotations: annAct,
}, async ({ tokenIn, tokenOut, amount, router, confirm }) => {
  try {
    const tin = tokenBySymbol(tokenIn), tout = tokenBySymbol(tokenOut);
    const rs = (await readRoutes()).filter((r) => same(r.adapter, adapters.univ2 ?? "") && same(r.tokenIn, tin.address) && same(r.tokenOut, tout.address) && (!router || same(r.target, router)));
    const r = pickRoute(rs, `${tin.symbol} to ${tout.symbol}`);
    let wrapped: Address | undefined;
    if (tin.address === NATIVE || tout.address === NATIVE) {
      for (const fn of ["WETH", "weth"]) {
        try { wrapped = (await pub.readContract({ address: r.target, abi: parseAbi([`function ${fn}() view returns (address)`]), functionName: fn })) as Address; break; } catch { /* try next */ }
      }
      if (!wrapped) return fail("Could not read the router's wrapped-native address (WETH()).");
    }
    const amountIn = parseUnits(amount, tin.decimals);
    return await runAction(swap({ guard: guardAddr(), adapters, target: r.target, tokenIn: tin.address, tokenOut: tout.address, wrapped, amountIn, minOut: floorOut(amountIn, r.minOutPerInE18) }), confirm, { router: r.target });
  } catch (e) { return fail(reason(e)); }
});

for (const [name, kind] of [["leash_wrap", "wrap"], ["leash_unwrap", "unwrap"]] as const) {
  server.registerTool(name, {
    title: kind === "wrap" ? "Wrap the native coin" : "Unwrap to the native coin",
    description: `${kind === "wrap" ? "Wrap native QOR into its wrapped token" : "Unwrap the wrapped token back to native QOR"} through a route the mandate allows. Always one for one. Pass confirm=true to send.`,
    inputSchema: { amount: z.string().describe("Decimal amount"), target: addr.optional().describe("The wrapped-token contract, if the mandate has more than one"), confirm: z.boolean().default(false) },
    annotations: annAct,
  }, async ({ amount, target, confirm }) => {
    try {
      const rs = (await readRoutes()).filter((r) => same(r.adapter, adapters.wrap ?? "") && (kind === "wrap" ? r.tokenIn === NATIVE : r.tokenOut === NATIVE) && (!target || same(r.target, target)));
      const r = pickRoute(rs, kind);
      const a = { guard: guardAddr(), adapters, target: r.target, amountIn: parseUnits(amount, 18) };
      return await runAction(kind === "wrap" ? wrap(a) : unwrap(a), confirm);
    } catch (e) { return fail(reason(e)); }
  });
}

for (const [name, kind] of [["leash_vault_deposit", "deposit"], ["leash_vault_redeem", "redeem"]] as const) {
  server.registerTool(name, {
    title: kind === "deposit" ? "Deposit into an ERC-4626 vault" : "Redeem vault shares",
    description: `${kind === "deposit" ? "Deposit the vault's asset and receive shares" : "Redeem shares for the vault's asset"} through a route the mandate allows. Shares always go to the guard. Pass confirm=true to send.`,
    inputSchema: { vault: addr, amount: z.string().describe(kind === "deposit" ? "Decimal amount of the asset" : "Decimal amount of shares"), confirm: z.boolean().default(false) },
    annotations: annAct,
  }, async ({ vault, amount, confirm }) => {
    try {
      const rs = (await readRoutes()).filter((r) => same(r.adapter, adapters.erc4626 ?? "") && same(r.target, vault) && (kind === "deposit" ? same(r.tokenOut, vault) : same(r.tokenIn, vault)));
      const r = pickRoute(rs, `${kind} on ${vault}`);
      const asset = kind === "deposit" ? r.tokenIn : r.tokenOut;
      const a = { guard: guardAddr(), adapters, target: r.target, asset, amountIn: parseUnits(amount, kind === "deposit" ? decOf(asset) : decOf(r.target)) };
      return await runAction(kind === "deposit" ? vaultDeposit(a) : vaultRedeem(a), confirm);
    } catch (e) { return fail(reason(e)); }
  });
}

server.registerTool("leash_execute", {
  title: "Run an action with raw call data (advanced)",
  description: "Call guard.execute with an adapter, a target and call data you built yourself. The guard still checks the route, the caps, that the output returns to the guard, and the owner's rate floor, so a wrong call is refused. Prefer leash_swap, leash_wrap, leash_vault_deposit and friends.",
  inputSchema: { adapter: addr, target: addr, data: z.string().describe("0x call data"), value: z.string().default("0").describe("Native amount to send, in wei"), confirm: z.boolean().default(false) },
  annotations: annAct,
}, async ({ adapter, target, data, value, confirm }) => {
  try {
    if (!isAddress(adapter) || !isAddress(target)) return fail("adapter and target must be addresses");
    const a: Action = { kind: "swap", adapter, target, data: data as Hex, value: BigInt(value), tokenIn: NATIVE, tokenOut: NATIVE, amountIn: BigInt(value) };
    return await runAction(a, confirm);
  } catch (e) { return fail(reason(e)); }
});

server.registerTool("leash_monitor", {
  title: "Check the guard for trouble",
  description: "Run the monitor's rules once: frozen or expired mandate, expiry soon, how much of each daily cap is used, a burst of actions, one large action, from recent guard events. Read-only. For continuous watching with an optional stop-only auto-freeze, run tools/monitor.ts.",
  inputSchema: { lookbackBlocks: z.number().int().min(1).max(5000).default(500) },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ lookbackBlocks }) => {
  try {
    const snap = await monSnapshot(pub, guardAddr());
    const from = snap.block > BigInt(lookbackBlocks) ? snap.block - BigInt(lookbackBlocks) : 0n;
    const events = await eventsBetween(pub, guardAddr(), from, snap.block);
    const alerts = monEvaluate(undefined, snap, events, MON_CFG, symOf);
    return ok({ block: snap.block, frozen: snap.frozen, alerts, recentActions: events.filter((e) => e.kind === "spent" || e.kind === "executed").length, lookbackBlocks });
  } catch (e) { return fail(reason(e)); }
});

server.registerTool("leash_drill_local", {
  title: "Run the Q-Day drill on a local node",
  description: "Start a local Anvil node with stubbed QoreChain precompiles, deploy the guard, and play a leaked agent key and a leaked owner key against it. Returns the PASS/FAIL table. Needs Foundry (anvil, forge build) in the repo. Takes about 30 to 60 seconds. It never touches a real network.",
  inputSchema: { suite: z.enum(["payments", "actions"]).default("actions").describe("payments: the v1 drill; actions: the v2 drill for swaps, wraps and vaults") }, annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ suite }) => {
  const root = new URL("..", import.meta.url).pathname;
  const out = await new Promise<string>((res) => {
    const p = spawn("npx", ["tsx", suite === "payments" ? "tools/local.ts" : "tools/local-v2.ts"], { cwd: root, env: { ...process.env, LEASH_AGENT_KEY: "", LEASH_AGENT_MNEMONIC: "" } });
    let buf = ""; const kill = setTimeout(() => p.kill(), 180_000);
    p.stdout.on("data", (d) => (buf += d)); p.stderr.on("data", (d) => (buf += d));
    p.on("close", () => { clearTimeout(kill); res(buf); });
  });
  const lines = out.split("\n").filter((l) => /^(PASS|FAIL)|as expected/.test(l));
  return lines.length ? ok({ table: lines }) : fail(out.slice(-1500));
});

await server.connect(new StdioServerTransport());
