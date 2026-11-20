/**
 * policy.ts - turn a plain-English leash into a validated mandate, an on-chain plan and a list of gaps.
 *
 * The parser is deliberately a small deterministic grammar. A language model may DRAFT the sentence
 * (see AI_USAGE.md), but this file decides: anything it cannot parse exactly is refused, and anything
 * the chain cannot enforce is reported as a gap instead of being silently assumed.
 *
 *   "agent 0xAAA… may spend up to 50 fUSD a day, at most 20 fUSD per payment,
 *    and up to 3 QOR a day, at most 1 QOR per payment, only to 0xBBB… and 0xCCC…, for 3 days"
 */
import { z } from "zod";
import { parseUnits, getAddress, type Address } from "viem";

export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** The chain's maximum EVM authorisation window, in blocks (docs: 1 to 17,280). */
export const MAX_WINDOW_BLOCKS = 17_280;
/** Testnet block time is about 1.3 s (docs). Used only to estimate renewals. */
export const BLOCK_SECONDS = 1.3;
export const MAX_ITEMS = 16;

export interface TokenInfo { address: Address; decimals: number }
export type TokenRegistry = Record<string, TokenInfo>;
export const DEFAULT_TOKENS: TokenRegistry = { QOR: { address: NATIVE, decimals: 18 } };

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => getAddress(s));

export type FlowKind = "swap" | "wrap" | "unwrap" | "deposit" | "redeem";
/** Adapter addresses by kind: univ2 (swap), wrap (wrap, unwrap), erc4626 (deposit, redeem). */
export interface AdapterRegistry { univ2?: Address; wrap?: Address; erc4626?: Address }

const routeSchema = z.object({
  kind: z.enum(["swap", "wrap", "unwrap", "deposit", "redeem"]).optional(), // for humans; not part of the wire format
  adapter: addr,
  target: addr,
  tokenIn: addr,
  tokenOut: addr,
  minOutPerInE18: z.bigint().positive(),
});
export type Route = z.infer<typeof routeSchema>;

export const MandateSchema = z.object({
  agent: addr,
  expiry: z.number().int().positive(),
  tokens: z.array(addr).max(MAX_ITEMS),
  // perTx 0 means the token may be received (a swap output) but never spent
  limits: z.array(z.object({ perTx: z.bigint().nonnegative(), daily: z.bigint().nonnegative() })).max(MAX_ITEMS),
  recipients: z.array(addr).max(MAX_ITEMS),
  routes: z.array(routeSchema).max(MAX_ITEMS).default([]),
});
export type Mandate = z.infer<typeof MandateSchema>;

export type Severity = "error" | "warning" | "gap";
export interface Finding { severity: Severity; code: string; message: string }

export interface Plan {
  window: { blocks: number; maxTxs: number; allowedTargets: Address[]; renewals: number };
  steps: string[];
}

export interface Compiled { mandate?: Mandate; plan?: Plan; findings: Finding[]; ok: boolean }

const DURATION = /\bfor\s+(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs|h|day|days|d)\b/i;
const AGENT = /\bagent\s+(0x[0-9a-fA-F]{40})/i;
const RECIPIENTS = /\bonly\s+(?:to|pay|pays)\s+((?:0x[0-9a-fA-F]{40}(?:\s*(?:,|and|&)\s*)?)+)/i;
const AMOUNT = "(\\d+(?:\\.\\d+)?)\\s+([A-Za-z0-9]+|0x[0-9a-fA-F]{40})";
const DAILY = new RegExp(`${AMOUNT}\\s+(?:a|per|each|every)\\s+day`, "gi");
const PER_TX = new RegExp(`(?:at most|max(?:imum)?|no more than|up to)\\s+${AMOUNT}\\s+(?:per|each|a)\\s+(?:payment|transaction|tx|transfer)`, "gi");

// Value-flow clauses. Every flow needs the owner's own rate floor: there is no price oracle on chain.
const SYM = "([A-Za-z0-9]+)";
const NUM = "(\\d+(?:\\.\\d+)?)";
const ADDR = "(0x[0-9a-fA-F]{40})";
const FLOOR = `(?:\\s+at\\s+no\\s+worse\\s+than\\s+${NUM}\\s+${SYM}\\s+per\\s+${SYM})?`;
const SWAP = new RegExp(`\\bswap\\s+${SYM}\\s+(?:for|into|to)\\s+${SYM}\\s+(?:on|via|using)\\s+(?:router\\s+)?${ADDR}${FLOOR}`, "gi");
const WRAP = new RegExp(`\\bwrap\\s+${SYM}\\s+(?:as|into)\\s+${SYM}\\s+(?:on|via|at)\\s+${ADDR}`, "gi");
const UNWRAP = new RegExp(`\\bunwrap\\s+${SYM}\\s+(?:to|into|as)\\s+${SYM}\\s+(?:on|via|at)\\s+${ADDR}`, "gi");
const DEPOSIT = new RegExp(`\\bdeposit\\s+${SYM}\\s+into\\s+vault\\s+${ADDR}\\s+as\\s+${SYM}${FLOOR}`, "gi");
const REDEEM = new RegExp(`\\bredeem\\s+${SYM}\\s+from\\s+vault\\s+${ADDR}\\s+for\\s+${SYM}${FLOOR}`, "gi");
const ANY_FLOW = /\b(?:swap|wrap|unwrap|deposit|redeem)\b/i;

