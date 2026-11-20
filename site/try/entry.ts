// Browser entry: the same deterministic compiler the CLI and the MCP server use, exposed to the Try-it page.
import { getAddress } from "viem";
import { compile, describe, DEFAULT_TOKENS } from "../../tools/policy.ts";

const norm = (t?: Record<string, { address: string; decimals: number }>) => Object.fromEntries(Object.entries(t ?? {}).map(([k, v]) => [k, { address: getAddress(v.address), decimals: v.decimals }]));

const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
(window as unknown as { LeashCore: unknown }).LeashCore = {
  compile(text: string, opts: { tokens?: Record<string, { address: string; decimals: number }>; adapters?: Record<string, string>; guard?: string }) {
    const tokens = norm(opts.tokens);
    const r = compile(text, { now: Math.floor(Date.now() / 1000), tokens: tokens as never, adapters: opts.adapters as never, guard: opts.guard as never });
    const reg = { ...DEFAULT_TOKENS, ...tokens } as never;
    return { ok: r.ok, summary: r.ok && r.mandate ? describe(r.mandate, reg) : null, findings: r.findings, plan: r.plan ?? null, mandate: r.mandate ? JSON.parse(ser(r.mandate)) : null };
  },
};
