import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, NATIVE, MAX_WINDOW_BLOCKS, type TokenRegistry } from "./policy.ts";

const AGENT = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222";
const BOB = "0x3333333333333333333333333333333333333333";
const FUSD = "0x4444444444444444444444444444444444444444";
const GUARD = "0x5555555555555555555555555555555555555555";
const tokens: TokenRegistry = { FUSD: { address: FUSD as `0x${string}`, decimals: 18 } };
const now = 1_800_000_000;
const text = `agent ${AGENT} may spend up to 50 fUSD a day, at most 20 fUSD per payment, only to ${ALICE} and ${BOB}, for 3 days`;

test("compiles the headline sentence", () => {
  const r = compile(text, { now, tokens, guard: GUARD as `0x${string}` });
  assert.ok(r.ok, JSON.stringify(r.findings));
  const m = r.mandate!;
  assert.equal(m.expiry, now + 3 * 86400);
  assert.equal(m.tokens.length, 1);
  assert.equal(m.limits[0]!.daily, 50n * 10n ** 18n);
  assert.equal(m.limits[0]!.perTx, 20n * 10n ** 18n);
  assert.equal(m.recipients.length, 2);
});

test("per-payment phrase is not misread as a daily cap", () => {
  const r = compile(`agent ${AGENT} at most 20 fUSD per payment, 50 fUSD a day, only to ${ALICE}, for 1 day`, { now, tokens });
  assert.equal(r.mandate!.limits[0]!.perTx, 20n * 10n ** 18n);
  assert.equal(r.mandate!.limits[0]!.daily, 50n * 10n ** 18n);
});

test("native QOR and a token together", () => {
  const r = compile(`agent ${AGENT} up to 3 QOR a day, at most 1 QOR per payment, 50 fUSD a day, only to ${ALICE}, for 2 days`, { now, tokens });
  assert.ok(r.ok);
  assert.equal(r.mandate!.tokens.length, 2);
  assert.ok(r.mandate!.tokens.includes(NATIVE));
});

test("refuses an empty allowlist and a missing agent", () => {
  const a = compile(`agent ${AGENT} may spend 5 QOR a day for 1 day`, { now });
  assert.ok(!a.ok);
  assert.ok(a.findings.some((x) => x.code === "no-recipients"));
  const b = compile(`spend 5 QOR a day only to ${ALICE} for 1 day`, { now });
  assert.ok(b.findings.some((x) => x.code === "no-agent"));
});

test("refuses unknown tokens instead of guessing", () => {
  const r = compile(`agent ${AGENT} 5 DOGE a day only to ${ALICE} for 1 day`, { now });
  assert.ok(!r.ok);
  assert.ok(r.findings.some((x) => x.code === "unknown-token"));
});

test("refuses a per-payment cap above the daily cap", () => {
  const r = compile(`agent ${AGENT} 5 QOR a day, at most 9 QOR per payment, only to ${ALICE} for 1 day`, { now });
  assert.ok(r.findings.some((x) => x.code === "per-tx-over-daily"));
  assert.ok(!r.ok);
});

test("defaults are loud, not silent", () => {
  const r = compile(`agent ${AGENT} 5 QOR a day only to ${ALICE}`, { now });
  assert.ok(r.ok);
  const codes = r.findings.map((x) => x.code);
  assert.ok(codes.includes("expiry-defaulted"));
  assert.ok(codes.includes("per-tx-defaulted"));
});

test("reports the gaps the chain cannot close, always", () => {
  const r = compile(text, { now, tokens });
  const gaps = r.findings.filter((x) => x.severity === "gap").map((x) => x.code);
  for (const g of ["outside-guard", "token-limits-need-guard", "fixed-bucket"]) assert.ok(gaps.includes(g), g);
});

test("a 3-day mandate needs window renewals because the chain caps a window", () => {
  const r = compile(text, { now, tokens, guard: GUARD as `0x${string}` });
  assert.equal(r.plan!.window.blocks, MAX_WINDOW_BLOCKS);
  assert.ok(r.plan!.window.renewals >= 10);
  assert.ok(r.findings.some((x) => x.code === "window-renewals"));
  assert.deepEqual(r.plan!.window.allowedTargets, [GUARD]);
});

test("a short mandate fits in one window", () => {
  const r = compile(`agent ${AGENT} 5 QOR a day only to ${ALICE} for 2 hours`, { now });
  assert.equal(r.plan!.window.renewals, 0);
});
