import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, DEFAULT_CONFIG, type Snapshot, type GuardEvent } from "./monitor.ts";

const USD = "0x00000000000000000000000000000000000000a1" as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  block: 100n, timestamp: 1_000_000, frozen: false, nonce: 1n, expiry: 1_000_000 + 86_400, agent: AGENT, tokens: [NATIVE, USD],
  balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 1000n }, daily: { [NATIVE]: 3n * 10n ** 18n, [USD]: 300n }, remaining: { [NATIVE]: 3n * 10n ** 18n, [USD]: 300n }, ...o,
});
const codes = (a: { code: string }[]) => a.map((x) => x.code);
const spent = (amount: bigint, ts: number): GuardEvent => ({ kind: "spent", token: USD, amount, block: 101n, ts });

test("a quiet guard raises nothing", () => {
  assert.deepEqual(evaluate(snap(), snap({ block: 101n, timestamp: 1_000_015 }), []), []);
});

test("frozen and expired are reported", () => {
  assert.ok(codes(evaluate(undefined, snap({ frozen: true }), [])).includes("frozen"));
  assert.ok(codes(evaluate(undefined, snap({ expiry: 999_999 }), [])).includes("expired"));
  assert.ok(codes(evaluate(undefined, snap({ expiry: 1_000_000 + 1800 }), [])).includes("expiring-soon"));
});

test("a payment the events explain is not an outflow", () => {
  const prev = snap();
  const cur = snap({ block: 101n, timestamp: 1_000_010, balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 950n }, remaining: { [NATIVE]: 3n * 10n ** 18n, [USD]: 250n } });
  assert.ok(!codes(evaluate(prev, cur, [spent(50n, 1_000_005)])).includes("unexplained-outflow"));
});

test("a balance that falls with no event is a critical alert that asks for a freeze", () => {
  const prev = snap();
  const cur = snap({ block: 101n, balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 400n } });
  const a = evaluate(prev, cur, []);
  const hit = a.find((x) => x.code === "unexplained-outflow")!;
  assert.equal(hit.severity, "crit");
  assert.equal(hit.freeze, true);
});

test("a swap is explained by its input and output together", () => {
  const prev = snap();
  const cur = snap({ block: 101n, balances: { [NATIVE]: 11n * 10n ** 18n, [USD]: 960n } });
  const ev: GuardEvent = { kind: "executed", tokenIn: USD, amountIn: 40n, tokenOut: NATIVE, received: 10n ** 18n, block: 101n, ts: 1_000_005 };
  assert.ok(!codes(evaluate(prev, cur, [ev])).includes("unexplained-outflow"));
});

test("a native deposit raises the balance without alarm", () => {
  const cur = snap({ block: 101n, balances: { [NATIVE]: 12n * 10n ** 18n, [USD]: 1000n } });
  assert.deepEqual(evaluate(snap(), cur, [{ kind: "deposited", amount: 2n * 10n ** 18n, block: 101n, ts: 1_000_005 }]), []);
});

test("a burst of actions is critical and asks for a freeze", () => {
  const ev = Array.from({ length: 6 }, (_, i) => spent(1n, 1_000_000 + i * 5));
  const a = evaluate(snap(), snap({ block: 102n, balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 994n } }), ev);
  const hit = a.find((x) => x.code === "burst")!;
  assert.equal(hit.severity, "crit");
  assert.equal(hit.freeze, true);
  const spaced = Array.from({ length: 6 }, (_, i) => spent(1n, 1_000_000 + i * 600));
  assert.ok(!codes(evaluate(snap(), snap({ block: 102n, balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 994n } }), spaced)).includes("burst"));
});

test("daily burn warns at 80 percent and a single large action is flagged", () => {
  const cur = snap({ remaining: { [NATIVE]: 3n * 10n ** 18n, [USD]: 50n } }); // 250 of 300 used
  assert.ok(codes(evaluate(snap(), cur, [])).includes("daily-burn"));
  const big = evaluate(snap(), snap({ block: 101n, balances: { [NATIVE]: 10n * 10n ** 18n, [USD]: 840n } }), [spent(160n, 1_000_005)]);
  assert.ok(codes(big).includes("large-action"));
});

test("a changed mandate or agent is reported", () => {
  const a = evaluate(snap(), snap({ block: 101n, nonce: 2n, agent: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }), []);
  assert.deepEqual(codes(a).sort(), ["agent-changed", "mandate-changed"]);
});
