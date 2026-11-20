/**
 * campaign.ts - a randomized attack campaign against a LIVE LeashGuardV2.
 *
 *   pnpm campaign [--n 600] [--guard 0x…]
 *
 * It fires hundreds of random calls at the guard as a leaked agent key, the owner's classical key and a stranger:
 * payments and swaps with boundary and hostile arguments, forged mandates, junk call data. Calls are simulated (eth_call), so
 * nothing is sent and no state changes. An independent oracle, written from the mandate alone, decides for every ACCEPTED call
 * whether the mandate allowed it. Any accepted call the oracle did not allow is a violation. The goal is zero.
 * Needs a guard with a valid mandate (see `pnpm testnet v2rearm`); on an expired or frozen guard it reports that instead.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { BaseError, createPublicClient, decodeErrorResult, defineChain, encodeFunctionData, http, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { guardV2Abi } from "./wire.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const N = Number(flag("n") ?? 600);
const RPC = process.env.LEASH_RPC?.trim() || "https://evm-testnet.qore.host";
const chain = defineChain({ id: 9800, name: "QoreChain testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const state = JSON.parse(readFileSync(new URL("../reports/testnet-v2-state.json", import.meta.url), "utf8"));
const guard = (flag("guard") ?? state.guard) as Address;

// deterministic pseudo-random, so a run can be reproduced: --seed
let seed = Number(flag("seed") ?? 20261120) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const randAddr = (): Address => `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("")}` as Address;
const randBytes = (n: number): Hex => `0x${Array.from({ length: n * 2 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("")}` as Hex;
const lc = (a: string) => a.toLowerCase();

const ABI = guardV2Abi;
const viewAbi = parseAbi(["function agent() view returns (address)", "function owner() view returns (address)", "function frozen() view returns (bool)", "function expiry() view returns (uint64)", "function tokens() view returns (address[])", "function recipients() view returns (address[])", "function limitOf(address) view returns (uint128 perTx, uint128 daily)"]);
const rd = <T,>(abi: typeof viewAbi | typeof ABI, fn: string, a: unknown[] = []) => pub.readContract({ address: guard, abi: abi as never, functionName: fn as never, args: a as never }) as Promise<T>;
const router = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const wrapAbi = parseAbi(["function deposit()", "function withdraw(uint256 amount)"]);
const vaultAbi = parseAbi(["function deposit(uint256 assets, address receiver)", "function redeem(uint256 shares, address receiver, address owner)"]);

async function main() {
  const [agent, owner, frozen, expiry, toks, recips, routes, block] = await Promise.all([
    rd<Address>(viewAbi, "agent"), rd<Address>(viewAbi, "owner"), rd<boolean>(viewAbi, "frozen"), rd<bigint>(viewAbi, "expiry"), rd<Address[]>(viewAbi, "tokens"), rd<Address[]>(viewAbi, "recipients"),
    rd<{ adapter: Address; target: Address; tokenIn: Address; tokenOut: Address; minOutPerInE18: bigint }[]>(ABI, "routes"), pub.getBlock(),
  ]);
  if (frozen || Number(block.timestamp) >= Number(expiry)) { console.log(`The guard is ${frozen ? "frozen" : "expired"}: arm it first (pnpm testnet v2rearm).`); process.exit(2); }
  const limits: Record<string, { perTx: bigint; daily: bigint; remaining: bigint }> = {};
  for (const t of [...toks, zeroAddress]) { const [p, d] = await rd<readonly [bigint, bigint]>(viewAbi, "limitOf", [t]); limits[lc(t)] = { perTx: p, daily: d, remaining: await rd<bigint>(ABI, "remainingToday", [t]) }; }
  const stranger = randAddr();
  const senders = [{ name: "agent key", a: agent }, { name: "owner key", a: owner }, { name: "stranger", a: stranger }];
  const tokenPool = [...toks, zeroAddress, randAddr(), randAddr()];
  const adapters = [...new Set(routes.map((r) => r.adapter))];
  const targets = [...new Set(routes.map((r) => r.target))];
  const adapterPool = [...adapters, randAddr(), guard, zeroAddress];
  const targetPool = [...targets, randAddr(), guard, "0x0000000000000000000000000000000000000a01" as Address, zeroAddress];
  const recipPool = [...recips, randAddr(), stranger, agent, owner, guard];
  const amountsFor = (t: Address) => { const l = limits[lc(t)]; if (!l) return [0n, 1n, 10n ** 18n, 10n ** 30n]; return [0n, 1n, l.perTx - 1n, l.perTx, l.perTx + 1n, l.remaining, l.remaining + 1n, l.daily + 1n, l.perTx * 2n, BigInt(Math.floor(rnd() * 1e9)) * 10n ** 9n].filter((x) => x >= 0n); };

  type Attempt = { fn: string; sender: (typeof senders)[0]; data: Hex; value: bigint; legit: (accepted: boolean) => string | null; label: string; expectAccept?: boolean };
  const known = (t: Address) => limits[lc(t)] !== undefined;
  const routeFor = (ad: Address, tg: Address, ti: Address, to: Address) => routes.find((r) => lc(r.adapter) === lc(ad) && lc(r.target) === lc(tg) && lc(r.tokenIn) === lc(ti) && lc(r.tokenOut) === lc(to));

  const spendable = toks.filter((t) => (limits[lc(t)]?.perTx ?? 0n) > 0n);
  function genSpend(): Attempt {
    const near = rnd() < 0.45 && spendable.length > 0 && recips.length > 0; // close to legitimate: agent, allowed payee, spendable token
    const sender = near ? senders[0]! : pick(senders), token = near ? pick(spendable) : pick(tokenPool), to = near ? pick(recips) : pick(recipPool), amount = pick(amountsFor(token));
    const l = limits[lc(token)];
    const ok = sender.a === agent && recips.some((r) => lc(r) === lc(to)) && !!l && l.perTx > 0n && amount <= l.perTx && amount <= l.remaining; // amount 0 passes the guard too
    return { fn: "spend", sender, label: `spend ${amount} of ${token.slice(0, 8)} to ${to.slice(0, 8)}`, data: encodeFunctionData({ abi: ABI, functionName: "spend", args: [token, to, amount] }), value: 0n, legit: (acc) => (acc && !ok ? "spend accepted outside the mandate" : null) };
  }
  function nearLegitExecute(): Attempt {
    const r = pick(routes), sender = senders[0]!;
    const amount = pick(amountsFor(r.tokenIn)); const native = lc(r.tokenIn) === lc(zeroAddress);
    let data: Hex, value = 0n, label: string;
    if (lc(r.adapter) === lc(state.adapters.univ2)) { label = "swap"; data = encodeFunctionData({ abi: router, functionName: "swapExactTokensForTokens", args: [amount, pick([0n, 1n]), [r.tokenIn, r.tokenOut], guard, 9999999999n] }); }
    else if (lc(r.adapter) === lc(state.adapters.wrap)) { label = native ? "wrap" : "unwrap"; if (native) { value = amount; data = encodeFunctionData({ abi: wrapAbi, functionName: "deposit" }); } else data = encodeFunctionData({ abi: wrapAbi, functionName: "withdraw", args: [amount] }); }
    else { const dep = lc(r.tokenOut) === lc(r.target); label = dep ? "vault deposit" : "vault redeem"; data = dep ? encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amount, guard] }) : encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [amount, guard, guard] }); }
    const l = limits[lc(r.tokenIn)]!;
    const within = amount > 0n && l.perTx > 0n && amount <= l.perTx && amount <= l.remaining;
    return { fn: "execute", sender, label: label + " (near-legitimate)", data: encodeFunctionData({ abi: ABI, functionName: "execute", args: [r.adapter, r.target, data, value] }), value: 0n,
      legit: (acc) => (acc && !within ? "execute accepted beyond the caps" : null), expectAccept: within };
  }
  function genExecute(): Attempt {
    if (rnd() < 0.5) return nearLegitExecute();
    const sender = pick(senders);
    let adapter = pick(adapterPool), target = pick(targetPool);
    const r0 = pick(routes);
    if (rnd() < 0.65) { adapter = r0.adapter; target = r0.target; }
    const kind = Math.floor(rnd() * 8);
    let data: Hex = "0x", value = 0n, ti: Address = zeroAddress, to: Address = zeroAddress, amountIn = 0n, receiver: Address = guard, label = "junk";
    const dest = () => (rnd() < 0.7 ? guard : pick(recipPool));
    if (kind <= 2) { // swap, tokens in / tokens out
      const a = rnd() < 0.7 ? r0.tokenIn : pick(tokenPool), b = rnd() < 0.7 ? r0.tokenOut : pick(tokenPool);
      amountIn = pick(amountsFor(a)); receiver = dest(); ti = a; to = b; label = "swap";
      const path = rnd() < 0.15 ? [a] : rnd() < 0.15 ? [a, pick(tokenPool), pick(tokenPool), pick(tokenPool), b] : [a, b];
      data = encodeFunctionData({ abi: router, functionName: "swapExactTokensForTokens", args: [amountIn, pick([0n, 1n, amountIn]), path, receiver, 9999999999n] });
    } else if (kind === 3) { // native in
      const b = rnd() < 0.7 ? r0.tokenOut : pick(tokenPool); value = pick([0n, 1n, 10n ** 17n, 10n ** 18n, 10n ** 19n]); amountIn = value; ti = zeroAddress; to = b; receiver = dest(); label = "swap native in";
      data = encodeFunctionData({ abi: router, functionName: "swapExactETHForTokens", args: [0n, [pick(tokenPool), b], receiver, 9999999999n] });
    } else if (kind === 4) { // wrap / unwrap
      const w = pick(tokenPool);
      if (rnd() < 0.5) { value = pick([0n, 1n, 10n ** 18n, 2n * 10n ** 18n]); amountIn = value; ti = zeroAddress; to = target; label = "wrap"; data = encodeFunctionData({ abi: wrapAbi, functionName: "deposit" }); }
      else { amountIn = pick(amountsFor(w)); ti = target; to = zeroAddress; label = "unwrap"; data = encodeFunctionData({ abi: wrapAbi, functionName: "withdraw", args: [amountIn] }); }
    } else if (kind === 5) { // vault
      const v = pick(tokenPool); receiver = dest();
      if (rnd() < 0.5) { ti = state.tokens.USD as Address; amountIn = pick(amountsFor(ti)); to = target; label = "vault deposit"; data = encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amountIn, receiver] }); }
      else { amountIn = pick(amountsFor(target)); ti = target; to = v; label = "vault redeem"; data = encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [amountIn, receiver, rnd() < 0.7 ? guard : pick(recipPool)] }); }
    } else if (kind === 6) { data = randBytes(4 + Math.floor(rnd() * 100)); label = "random call data"; }
    else { data = "0x"; label = "empty call data"; }
    const legit = (acc: boolean) => {
      if (!acc) return null;
      if (sender.a !== agent) return "execute accepted for someone who is not the agent";
      if (receiver !== guard) return "execute accepted with the output going elsewhere";
      if (!(lc(adapter) !== "" && targets.some((t) => lc(t) === lc(target)) && adapters.some((x) => lc(x) === lc(adapter)))) return "execute accepted for an adapter or target the owner never allowed";
      if (label === "junk" || label === "random call data" || label === "empty call data") return "execute accepted with call data no adapter understands";
      const l = limits[lc(ti)];
      if (!l || l.perTx === 0n || amountIn > l.perTx || amountIn > l.remaining) return "execute accepted beyond the caps";
      return null;
    };
    return { fn: "execute", sender, label, data: encodeFunctionData({ abi: ABI, functionName: "execute", args: [adapter, target, data, value] }), value: 0n, legit };
  }
  function genApply(): Attempt {
    const sender = pick(senders);
    const m = { agent: pick([agent, stranger, zeroAddress, randAddr()]), expiry: BigInt(Number(block.timestamp) + pick([-5, 0, 1000, 86400 * 60])), tokens: [pick(tokenPool)], limits: [{ perTx: BigInt(pick([0, 1, 10 ** 30])), daily: BigInt(pick([0, 1, 10 ** 30])) }], recipients: [stranger], routes: [] as never[] };
    const sig = pick([randBytes(0), randBytes(32), randBytes(4627), "0x00" as Hex]);
    return { fn: "applyMandate", sender, label: "forged mandate", data: encodeFunctionData({ abi: ABI, functionName: "applyMandate", args: [m as never, sig] }), value: 0n, legit: (acc) => (acc ? "applyMandate accepted with a forged signature" : null) };
  }
  function genFreeze(): Attempt {
    const sender = pick(senders);
    return { fn: "freeze", sender, label: "freeze", data: encodeFunctionData({ abi: ABI, functionName: "freeze" }), value: 0n, legit: (acc) => (acc && sender.a === stranger ? "freeze accepted for a stranger" : null) };
  }
  const gens = [genSpend, genSpend, genExecute, genExecute, genExecute, genApply, genFreeze];

  const attempts = Array.from({ length: N }, () => pick(gens)());
  const counts: Record<string, { accepted: number; refused: number }> = {};
  const reasons: Record<string, number> = {};
  const violations: string[] = [];
  const unexpectedRefusals: string[] = [];
  let legitAccepted = 0;
  const classify = async (a: Attempt) => {
    try {
      await pub.call({ to: guard, data: a.data, account: a.sender.a, value: a.value, gas: 3_000_000n });
      return { accepted: true, reason: "" };
    } catch (e) {
      const raw = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown })?.data === "string" && ((x as { data: string }).data.length >= 10)) as { data?: Hex } | null) : null;
      let reason = "reverted without a reason";
      try { if (raw?.data) reason = decodeErrorResult({ abi: ABI, data: raw.data }).errorName; } catch { reason = "reverted (undecoded)"; }
      return { accepted: false, reason };
    }
  };
  for (let i = 0; i < attempts.length; i += 12) {
    const batch = attempts.slice(i, i + 12);
    const out = await Promise.all(batch.map(classify));
    batch.forEach((a, j) => {
      const r = out[j]!;
      const c = (counts[a.fn] ??= { accepted: 0, refused: 0 });
      if (r.accepted) { c.accepted++; if (a.sender.a === agent && a.fn !== "freeze") legitAccepted++; } else { c.refused++; reasons[r.reason] = (reasons[r.reason] ?? 0) + 1; }
      if (a.expectAccept && !r.accepted) unexpectedRefusals.push(`${a.label} refused: ${r.reason}`);
      const v = a.legit(r.accepted);
      if (v) violations.push(`${v}: ${a.label} from ${a.sender.name}`);
    });
    process.stderr.write(`\r${Math.min(i + 12, N)}/${N}`);
  }
  process.stderr.write("\n");
  const accepted = Object.values(counts).reduce((s, c) => s + c.accepted, 0);
  const report = { network: "qorechain-diana", guard, attempts: N, seed: Number(flag("seed") ?? 20261120), at: new Date().toISOString(), block: block.number.toString(), accepted, refused: N - accepted, violations: violations.length, unexpectedRefusals: unexpectedRefusals.length, unexpectedRefusalDetails: [...new Set(unexpectedRefusals)].slice(0, 10), byFunction: counts, refusedBy: reasons, violationDetails: violations.slice(0, 20), note: "Calls are simulated with eth_call: nothing is sent and no state changes. An independent oracle checks every accepted call against the mandate." };
  mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../reports/attack-campaign.json", import.meta.url), JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\n${N} random attacks on ${guard} (block ${block.number}):`);
  console.log(`  accepted ${accepted} (all inside the mandate, including ${legitAccepted} legitimate agent calls), refused ${N - accepted}`);
  console.log("  by function:", Object.entries(counts).map(([k, v]) => `${k} ${v.accepted + v.refused} (${v.accepted} accepted)`).join(", "));
  console.log("  refused by:", Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
  console.log(`  VIOLATIONS: ${violations.length}   (accepted calls the mandate did not allow)`);
  console.log(`  unexpected refusals: ${unexpectedRefusals.length}   (within-mandate calls the guard refused)`);
  for (const u of [...new Set(unexpectedRefusals)].slice(0, 5)) console.log("   ~", u);
  for (const v of violations.slice(0, 10)) console.log("   -", v);
  process.exit(violations.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
