/**
 * monitor.ts - watch a LeashGuard (v1 or v2) and raise alerts.
 *
 *   tsx tools/monitor.ts --guard 0x… [--interval 15] [--once] [--webhook https://…] [--auto-freeze]
 *
 * The rules are a pure function (`evaluate`), tested without a chain. The watcher polls the guard's state and
 * logs, compares each snapshot with the last, and prints one JSON line per alert. With --auto-freeze it calls
 * freeze() when a critical alert fires. The freezer holds only a CLASSICAL key (LEASH_WATCHER_KEY: the owner's or the
 * agent's). That is the Leash rule at work: a classical key can only stop things, so giving a monitor that key is
 * safe even if the monitor is compromised. It can freeze; it can never loosen anything.
 *
 * Environment: LEASH_RPC, LEASH_CHAIN_ID, LEASH_TOKENS (JSON, as for the MCP server), LEASH_WATCHER_KEY (for --auto-freeze),
 * LEASH_WEBHOOK (an alternative to --webhook; nothing is sent anywhere unless you set it).
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_TOKENS, NATIVE, type TokenRegistry } from "./policy.ts";
import { guardV2Abi } from "./wire.ts";

export type Severity = "info" | "warn" | "crit";
export interface Alert { severity: Severity; code: string; message: string; freeze?: boolean }

export interface Snapshot {
  block: bigint;
  timestamp: number;
  frozen: boolean;
  nonce: bigint;
  expiry: number;
  agent: Address;
  tokens: Address[];
  balances: Record<string, bigint>; // by lowercase token address
  daily: Record<string, bigint>;
  remaining: Record<string, bigint>;
}

export type GuardEvent =
  | { kind: "spent"; token: Address; amount: bigint; block: bigint; ts: number }
  | { kind: "executed"; tokenIn: Address; amountIn: bigint; tokenOut: Address; received: bigint; block: bigint; ts: number }
  | { kind: "deposited"; amount: bigint; block: bigint; ts: number }
  | { kind: "frozen"; by: Address; block: bigint; ts: number }
  | { kind: "mandate"; nonce: bigint; block: bigint; ts: number };

export interface Config {
  expirySoonSeconds: number;
  burnWarnFraction: number; // warn when this share of a daily cap is used
  largeFraction: number; // warn when one action is at least this share of a daily cap
  burstCount: number; // this many guard actions ...
  burstWindowSeconds: number; // ... inside this window is a burst
  freezeOnBurst: boolean;
  toleranceWei: bigint; // balance differences up to this are not alarming (rounding, dust)
}
export const DEFAULT_CONFIG: Config = { expirySoonSeconds: 3600, burnWarnFraction: 0.8, largeFraction: 0.5, burstCount: 5, burstWindowSeconds: 60, freezeOnBurst: true, toleranceWei: 0n };

const lc = (a: string) => a.toLowerCase();

/** The rules. Pure: compares the current snapshot with the previous one and the events between them. */
export function evaluate(prev: Snapshot | undefined, cur: Snapshot, events: GuardEvent[], cfg: Config = DEFAULT_CONFIG, names: (a: Address) => string = (a) => a): Alert[] {
  const out: Alert[] = [];
  const push = (severity: Severity, code: string, message: string, freeze = false) => out.push({ severity, code, message, ...(freeze ? { freeze: true } : {}) });

  if (cur.frozen) push("crit", "frozen", "The guard is frozen: the agent cannot spend. Only a new owner-signed mandate can unfreeze it.");
  if (cur.timestamp >= cur.expiry) push("warn", "expired", "The mandate has expired: the agent cannot spend until the owner signs a new one.");
  else if (cur.expiry - cur.timestamp <= cfg.expirySoonSeconds) push("warn", "expiring-soon", `The mandate expires in ${Math.round((cur.expiry - cur.timestamp) / 60)} minutes.`);

  if (prev) {
    if (cur.nonce > prev.nonce) push("warn", "mandate-changed", `A new owner-signed mandate was applied (nonce ${prev.nonce} to ${cur.nonce}). Check that the owner meant it.`);
    if (lc(cur.agent) !== lc(prev.agent)) push("warn", "agent-changed", `The agent address changed from ${prev.agent} to ${cur.agent}.`);

    // Unexplained outflow: balances must move only by what the guard's own events account for.
    const delta: Record<string, bigint> = {};
    const add = (t: string, v: bigint) => { delta[lc(t)] = (delta[lc(t)] ?? 0n) + v; };
    for (const e of events) {
      if (e.kind === "spent") add(e.token, -e.amount);
      else if (e.kind === "executed") { add(e.tokenIn, -e.amountIn); add(e.tokenOut, e.received); }
      else if (e.kind === "deposited") add(NATIVE, e.amount);
    }
    for (const t of cur.tokens) {
      const key = lc(t);
      const before = prev.balances[key], now = cur.balances[key];
      if (before === undefined || now === undefined) continue;
      const unexplained = now - before - (delta[key] ?? 0n);
      if (unexplained < -cfg.toleranceWei) {
        push("crit", "unexplained-outflow", `${names(t)} balance fell by ${-unexplained} (raw units) more than the guard's own events explain. Something moved funds without going through spend or execute.`, true);
      }
    }
  }

  // Daily burn per token.
  for (const t of cur.tokens) {
    const key = lc(t);
    const cap = cur.daily[key], left = cur.remaining[key];
    if (!cap || left === undefined) continue;
    const used = cap - left;
    if (used * 100n >= cap * BigInt(Math.round(cfg.burnWarnFraction * 100))) {
      push(used >= cap ? "info" : "warn", "daily-burn", `${names(t)}: ${((Number(used) / Number(cap)) * 100).toFixed(0)}% of today's cap used.`);
    }
  }

  // Large single actions, and bursts.
  const caps = cur.daily;
  for (const e of events) {
    const [tok, amt] = e.kind === "spent" ? [e.token, e.amount] : e.kind === "executed" ? [e.tokenIn, e.amountIn] : [undefined, 0n];
    if (tok && caps[lc(tok)] && Number(amt) >= cfg.largeFraction * Number(caps[lc(tok)])) push("warn", "large-action", `A single ${e.kind === "spent" ? "payment" : "action"} of ${names(tok)} used ${((Number(amt) / Number(caps[lc(tok)])) * 100).toFixed(0)}% of the daily cap.`);
  }
  const acts = events.filter((e) => e.kind === "spent" || e.kind === "executed");
  if (acts.length >= cfg.burstCount) {
    const ts = acts.map((e) => e.ts).sort((a, b) => a - b);
    for (let i = 0; i + cfg.burstCount - 1 < ts.length; i++) {
      if (ts[i + cfg.burstCount - 1]! - ts[i]! <= cfg.burstWindowSeconds) {
        push("crit", "burst", `${cfg.burstCount} or more guard actions within ${cfg.burstWindowSeconds} seconds. An agent in a loop, or a leaked key being used fast.`, cfg.freezeOnBurst);
        break;
      }
    }
  }
  if (events.some((e) => e.kind === "frozen")) push("info", "freeze-event", "A freeze was recorded in this window.");
  return out;
}

