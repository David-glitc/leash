/**
 * attack-v2.ts - the Q-Day drill for LeashGuardV2: a leaked agent key and a leaked owner key play against
 * guarded on-chain actions (swaps), not just payments. Expected result is stated first for every attempt.
 */
import { toHex, BaseError, ContractFunctionRevertedError, type Account, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Mandate } from "./policy.ts";
import { guardV2Abi, wireMandateV2 } from "./wire.ts";
import { swap, floorOut } from "./actions.ts";
import type { PqcSigner, Result } from "./attack.ts";

export interface CtxV2 {
  chain: Chain;
  pub: PublicClient;
  guard: Address;
  agent: WalletClient & { account: Account };
  owner: WalletClient & { account: Account };
  stranger: WalletClient & { account: Account };
  ownerPqc: PqcSigner;
  mandate: Mandate;
  /** The swap route the mandate allows: adapter address, router, and the pair. Must be the first non-native-in route. */
  swapAdapter: Address;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** A router NOT in the mandate. */
  unlistedRouter: Address;
  /** A router that IS in the mandate but under-delivers, so the rate floor has something to catch. */
  shortRouter?: Address;
  otherGuard?: Address;
  warp?: (seconds: number) => Promise<void>;
  gas?: bigint;
}

function why(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e);
}

