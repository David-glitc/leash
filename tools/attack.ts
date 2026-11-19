/**
 * attack.ts - the Q-Day drill for your own agent wallet.
 *
 * Plays the two attackers that matter against a deployed LeashGuard:
 *   A. the agent's classical key leaked (secp256k1 only)
 *   B. the owner's classical key leaked (secp256k1 only)
 * Neither holds an ML-DSA-87 key. Each attempt is expected to be BLOCKED, except the kill switch
 * (freeze), which is expected to WORK, and one legitimate payment that must succeed (otherwise a
 * guard that refuses everything would "pass"). Anything unexpected is reported as a failure.
 */
import {
  BaseError, ContractFunctionRevertedError, encodePacked, keccak256, toHex, parseAbi,
  type Account, type Address, type Hex, type PublicClient, type WalletClient, type Chain,
} from "viem";
import type { Mandate } from "./policy.ts";

export const guardAbi = parseAbi([
  "function owner() view returns (address)",
  "function agent() view returns (address)",
  "function frozen() view returns (bool)",
  "function nonce() view returns (uint256)",
  "function remainingToday(address token) view returns (uint256)",
  "function spend(address token, address to, uint256 amount)",
  "function freeze()",
  "function mandateMessage((address agent, uint64 expiry, address[] tokens, (uint128 perTx, uint128 daily)[] limits, address[] recipients) m, uint256 nonce) view returns (bytes)",
  "function applyMandate((address agent, uint64 expiry, address[] tokens, (uint128 perTx, uint128 daily)[] limits, address[] recipients) m, bytes sig)",
  "error NotAgent()", "error NotOwnerOrAgent()", "error IsFrozen()", "error Expired()", "error TokenNotSpendable()",
  "error RecipientNotAllowed()", "error OverPerTxLimit()", "error OverDailyLimit()", "error OwnerKeyNotRegistered()",
  "error OwnerKeyNotProven()", "error BadPqcSignature()", "error BadMandate()", "error TransferFailed()",
]);

/** Signs with the OWNER's ML-DSA-87 key. The attackers never get one of these. */
export interface PqcSigner { sign(message: Hex): Hex }

/** Local stand-in matching the test mock: valid iff sig = keccak256("ok", pubkey, message). */
export const mockSigner: PqcSigner = {
  sign: (message) => keccak256(encodePacked(["string", "bytes", "bytes"], ["ok", "0xc0ffee", message])),
};

export const wireMandate = (m: Mandate) => ({
  agent: m.agent, expiry: BigInt(m.expiry), tokens: m.tokens, limits: m.limits.map((l) => ({ perTx: l.perTx, daily: l.daily })), recipients: m.recipients,
});

export interface Ctx {
  chain: Chain;
  pub: PublicClient;
  guard: Address;
  /** Wallet clients holding ONLY secp256k1 keys. */
  agent: WalletClient & { account: Account };
  owner: WalletClient & { account: Account };
  stranger: WalletClient & { account: Account };
  ownerPqc: PqcSigner;
  mandate: Mandate;
  /** A second guard the owner also controls, for the cross-guard replay attempt. */
  otherGuard?: Address;
  /** Optional hooks for a local chain; on a public testnet they are absent and those checks are skipped. */
  warp?: (seconds: number) => Promise<void>;
  gas?: bigint;
}

export interface Result {
  attacker: "agent key" | "owner key" | "control";
  attempt: string;
  expected: string;
  outcome: string;
  pass: boolean;
  tx?: Hex;
}

function why(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e);
}

async function expectBlocked(ctx: Ctx, who: Result["attacker"], attempt: string, errorName: string, call: () => Promise<unknown>): Promise<Result> {
  try {
    await call();
    return { attacker: who, attempt, expected: `blocked (${errorName})`, outcome: "NOT BLOCKED: the call would have succeeded", pass: false };
  } catch (e) {
    const got = why(e);
    return { attacker: who, attempt, expected: `blocked (${errorName})`, outcome: `blocked (${got})`, pass: got === errorName };
  }
}

