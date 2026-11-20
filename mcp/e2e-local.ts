/**
 * End to end on a local node: an MCP client drives the Leash server through a LeashGuardV2 (swap, wrap, vault,
 * refusals, monitor, freeze). Precompiles are stubbed and the keys are public Anvil keys. Nothing leaves this machine.
 *   pnpm mcp:e2e
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compile } from "../tools/policy.ts";
import { mockSigner } from "../tools/attack.ts";
import { guardV2Abi, wireMandateV2 } from "../tools/wire.ts";

const PORT = 8603, RPC = `http://127.0.0.1:${PORT}`;
const OWNER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", AGENT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const art = (p: string) => JSON.parse(readFileSync(new URL(`../out/${p}`, import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
let failures = 0;
const check = (name: string, pass: boolean, detail = "") => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); if (!pass) failures++; };
try {
  for (let i = 0; i < 50; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const owner = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(OWNER) });
  const mockCode = art("LeashGuard.t.sol/MockPqc.json").deployedBytecode.object as Hex;
  for (const a of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
    await rpc("anvil_setCode", [a, mockCode]);
    await rpc("anvil_setStorageAt", [a, "0x0", "0x0000000000000000000000000000000000000000000000000000000000000101"]);
  }
  const deploy = async (file: string, name: string, args: unknown[] = [], value = 0n) => {
    const a = art(`${file}.sol/${name}.json`);
    return (await pub.waitForTransactionReceipt({ hash: await owner.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, value, account: owner.account!, gas: 6_000_000n }) })).contractAddress as Address;
  };
  const w = async (to: Address, abi: unknown, fn: string, args: unknown[]) => pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: to, abi, functionName: fn, args, chain, account: owner.account! } as never) });
  const erc = art("Mocks.sol/MockERC20.json").abi, rt = art("Mocks.sol/MockRouterV2.json").abi;
  const usd = await deploy("Mocks", "MockERC20"), ethx = await deploy("Mocks", "MockERC20"), wqor = await deploy("Mocks", "MockWETH");
  const router = await deploy("Mocks", "MockRouterV2", [wqor], parseEther("50")), vault = await deploy("Mocks", "MockVault", [usd]);
  const adapters = { univ2: await deploy("UniV2Adapter", "UniV2Adapter"), wrap: await deploy("WrapAdapter", "WrapAdapter"), erc4626: await deploy("Erc4626Adapter", "Erc4626Adapter") };
  await w(router, rt, "setRate", [usd, ethx, parseEther("0.0005")]);
  await w(router, rt, "setRate", [wqor, usd, parseEther("2000")]);
  const own = owner.account!.address, ag = privateKeyToAccount(AGENT).address;
  const guard = await deploy("LeashGuardV2", "LeashGuardV2", [own], parseEther("20"));
  await w(usd, erc, "mint", [guard, parseEther("1000")]);
  const tokens = { USD: { address: usd, decimals: 18 }, ETHX: { address: ethx, decimals: 18 }, WQOR: { address: wqor, decimals: 18 }, VUSD: { address: vault, decimals: 18 } };
  const sentence = `agent ${ag} up to 100 USD a day, at most 40 USD per payment, up to 5 QOR a day, up to 5 WQOR a day, up to 50 VUSD a day, `
    + `swap USD for ETHX on ${router} at no worse than 0.00049 ETHX per USD, swap QOR for USD on ${router} at no worse than 1900 USD per QOR, `
    + `wrap QOR into WQOR on ${wqor}, unwrap WQOR to QOR on ${wqor}, deposit USD into vault ${vault} as VUSD at no worse than 0.99 VUSD per USD for 1 day`;
  const c = compile(sentence, { now: Number((await pub.getBlock()).timestamp), tokens, adapters, guard });
  if (!c.ok || !c.mandate) throw new Error(JSON.stringify(c.findings));
  const msg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(c.mandate), 0n] })) as Hex;
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: guard, abi: guardV2Abi, functionName: "applyMandate", args: [wireMandateV2(c.mandate), mockSigner.sign(msg)], chain, account: owner.account!, gas: 3_000_000n }) });

  const client = new Client({ name: "leash-e2e", version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "mcp/server.ts"],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LEASH_GUARD: guard, LEASH_RPC: RPC, LEASH_CHAIN_ID: "31337", LEASH_AGENT_KEY: AGENT, LEASH_TOKENS: JSON.stringify(tokens), LEASH_ADAPTERS: JSON.stringify(adapters) },
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const t = r.content?.[0]?.text as string;
    let v: any = t; try { v = JSON.parse(t); } catch { /* text */ }
    return { err: !!r.isError, v };
  };
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["leash_routes", "leash_swap", "leash_wrap", "leash_unwrap", "leash_vault_deposit", "leash_vault_redeem", "leash_execute", "leash_monitor"]) check(`tool listed: ${n}`, names.includes(n));

  const status = (await call("leash_status")).v;
  check("status reports a v2 guard with routes", status.version === 2 && status.routes.length === 5, `${status.routes?.length} routes`);
  const routes = (await call("leash_routes")).v;
  check("routes show human rate floors", routes.some((r: any) => r.kind === "swap" && r.from === "USD" && r.to === "ETHX"), JSON.stringify(routes[0]));

  let r = (await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "20" })).v;
  check("swap simulates first and shows the expected output", r.allowed === true && r.sent === false, r.expectedReceive);
  r = (await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "20", confirm: true })).v;
  check("swap sends and the guard receives ETHX", r.sent === true && /0\.01 ETHX/.test(r.received ?? ""), `${r.received}`);
  r = (await call("leash_swap", { tokenIn: "QOR", tokenOut: "USD", amount: "1", confirm: true })).v;
  check("native swap (QOR to USD) works through the wrapped-native path", r.sent === true && /2000 USD/.test(r.received ?? ""), `${r.received}`);
  r = (await call("leash_wrap", { amount: "2", confirm: true })).v;
  check("wrap", r.sent === true, r.received);
  r = (await call("leash_unwrap", { amount: "1", confirm: true })).v;
  check("unwrap", r.sent === true, r.received);
  r = (await call("leash_vault_deposit", { vault, amount: "30", confirm: true })).v;
  check("vault deposit", r.sent === true, r.received);

  r = (await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "41" })).v;
  check("a swap over the per-action cap is refused with the guard's own error", r.refusedBy === "OverPerTxLimit", r.refusedBy);
  r = (await call("leash_swap", { tokenIn: "ETHX", tokenOut: "USD", amount: "1" })).err;
  check("a pair with no route is refused before anything is sent", r === true);
  r = (await call("leash_vault_redeem", { vault, amount: "10", confirm: true })).err;
  check("a redeem the owner did not allow has no route", r === true);
  r = (await call("leash_execute", { adapter: adapters.univ2, target: router, data: "0xdeadbeef", value: "0", confirm: true })).v;
  check("raw call data the adapter cannot decode is refused", r.refusedBy === "BadAction", r.refusedBy);

  const mon = (await call("leash_monitor")).v;
  check("monitor reads the recent actions", mon.recentActions >= 5 && Array.isArray(mon.alerts), `${mon.recentActions} actions, ${mon.alerts.length} alert(s)`);
  r = (await call("leash_freeze", { confirm: true })).v;
  check("the agent can freeze itself", r.frozen === true);
  r = (await call("leash_swap", { tokenIn: "USD", tokenOut: "ETHX", amount: "1" })).v;
  check("after the freeze every action is refused", r.refusedBy === "IsFrozen", r.refusedBy);
  const lp = (await call("leash_loosen_prepare", { sentence: sentence.replace("up to 100 USD a day", "up to 900 USD a day").replace("at most 40 USD", "at most 90 USD") })).v;
  check("loosen_prepare hands the owner a v2 message to sign (nonce 1)", lp.ready === true && lp.nonce === "1", `${(lp.messageToSign.length - 2) / 2} bytes`);
  await client.close();
  mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