// ------------------------------------------------------------------ chain access

const viewAbi = parseAbi(["function expiry() view returns (uint64)", "function tokens() view returns (address[])"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export async function snapshot(pub: PublicClient, guard: Address): Promise<Snapshot> {
  const r = <T,>(abi: typeof guardV2Abi | typeof viewAbi, fn: string, args: unknown[] = []) =>
    pub.readContract({ address: guard, abi: abi as never, functionName: fn as never, args: args as never }) as Promise<T>;
  const [frozen, nonce, expiry, agent, listedTokens, block] = await Promise.all([
    r<boolean>(guardV2Abi, "frozen"), r<bigint>(guardV2Abi, "nonce"), r<bigint>(viewAbi, "expiry"), r<Address>(guardV2Abi, "agent"), r<Address[]>(viewAbi, "tokens"), pub.getBlock(),
  ]);
  // Always watch the native balance, even when the mandate does not list it: nothing should drain it.
  const tokens = [NATIVE, ...listedTokens.filter((t) => t !== NATIVE)] as Address[];
  const balances: Record<string, bigint> = {}, daily: Record<string, bigint> = {}, remaining: Record<string, bigint> = {};
  await Promise.all(tokens.map(async (t) => {
    const k = lc(t);
    balances[k] = t === NATIVE ? await pub.getBalance({ address: guard, blockNumber: block.number }) : ((await pub.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [guard], blockNumber: block.number })) as bigint);
    const [, d] = (await r<readonly [bigint, bigint]>(guardV2Abi, "limitOf", [t]));
    daily[k] = d;
    remaining[k] = await r<bigint>(guardV2Abi, "remainingToday", [t]);
  }));
  return { block: block.number, timestamp: Number(block.timestamp), frozen, nonce, expiry: Number(expiry), agent, tokens, balances, daily, remaining };
}

export async function eventsBetween(pub: PublicClient, guard: Address, from: bigint, to: bigint): Promise<GuardEvent[]> {
  const out: GuardEvent[] = [];
  const stamps = new Map<bigint, number>();
  const ts = async (b: bigint) => { if (!stamps.has(b)) stamps.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp)); return stamps.get(b)!; };
  for (let a = from; a <= to; a += 2000n) {
    const b = a + 1999n > to ? to : a + 1999n;
    const logs = parseEventLogs({ abi: guardV2Abi, logs: await pub.getLogs({ address: guard, fromBlock: a, toBlock: b }) });
    for (const l of logs) {
      const block = l.blockNumber!, t = await ts(block);
      const args = l.args as unknown as Record<string, never>;
      if (l.eventName === "Spent") out.push({ kind: "spent", token: args.token, amount: args.amount, block, ts: t });
      else if (l.eventName === "Executed") out.push({ kind: "executed", tokenIn: args.tokenIn, amountIn: args.amountIn, tokenOut: args.tokenOut, received: args.received, block, ts: t });
      else if (l.eventName === "Deposited") out.push({ kind: "deposited", amount: args.amount, block, ts: t });
      else if (l.eventName === "Frozen") out.push({ kind: "frozen", by: args.by, block, ts: t });
      else if (l.eventName === "MandateApplied") out.push({ kind: "mandate", nonce: args.nonce, block, ts: t });
    }
  }
  return out;
}