export async function runSuiteV2(ctx: CtxV2): Promise<Result[]> {
  const { pub, guard, agent, owner, stranger, mandate } = ctx;
  const gas = ctx.gas ?? 2_000_000n;
  const out: Result[] = [];
  const idx = mandate.tokens.findIndex((t) => t.toLowerCase() === ctx.tokenIn.toLowerCase());
  const lim = mandate.limits[idx]!;
  const route = mandate.routes.find((r) => r.target.toLowerCase() === ctx.router.toLowerCase() && r.tokenIn.toLowerCase() === ctx.tokenIn.toLowerCase())!;
  const evil = stranger.account.address;
  const build = (router: Address, amountIn: bigint, to?: Address, minOut?: bigint) =>
    swap({ guard, adapters: { univ2: ctx.swapAdapter }, target: router, tokenIn: ctx.tokenIn, tokenOut: ctx.tokenOut, amountIn, minOut: minOut ?? floorOut(amountIn, route.minOutPerInE18), to });
  const exec = (a: ReturnType<typeof build>) => [a.adapter, a.target, a.data, a.value] as const;
  const sim = (account: Account, fn: string, args: unknown[]) =>
    pub.simulateContract({ account, address: guard, abi: guardV2Abi, functionName: fn as never, args: args as never, gas } as never);
  const send = async (w: typeof agent, fn: string, args: unknown[]) => {
    const hash = await w.writeContract({ address: guard, abi: guardV2Abi, functionName: fn as never, args: args as never, gas, chain: ctx.chain, account: w.account } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    return { hash, ok: r.status === "success" };
  };
  const blocked = async (who: Result["attacker"], attempt: string, errorName: string, call: () => Promise<unknown>): Promise<Result> => {
    try {
      await call();
      return { attacker: who, attempt, expected: `blocked (${errorName})`, outcome: "NOT BLOCKED: the call would have succeeded", pass: false };
    } catch (e) {
      const got = why(e);
      return { attacker: who, attempt, expected: `blocked (${errorName})`, outcome: `blocked (${got})`, pass: got === errorName };
    }
  };
  const nonce = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "nonce" })) as bigint;
  const greedy: Mandate = {
    ...mandate, agent: evil, recipients: [evil], expiry: mandate.expiry + 90 * 86400,
    limits: mandate.limits.map((l) => ({ perTx: l.perTx * 1000n, daily: l.daily * 1000n })),
    routes: mandate.routes.map((r) => ({ ...r, minOutPerInE18: 1n })), // a floor of "anything goes"
  };

  // Control: a legitimate swap must work, or "everything is blocked" would look like a pass.
  const small = lim.perTx / 10n > 0n ? lim.perTx / 10n : lim.perTx;
  try {
    const r = await send(agent, "execute", [...exec(build(ctx.router, small))]);
    out.push({ attacker: "control", attempt: "legitimate swap inside the mandate, output to the guard", expected: "succeeds", outcome: r.ok ? "succeeded" : "reverted", pass: r.ok, tx: r.hash });
  } catch (e) {
    out.push({ attacker: "control", attempt: "legitimate swap inside the mandate, output to the guard", expected: "succeeds", outcome: `failed: ${why(e)}`, pass: false });
  }

  // A. The agent's classical key leaked.
  out.push(await blocked("agent key", "swap more than the per-action cap", "OverPerTxLimit", () => sim(agent.account, "execute", [...exec(build(ctx.router, lim.perTx + 1n))])));
  out.push(await blocked("agent key", "swap and send the output to the attacker", "OutputNotToGuard", () => sim(agent.account, "execute", [...exec(build(ctx.router, small, evil))])));
  out.push(await blocked("agent key", "swap on a router the owner did not allow", "RouteNotAllowed", () => sim(agent.account, "execute", [...exec(build(ctx.unlistedRouter, small))])));
  out.push(await blocked("agent key", "send arbitrary call data through the swap adapter", "BadAction", () => sim(agent.account, "execute", [ctx.swapAdapter, ctx.router, "0xdeadbeef00000000000000000000000000000000000000000000000000000000", 0n])));
  if (ctx.shortRouter) out.push(await blocked("agent key", "swap on an allowed router that under-delivers (rate floor)", "BelowRateFloor", () => sim(agent.account, "execute", [...exec(build(ctx.shortRouter!, small, undefined, 0n))]))); // the attacker sets amountOutMin to 0, so only the guard's own measurement can catch it
  {
    // Use up what is left of today's cap with allowed swaps, then one more must fail.
    let guardCount = 0;
    const remaining = async () => (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "remainingToday", args: [ctx.tokenIn] })) as bigint;
    while ((await remaining()) >= lim.perTx && guardCount++ < 40) {
      const r = await send(agent, "execute", [...exec(build(ctx.router, lim.perTx))]);
      if (!r.ok) break;
    }
    const left = await remaining();
    out.push(await blocked("agent key", `keep swapping after the daily cap (${left} left)`, "OverDailyLimit", () => sim(agent.account, "execute", [...exec(build(ctx.router, left + 1n))])));
  }
  out.push(await blocked("agent key", "loosen the routes and caps with a forged post-quantum signature", "BadPqcSignature", () => sim(agent.account, "applyMandate", [wireMandateV2(greedy), toHex(new Uint8Array(32).fill(7))])));
  out.push(await blocked("agent key", "loosen the rate floor with a signature for a different mandate", "BadPqcSignature", async () => {
    const msg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(mandate), nonce] })) as Hex;
    return sim(agent.account, "applyMandate", [wireMandateV2(greedy), ctx.ownerPqc.sign(msg)]);
  }));
  if (ctx.otherGuard) {
    out.push(await blocked("agent key", "replay the owner's signature from a different guard", "BadPqcSignature", async () => {
      const msg = (await pub.readContract({ address: ctx.otherGuard!, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(mandate), nonce] })) as Hex;
      return sim(agent.account, "applyMandate", [wireMandateV2(mandate), ctx.ownerPqc.sign(msg)]);
    }));
  }

  // B. The owner's classical key leaked.
  out.push(await blocked("owner key", "run a swap directly", "NotAgent", () => sim(owner.account, "execute", [...exec(build(ctx.router, small))])));
  out.push(await blocked("owner key", "grant itself looser routes (no post-quantum signature)", "BadPqcSignature", () => sim(owner.account, "applyMandate", [wireMandateV2(greedy), toHex(new Uint8Array(32).fill(9))])));
  try {
    const f = await send(owner, "freeze", []);
    out.push({ attacker: "owner key", attempt: "freeze the guard (the kill switch)", expected: "allowed (it can only stop things)", outcome: f.ok ? "allowed" : "reverted", pass: f.ok, tx: f.hash });
    out.push(await blocked("agent key", "keep swapping after the freeze", "IsFrozen", () => sim(agent.account, "execute", [...exec(build(ctx.router, small))])));
    const oldMsg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(mandate), nonce > 0n ? nonce - 1n : 0n] })) as Hex;
    out.push(await blocked("owner key", "unfreeze with an old signature", "BadPqcSignature", () => sim(owner.account, "applyMandate", [wireMandateV2(mandate), ctx.ownerPqc.sign(oldMsg)])));
  } catch (e) {
    out.push({ attacker: "owner key", attempt: "freeze the guard (the kill switch)", expected: "allowed", outcome: `failed: ${why(e)}`, pass: false });
  }

  if (ctx.warp) {
    const n2 = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "nonce" })) as bigint;
    const msg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(mandate), n2] })) as Hex;
    await send(stranger, "applyMandate", [wireMandateV2(mandate), ctx.ownerPqc.sign(msg)]);
    await ctx.warp(Math.max(0, mandate.expiry - Math.floor(Date.now() / 1000)) + 3600);
    out.push(await blocked("agent key", "keep swapping after the mandate expired", "Expired", () => sim(agent.account, "execute", [...exec(build(ctx.router, small))])));
  }
  return out;
}
