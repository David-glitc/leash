import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, describe, type TokenRegistry, type AdapterRegistry } from "./policy.ts";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ROUTER = "0x1111111111111111111111111111111111111111";
const WQOR = "0x2222222222222222222222222222222222222222";
const VAULT = "0x3333333333333333333333333333333333333333";
const REG: TokenRegistry = {
  FUSD: { address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA", decimals: 6 },
  FETH: { address: "0x02292293c13880a26242690eb70a0e42B8E91c28", decimals: 18 },
  WQOR: { address: WQOR, decimals: 18 },
  VFUSD: { address: VAULT, decimals: 6 },
};
const AD: AdapterRegistry = { univ2: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa", wrap: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", erc4626: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" };
const base = `agent ${AGENT} up to 100 FUSD a day, at most 40 FUSD per payment, up to 5 QOR a day`;
const run = (t: string, adapters: AdapterRegistry = AD) => compile(t, { now: 1_800_000_000, tokens: REG, adapters });
const codes = (r: ReturnType<typeof run>) => r.findings.map((f) => f.code);

test("a swap flow compiles to a route with the owner's rate floor in raw units", () => {
  const r = run(`${base}, swap FUSD for FETH on router ${ROUTER} at no worse than 0.0004 FETH per FUSD for 3 days`);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  const route = r.mandate!.routes[0]!;
  assert.equal(route.kind, "swap");
  assert.equal(route.target, ROUTER);
  // 0.0004 FETH (18 dec) per 1 FUSD (6 dec): raw out per raw in = 4e14 / 1e6 = 4e8, scaled by 1e18
  assert.equal(route.minOutPerInE18, 4n * 10n ** 26n);
  assert.equal(r.mandate!.recipients.length, 0, "flows alone need no payee allowlist");
});

test("the output token is listed receive-only, with zero caps", () => {
  const r = run(`${base}, swap FUSD for FETH on ${ROUTER} at no worse than 0.0004 FETH per FUSD for 3 days`);
  const i = r.mandate!.tokens.indexOf(REG.FETH!.address);
  assert.ok(i >= 0);
  assert.deepEqual(r.mandate!.limits[i], { perTx: 0n, daily: 0n });
  assert.ok(codes(r).includes("receive-only"));
});

test("a swap without a rate floor is refused: there is no oracle", () => {
  const r = run(`${base}, swap FUSD for FETH on ${ROUTER} for 3 days`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("flow-no-floor"));
});

test("a floor in the wrong units is refused", () => {
  const r = run(`${base}, swap FUSD for FETH on ${ROUTER} at no worse than 2000 FUSD per FETH for 3 days`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("flow-floor-units"));
});

test("the spent token needs a cap", () => {
  const r = run(`agent ${AGENT} up to 5 QOR a day, swap FUSD for FETH on ${ROUTER} at no worse than 0.0004 FETH per FUSD for 3 days`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("flow-uncapped"));
});

test("an unconfigured adapter is refused with the config key to set", () => {
  const r = run(`${base}, swap FUSD for FETH on ${ROUTER} at no worse than 0.0004 FETH per FUSD for 3 days`, {});
  assert.equal(r.ok, false);
  const e = r.findings.find((f) => f.code === "no-adapter")!;
  assert.match(e.message, /univ2/);
});

test("wrap and unwrap are fixed 1:1 flows", () => {
  const r = run(`${base}, up to 5 WQOR a day, wrap QOR into WQOR on ${WQOR}, unwrap WQOR to QOR on ${WQOR} for 2 hours`);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.mandate!.routes.map((x) => [x.kind, x.minOutPerInE18]), [["wrap", 10n ** 18n], ["unwrap", 10n ** 18n]]);
  assert.equal(r.mandate!.routes[0]!.adapter, AD.wrap);
});

test("vault deposit and redeem take floors", () => {
  const r = run(`${base}, up to 90 VFUSD a day, deposit FUSD into vault ${VAULT} as VFUSD at no worse than 0.99 VFUSD per FUSD, redeem VFUSD from vault ${VAULT} for FUSD at no worse than 0.99 FUSD per VFUSD for 1 day`);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.mandate!.routes.map((x) => x.kind), ["deposit", "redeem"]);
  assert.equal(r.mandate!.routes[0]!.minOutPerInE18, 99n * 10n ** 16n);
  assert.equal(r.mandate!.routes[0]!.adapter, AD.erc4626);
});

test("duplicate flows and unreadable flows are refused", () => {
  const dup = run(`${base}, swap FUSD for FETH on ${ROUTER} at no worse than 0.0004 FETH per FUSD, swap FUSD for FETH on ${ROUTER} at no worse than 0.0003 FETH per FUSD for 3 days`);
  assert.ok(codes(dup).includes("duplicate-flow"));
  const bad = run(`${base}, swap lots of money around for 3 days`);
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("flow-unreadable"));
});

test("flows add honest gaps, and the description lists them", () => {
  const r = run(`${base}, swap FUSD for FETH on ${ROUTER} at no worse than 0.0004 FETH per FUSD for 3 days`);
  for (const c of ["rate-floor-no-oracle", "target-trust", "native-amm"]) assert.ok(codes(r).includes(c), c);
  assert.match(describe(r.mandate!, REG), /flows: swap FUSD to FETH/);
});

test("without flows the compiler behaves as before: a payee allowlist is still required", () => {
  const r = run(`${base} for 3 days`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("no-recipients"));
});