export interface Watcher { pub: PublicClient; guard: Address; cfg?: Config; tokens?: TokenRegistry; freezer?: { send: () => Promise<Hex> }; webhook?: string; log?: (line: string) => void }

/** One poll. Returns the alerts and the new snapshot, so the caller can keep state between polls. */
export async function tick(w: Watcher, prev?: Snapshot): Promise<{ snap: Snapshot; alerts: Alert[]; froze?: Hex }> {
  const reg = { ...DEFAULT_TOKENS, ...(w.tokens ?? {}) };
  const names = (a: Address) => Object.entries(reg).find(([, t]) => lc(t.address) === lc(a))?.[0] ?? a;
  const snap = await snapshot(w.pub, w.guard);
  const events = prev && snap.block > prev.block ? await eventsBetween(w.pub, w.guard, prev.block + 1n, snap.block) : [];
  const alerts = evaluate(prev, snap, events, w.cfg ?? DEFAULT_CONFIG, names);
  let froze: Hex | undefined;
  if (!snap.frozen && w.freezer && alerts.some((a) => a.freeze)) {
    try { froze = await w.freezer.send(); alerts.push({ severity: "crit", code: "auto-frozen", message: `The watcher froze the guard (${froze}). Only a new owner-signed mandate can unfreeze it.` }); }
    catch (e) { alerts.push({ severity: "crit", code: "auto-freeze-failed", message: `The watcher could not freeze the guard: ${e instanceof Error ? e.message : e}` }); }
  }
  const line = w.log ?? ((s: string) => console.log(s));
  for (const a of alerts) line(JSON.stringify({ at: new Date().toISOString(), block: snap.block.toString(), guard: w.guard, ...a }));
  if (w.webhook && alerts.some((a) => a.severity !== "info")) {
    const text = alerts.filter((a) => a.severity !== "info").map((a) => `[${a.severity}] ${a.code}: ${a.message}`).join("\n");
    await fetch(w.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Leash ${w.guard}\n${text}` }) }).catch(() => undefined);
  }
  return { snap, alerts, froze };
}

/** A freezer that holds only a classical key: the owner's or the agent's. It can call freeze() and nothing else. */
export function freezerFor(pub: PublicClient, guard: Address, key: Hex, chain: ReturnType<typeof defineChain>, rpc: string) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  return { send: async () => { const h = await wallet.writeContract({ address: guard, abi: guardV2Abi, functionName: "freeze", chain, account }); await pub.waitForTransactionReceipt({ hash: h }); return h; } };
}

// ------------------------------------------------------------------ CLI

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const guard = (flag("guard") ?? process.env.LEASH_GUARD) as Address | undefined;
  if (!guard) { console.error("Usage: tsx tools/monitor.ts --guard 0x… [--interval 15] [--once] [--webhook URL] [--auto-freeze]"); process.exit(1); }
  const rpc = process.env.LEASH_RPC?.trim() || "https://evm-testnet.qore.host";
  const chain = defineChain({ id: Number(process.env.LEASH_CHAIN_ID || 9800), name: "QoreChain", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const tokens: TokenRegistry = process.env.LEASH_TOKENS ? JSON.parse(process.env.LEASH_TOKENS) : {};
  const key = process.env.LEASH_WATCHER_KEY as Hex | undefined;
  if (args.includes("--auto-freeze") && !key) { console.error("--auto-freeze needs LEASH_WATCHER_KEY: the owner's or the agent's classical key (it can only freeze)."); process.exit(1); }
  const w: Watcher = { pub, guard, tokens, webhook: flag("webhook") ?? process.env.LEASH_WEBHOOK, freezer: args.includes("--auto-freeze") && key ? freezerFor(pub, guard, key, chain, rpc) : undefined };
  const every = Number(flag("interval") ?? 15) * 1000;
  let prev: Snapshot | undefined;
  console.error(`watching ${guard} on ${rpc}${w.freezer ? " (auto-freeze on)" : ""}${w.webhook ? " (webhook on)" : ""}`);
  do {
    try { prev = (await tick(w, prev)).snap; } catch (e) { console.error(`poll failed: ${e instanceof Error ? e.message : e}`); }
    if (args.includes("--once")) break;
    await new Promise((r) => setTimeout(r, every));
  } while (true);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