export async function runSuite(ctx: Ctx): Promise<Result[]> {
  const { pub, guard, agent, owner, stranger, mandate } = ctx;
  const gas = ctx.gas ?? 1_500_000n;
  const out: Result[] = [];
  const tokenIdx = 0;
  const token = mandate.tokens[tokenIdx]!;
  const lim = mandate.limits[tokenIdx]!;
  const okRecipient = mandate.recipients[0]!;
  const evil = stranger.account.address;
  const sim = (account: Account, fn: string, args: unknown[]) =>
    pub.simulateContract({ account, address: guard, abi: guardAbi, functionName: fn as never, args: args as never, gas } as never);
  const send = async (w: typeof agent, fn: string, args: unknown[]) => {
    const hash = await w.writeContract({ address: guard, abi: guardAbi, functionName: fn as never, args: args as never, gas, chain: ctx.chain, account: w.account } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    return { hash, ok: r.status === "success" };
  };
  const nonce = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "nonce" })) as bigint;
  const greedy = { ...mandate, agent: evil, recipients: [evil], limits: mandate.limits.map((l) => ({ perTx: l.perTx * 1000n, daily: l.daily * 1000n })), expiry: mandate.expiry + 90 * 86400 };

  // Control: a legitimate payment must work, or "everything is blocked" would look like a pass.
  {
    const small = lim.perTx / 10n > 0n ? lim.perTx / 10n : lim.perTx;
    try {
      const r = await send(agent, "spend", [token, okRecipient, small]);
      out.push({ attacker: "control", attempt: "legitimate payment inside the mandate", expected: "succeeds", outcome: r.ok ? "succeeded" : "reverted", pass: r.ok, tx: r.hash });
    } catch (e) {
      out.push({ attacker: "control", attempt: "legitimate payment inside the mandate", expected: "succeeds", outcome: `failed: ${why(e)}`, pass: false });
    }
  }

  // A. The agent's classical key leaked.
  out.push(await expectBlocked(ctx, "agent key", "pay more than the per-payment cap", "OverPerTxLimit", () => sim(agent.account, "spend", [token, okRecipient, lim.perTx + 1n])));
  out.push(await expectBlocked(ctx, "agent key", "pay an address that is not on the allowlist", "RecipientNotAllowed", () => sim(agent.account, "spend", [token, evil, 1n])));
  out.push(await expectBlocked(ctx, "agent key", "pay in a token the mandate does not cover", "TokenNotSpendable", () => sim(agent.account, "spend", ["0x000000000000000000000000000000000000dEaD", okRecipient, 1n])));
  {
    // Spend up to the daily cap with allowed payments, then one more must fail.
    let spent = (lim.perTx / 10n > 0n ? lim.perTx / 10n : lim.perTx);
    let guardCount = 0;
    while (spent + lim.perTx <= lim.daily && guardCount++ < 40) {
      const r = await send(agent, "spend", [token, okRecipient, lim.perTx]);
      if (!r.ok) break;
      spent += lim.perTx;
    }
    const left = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "remainingToday", args: [token] })) as bigint;
    out.push(await expectBlocked(ctx, "agent key", `keep paying after the daily cap (${left} left)`, "OverDailyLimit", () => sim(agent.account, "spend", [token, okRecipient, left + 1n])));
  }
  out.push(await expectBlocked(ctx, "agent key", "loosen the mandate with a forged post-quantum signature", "BadPqcSignature", () => sim(agent.account, "applyMandate", [wireMandate(greedy), toHex(new Uint8Array(32).fill(7))])));
  out.push(await expectBlocked(ctx, "agent key", "loosen the mandate with a signature for a different mandate", "BadPqcSignature", async () => {
    const msg = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(mandate), nonce] })) as Hex;
    return sim(agent.account, "applyMandate", [wireMandate(greedy), ctx.ownerPqc.sign(msg)]);
  }));
  if (ctx.otherGuard) {
    out.push(await expectBlocked(ctx, "agent key", "replay the owner's signature from a different guard", "BadPqcSignature", async () => {
      const msg = (await pub.readContract({ address: ctx.otherGuard!, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(mandate), nonce] })) as Hex;
      return sim(agent.account, "applyMandate", [wireMandate(mandate), ctx.ownerPqc.sign(msg)]);
    }));
  }

  // B. The owner's classical key leaked.
  out.push(await expectBlocked(ctx, "owner key", "spend directly", "NotAgent", () => sim(owner.account, "spend", [token, okRecipient, 1n])));
  out.push(await expectBlocked(ctx, "owner key", "grant itself a bigger mandate (no post-quantum signature)", "BadPqcSignature", () => sim(owner.account, "applyMandate", [wireMandate(greedy), toHex(new Uint8Array(32).fill(9))])));

  // Kill switch: the classical key may stop things. This one is expected to WORK.
  try {
    const f = await send(owner, "freeze", []);
    out.push({ attacker: "owner key", attempt: "freeze the guard (the kill switch)", expected: "allowed (it can only stop things)", outcome: f.ok ? "allowed" : "reverted", pass: f.ok, tx: f.hash });
    out.push(await expectBlocked(ctx, "agent key", "keep paying after the freeze", "IsFrozen", () => sim(agent.account, "spend", [token, okRecipient, 1n])));
    // An old, once-valid signature must not bring it back.
    const oldMsg = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(mandate), nonce - 1n >= 0n && nonce > 0n ? nonce - 1n : 0n] })) as Hex;
    out.push(await expectBlocked(ctx, "owner key", "unfreeze with an old signature", "BadPqcSignature", () => sim(owner.account, "applyMandate", [wireMandate(mandate), ctx.ownerPqc.sign(oldMsg)])));
  } catch (e) {
    out.push({ attacker: "owner key", attempt: "freeze the guard (the kill switch)", expected: "allowed", outcome: `failed: ${why(e)}`, pass: false });
  }

  // Expiry (needs a clock we can move: local chain only).
  if (ctx.warp) {
    // Re-arm with a fresh signed mandate (the owner's post-quantum key), then run past the expiry.
    const n2 = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "nonce" })) as bigint;
    const msg = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(mandate), n2] })) as Hex;
    await send(stranger, "applyMandate", [wireMandate(mandate), ctx.ownerPqc.sign(msg)]); // anyone may submit a signed mandate
    await ctx.warp(Math.max(0, mandate.expiry - Math.floor(Date.now() / 1000)) + 3600);
    out.push(await expectBlocked(ctx, "agent key", "keep paying after the mandate expired", "Expired", () => sim(agent.account, "spend", [token, okRecipient, 1n])));
  }
  return out;
}

export function render(results: Result[]): string {
  const w = Math.max(...results.map((r) => r.attempt.length));
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.attacker.padEnd(9)} ${r.attempt.padEnd(w)}  ${r.outcome}`);
  const pass = results.filter((r) => r.pass).length;
  return `${lines.join("\n")}\n\n${pass}/${results.length} as expected.${pass === results.length ? "" : " Some attempts behaved unexpectedly: see FAIL rows."}`;
}