function token(sym: string, reg: TokenRegistry): TokenInfo | undefined {
  if (/^0x[0-9a-fA-F]{40}$/.test(sym)) return Object.values(reg).find((t) => t.address.toLowerCase() === sym.toLowerCase());
  return reg[sym.toUpperCase()] ?? reg[sym];
}

export function compile(
  text: string,
  opts: { now?: number; tokens?: TokenRegistry; guard?: Address; maxTxsPerWindow?: number; adapters?: AdapterRegistry } = {},
): Compiled {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const reg = { ...DEFAULT_TOKENS, ...(opts.tokens ?? {}) };
  const f: Finding[] = [];
  const err = (code: string, message: string) => f.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => f.push({ severity: "warning", code, message });

  const agent = AGENT.exec(text)?.[1];
  if (!agent) err("no-agent", "Name the agent's EVM address: 'agent 0x…'.");

  const rec = RECIPIENTS.exec(text)?.[1];
  const recipients = rec ? [...new Set((rec.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => getAddress(a)))] : [];
  const hasFlows = ANY_FLOW.test(text);
  if (!recipients.length && !hasFlows) err("no-recipients", "Say who the agent may pay: 'only to 0x… and 0x…'. An empty allowlist means the agent can spend nothing.");

  // daily and per-payment caps, by token
  const daily = new Map<string, bigint>();
  const perTx = new Map<string, bigint>();
  const addAmount = (m: RegExpExecArray, into: Map<string, bigint>, what: string) => {
    const info = token(m[2]!, reg);
    if (!info) { err("unknown-token", `Unknown token '${m[2]}' in the ${what} cap. Add it to tokens.json (symbol -> address, decimals).`); return; }
    const key = info.address;
    if (into.has(key)) { err("duplicate-cap", `Two ${what} caps for ${m[2]}.`); return; }
    into.set(key, parseUnits(m[1]!, info.decimals));
  };
  for (const m of text.matchAll(PER_TX)) addAmount(m as RegExpExecArray, perTx, "per-payment");
  // Remove per-payment phrases before reading daily caps, so "at most 20 fUSD per payment" is not read as daily.
  const dailyText = text.replace(PER_TX, " ");
  for (const m of dailyText.matchAll(DAILY)) addAmount(m as RegExpExecArray, daily, "daily");
  if (!daily.size && !perTx.size) err("no-limits", "Give at least one cap: '50 fUSD a day' or 'at most 20 fUSD per payment'.");

  const tokens: Address[] = [];
  const limits: { perTx: bigint; daily: bigint }[] = [];
  for (const key of new Set([...daily.keys(), ...perTx.keys()])) {
    let d = daily.get(key);
    let p = perTx.get(key);
    if (d === undefined && p !== undefined) { d = p; warn("daily-defaulted", `No daily cap for ${key}: using the per-payment cap as the daily cap (one payment a day).`); }
    if (p === undefined && d !== undefined) { p = d; warn("per-tx-defaulted", `No per-payment cap for ${key}: using the daily cap, so one payment can use the whole day.`); }
    if (p! > d!) { err("per-tx-over-daily", `Per-payment cap exceeds the daily cap for ${key}. That per-payment cap could never be reached.`); continue; }
    tokens.push(key as Address);
    limits.push({ perTx: p!, daily: d! });
  }

  // value flows: swap, wrap, unwrap, deposit, redeem
  const routes: Route[] = [];
  const addRoute = (kind: FlowKind, adapter: Address | undefined, target: string, symIn: string, symOut: string, rate?: { n: string; out: string; per: string }) => {
    const tin = token(symIn, reg), tout = token(symOut, reg);
    if (!tin) return err("unknown-token", `Unknown token '${symIn}' in the ${kind} flow. Add it to tokens.json.`);
    if (!tout) return err("unknown-token", `Unknown token '${symOut}' in the ${kind} flow. Add it to tokens.json.`);
    if (!adapter) return err("no-adapter", `No adapter address is configured for '${kind}'. Pass adapters: { ${kind === "swap" ? "univ2" : kind === "wrap" || kind === "unwrap" ? "wrap" : "erc4626"}: 0x… }.`);
    let floor: bigint;
    if (kind === "wrap" || kind === "unwrap") {
      floor = 10n ** 18n;
      warn("fixed-floor", `${kind} floors are fixed at 1:1: a wrapped token must come back one for one.`);
    } else {
      if (!rate) return err("flow-no-floor", `State a rate floor for the ${kind} of ${symIn}: 'at no worse than <amount> ${symOut} per ${symIn}'. The chain has no price oracle: the floor is your own number, enforced on what the guard actually receives.`);
      if (rate.out.toUpperCase() !== symOut.toUpperCase() || rate.per.toUpperCase() !== symIn.toUpperCase()) return err("flow-floor-units", `The floor must be in '${symOut} per ${symIn}'.`);
      floor = (parseUnits(rate.n, tout.decimals) * 10n ** 18n) / 10n ** BigInt(tin.decimals);
      if (floor === 0n) return err("flow-floor-zero", `The floor ${rate.n} ${symOut} per ${symIn} rounds to zero in raw units. A zero floor would allow any rate.`);
    }
    const key = [adapter, getAddress(target), tin.address, tout.address].join("|");
    if (routes.some((r) => [r.adapter, r.target, r.tokenIn, r.tokenOut].join("|") === key)) return err("duplicate-flow", `Two identical ${kind} flows for ${symIn} to ${symOut} on ${target}.`);
    routes.push({ kind, adapter, target: getAddress(target), tokenIn: tin.address, tokenOut: tout.address, minOutPerInE18: floor });
  };
  const A = opts.adapters ?? {};
  for (const m of text.matchAll(SWAP)) addRoute("swap", A.univ2, m[3]!, m[1]!, m[2]!, m[4] ? { n: m[4], out: m[5]!, per: m[6]! } : undefined);
  for (const m of text.matchAll(WRAP)) addRoute("wrap", A.wrap, m[3]!, m[1]!, m[2]!);
  for (const m of text.matchAll(UNWRAP)) addRoute("unwrap", A.wrap, m[3]!, m[1]!, m[2]!);
  for (const m of text.matchAll(DEPOSIT)) addRoute("deposit", A.erc4626, m[2]!, m[1]!, m[3]!, m[4] ? { n: m[4], out: m[5]!, per: m[6]! } : undefined);
  for (const m of text.matchAll(REDEEM)) addRoute("redeem", A.erc4626, m[2]!, m[1]!, m[3]!, m[4] ? { n: m[4], out: m[5]!, per: m[6]! } : undefined);
  if (hasFlows && !routes.length && !f.some((x) => x.severity === "error")) err("flow-unreadable", "I could not read the flow. Forms: 'swap A for B on 0xROUTER at no worse than R B per A', 'wrap QOR into WQOR on 0xWQOR', 'unwrap WQOR to QOR on 0xWQOR', 'deposit A into vault 0xV as SHARES at no worse than R SHARES per A', 'redeem SHARES from vault 0xV for A at no worse than R A per SHARES'.");
  for (const r of routes) {
    if (!tokens.includes(r.tokenIn) || limits[tokens.indexOf(r.tokenIn)]!.perTx === 0n) {
      err("flow-uncapped", `The ${r.kind} spends ${r.tokenIn}, which has no cap. Add a cap such as '100 FUSD a day'.`);
    }
    if (!tokens.includes(r.tokenOut)) {
      tokens.push(r.tokenOut);
      limits.push({ perTx: 0n, daily: 0n });
      warn("receive-only", `${Object.entries(reg).find(([, t]) => t.address === r.tokenOut)?.[0] ?? r.tokenOut} is listed to receive swap or vault output only. The agent cannot spend it unless you give it a cap.`);
    }
  }
  if (routes.length) {
    f.push({ severity: "gap", code: "rate-floor-no-oracle", message: "A rate floor is your own number. The guard enforces it on what was actually received, but nothing checks it against the market: a stale floor blocks good trades or allows bad ones. Review it when prices move." });
    f.push({ severity: "gap", code: "target-trust", message: "A route trusts its target contract to honour the call. A malicious or upgraded router is bounded by the floor and the caps, not removed. Only route to contracts you have read." });
    f.push({ severity: "gap", code: "partial-measure", message: "The guard measures the first input and the final output. Intermediate tokens in a multi-hop swap pass through the router unmeasured." });
    f.push({ severity: "gap", code: "native-amm", message: "QoreChain's native AMM (x/amm) cannot be called from a contract, so it is not a route. Only EVM routers, wrapped tokens and ERC-4626 vaults are." });
  }

  // duration
  const dm = DURATION.exec(text);
  let seconds: number;
  if (dm) {
    const n = Number(dm[1]);
    seconds = /^h/i.test(dm[2]!) ? n * 3600 : n * 86400;
  } else {
    seconds = 86400;
    warn("expiry-defaulted", "No duration given: the mandate expires in 24 hours. Say 'for 3 days' to choose.");
  }
  if (seconds > 30 * 86400) warn("long-expiry", "A mandate longer than 30 days is a long time to trust an unattended key. Prefer short mandates and renew them.");
  if (seconds < 600) err("too-short", "Under 10 minutes is shorter than a testnet window's practical use.");

  if (tokens.length > MAX_ITEMS || recipients.length > MAX_ITEMS || routes.length > MAX_ITEMS) err("too-many", `At most ${MAX_ITEMS} tokens, ${MAX_ITEMS} recipients and ${MAX_ITEMS} flows.`);

  // gaps: what the chain does NOT enforce for this setup
  f.push({ severity: "gap", code: "outside-guard", message: "Limits cover only funds held by the guard. Anything the agent's own account holds is not covered; keep that near zero." });
  f.push({ severity: "gap", code: "token-limits-need-guard", message: "The chain's EVM window counts only native QOR as value, and an ERC-20 transfer counts as zero. Token caps are enforced by the guard contract, not by the window." });
  f.push({ severity: "gap", code: "fixed-bucket", message: "The daily cap is a fixed 24-hour bucket, not a rolling window: an agent can spend one cap at the end of a bucket and another at the start of the next." });

  const errors = f.some((x) => x.severity === "error");
  if (errors || !agent) return { findings: f, ok: false };

  const mandate = MandateSchema.parse({ agent, expiry: now + Math.round(seconds), tokens, limits, recipients, routes });

  // plan: the chain-level window and the steps to apply
  const blocksNeeded = Math.ceil(seconds / BLOCK_SECONDS);
  const renewals = Math.max(0, Math.ceil(blocksNeeded / MAX_WINDOW_BLOCKS) - 1);
  const window = {
    blocks: Math.min(blocksNeeded, MAX_WINDOW_BLOCKS),
    maxTxs: opts.maxTxsPerWindow ?? 20,
    allowedTargets: opts.guard ? [opts.guard] : [],
    renewals,
  };
  if (renewals > 0) {
    f.push({ severity: "gap", code: "window-renewals", message: `The chain caps an EVM window at ${MAX_WINDOW_BLOCKS} blocks (about ${(MAX_WINDOW_BLOCKS * BLOCK_SECONDS / 3600).toFixed(1)} hours). This mandate needs ${renewals} renewal(s), each a hybrid-signed message from a keeper that holds the agent account's ML-DSA-87 key. Keep that key off the agent's machine.` });
  }
  if (!opts.guard) warn("no-guard", "No guard address yet: the window's allowedTargets is empty until you deploy the guard.");
  const steps = [
    routes.length
      ? "1. Deploy LeashGuardV2(owner) and the adapters it routes through, and fund the guard with only what the agent should be able to spend."
      : "1. Deploy LeashGuard(owner) and fund it with only what the agent should be able to spend.",
    "2. Owner signs the mandate with ML-DSA-87 (message bound to chain id, guard, nonce, mandate) and anyone submits applyMandate.",
    `3. Open the agent account's EVM window: ${window.blocks} blocks, max ${window.maxTxs} txs, allowedTargets = [guard]. Needs the agent account's registered ML-DSA-87 key.`,
    "4. Give the agent only its secp256k1 key. It never holds an ML-DSA-87 key.",
    "5. Kill switch: owner's classical key (or the agent) can call freeze() at any time. Only a new signed mandate unfreezes.",
  ];
  return { mandate, plan: { window, steps }, findings: f, ok: true };
}

export function describe(m: Mandate, reg: TokenRegistry = DEFAULT_TOKENS): string {
  const name = (a: string) => Object.entries(reg).find(([, t]) => t.address === a)?.[0] ?? a;
  const dec = (a: string) => Object.values(reg).find((t) => t.address === a)?.decimals ?? 18;
  const fmt = (v: bigint, a: string) => {
    const d = dec(a);
    const s = v.toString().padStart(d + 1, "0");
    return `${s.slice(0, -d)}${d ? "." + s.slice(-d).replace(/0+$/, "") : ""}`.replace(/\.$/, "");
  };
  const flows = m.routes.map((r) => `${r.kind ?? "route"} ${name(r.tokenIn)} to ${name(r.tokenOut)} on ${r.target}`);
  return m.tokens.map((t, i) => `${fmt(m.limits[i]!.daily, t)} ${name(t)}/day, ${fmt(m.limits[i]!.perTx, t)} ${name(t)}/payment`).join("; ")
    + ` to ${m.recipients.length} recipient(s)` + (flows.length ? `; flows: ${flows.join("; ")}` : "") + ` until ${new Date(m.expiry * 1000).toISOString()}`;
}
