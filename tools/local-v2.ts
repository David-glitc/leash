/**
 * local-v2.ts - LeashGuardV2 end to end on a local Anvil node (precompiles stubbed, no wallet needed).
 * 1. The owner describes the value flows in plain English; the compiler turns them into a mandate with routes.
 * 2. A second guard is driven through every adapter with the TypeScript action builders: wrap, unwrap, deposit, redeem, swap.
 * 3. The Q-Day drill for actions plays a leaked agent key and a leaked owner key against the guard.
 *
 *   pnpm demo:local:v2
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatUnits, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compile } from "./policy.ts";
import { mockSigner, render } from "./attack.ts";
import { runSuiteV2 } from "./attack-v2.ts";
import { guardV2Abi, wireMandateV2 } from "./wire.ts";
import { swap, wrap, unwrap, vaultDeposit, vaultRedeem, floorOut, NATIVE } from "./actions.ts";

const PORT = 8601;
const RPC = `http://127.0.0.1:${PORT}`;
// Public Anvil development keys. Local use only. Never fund these on a real network.
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  stranger: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;
const art = (p: string) => JSON.parse(readFileSync(new URL(`../out/${p}`, import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const wallet = (k: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) });
    const owner = wallet(KEYS.owner), agent = wallet(KEYS.agent), stranger = wallet(KEYS.stranger);
    const mockCode = art("LeashGuard.t.sol/MockPqc.json").deployedBytecode.object as Hex;
    for (const a of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
      await rpc("anvil_setCode", [a, mockCode]);
      await rpc("anvil_setStorageAt", [a, "0x0", "0x0000000000000000000000000000000000000000000000000000000000000101"]);
    }
    const deploy = async (file: string, name: string, args: unknown[] = [], value = 0n) => {
      const a = art(`${file}.sol/${name}.json`);
      const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, value, account: owner.account!, gas: 6_000_000n });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
    };
    const call = async (to: Address, abiName: string, fn: string, args: unknown[]) => {
      const a = art(`Mocks.sol/${abiName}.json`);
      const hash = await owner.writeContract({ address: to, abi: a.abi, functionName: fn, args, chain, account: owner.account! } as never);
      await pub.waitForTransactionReceipt({ hash });
    };

    // Tokens, routers, vault, adapters.
    const usd = await deploy("Mocks", "MockERC20"), ethx = await deploy("Mocks", "MockERC20"), wqor = await deploy("Mocks", "MockWETH");
    const router = await deploy("Mocks", "MockRouterV2", [wqor], parseEther("50"));
    const shortRouter = await deploy("Mocks", "MockRouterV2", [wqor]);
    const unlisted = await deploy("Mocks", "MockRouterV2", [wqor]);
    const vault = await deploy("Mocks", "MockVault", [usd]);
    const adapters = { univ2: await deploy("UniV2Adapter", "UniV2Adapter"), wrap: await deploy("WrapAdapter", "WrapAdapter"), erc4626: await deploy("Erc4626Adapter", "Erc4626Adapter") };
    for (const r of [router, shortRouter, unlisted]) {
      await call(r, "MockRouterV2", "setRate", [usd, ethx, parseEther("0.0005")]);
    }
    await call(shortRouter, "MockRouterV2", "setBehaviour", [NATIVE, 500n]); // under-delivers by 5 percent
    const tokens = { USD: { address: usd, decimals: 18 }, ETHX: { address: ethx, decimals: 18 }, WQOR: { address: wqor, decimals: 18 }, VUSD: { address: vault, decimals: 18 } };
    const block = await pub.getBlock();
    const now = Number(block.timestamp);
    const own = owner.account!.address, ag = agent.account!.address;

    const arm = async (guard: Address, sentence: string) => {
      const c = compile(sentence, { now, tokens, adapters, guard });
      if (!c.ok || !c.mandate) throw new Error(json(c.findings));
      const msg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(c.mandate), 0n] })) as Hex;
      const h = await stranger.writeContract({ address: guard, abi: guardV2Abi, functionName: "applyMandate", args: [wireMandateV2(c.mandate), mockSigner.sign(msg)], chain, account: stranger.account!, gas: 3_000_000n });
      await pub.waitForTransactionReceipt({ hash: h });
      return c;
    };
    const fund = async (guard: Address, native: string, tokenMints: [Address, string][]) => {
      await owner.sendTransaction({ to: guard, value: parseEther(native), chain, account: owner.account! });
      for (const [t, v] of tokenMints) await call(t, "MockERC20", "mint", [guard, parseEther(v)]);
    };

    // 1. Flows in plain English: the drill guard.
    const guard = await deploy("LeashGuardV2", "LeashGuardV2", [own]);
    const otherGuard = await deploy("LeashGuardV2", "LeashGuardV2", [own]);
    await fund(guard, "10", [[usd, "1000"]]);
    const sentence = `agent ${ag} up to 100 USD a day, at most 40 USD per payment, swap USD for ETHX on router ${router} at no worse than 0.00049 ETHX per USD, swap USD for ETHX on ${shortRouter} at no worse than 0.00049 ETHX per USD for 3 days`;
    console.log(`Leash: ${sentence}\n`);
    const compiled = await arm(guard, sentence);
    for (const f of compiled.findings.filter((x) => x.severity !== "gap")) console.log(`  [${f.severity}] ${f.message}`);

    // 2. A tour through every adapter with the TypeScript builders, on a second guard.
    const tour = await deploy("LeashGuardV2", "LeashGuardV2", [own]);
    await fund(tour, "20", [[usd, "500"]]);
    const tourSentence = `agent ${ag} up to 100 USD a day, up to 10 QOR a day, up to 10 WQOR a day, up to 100 VUSD a day, `
      + `wrap QOR into WQOR on ${wqor}, unwrap WQOR to QOR on ${wqor}, deposit USD into vault ${vault} as VUSD at no worse than 0.99 VUSD per USD, redeem VUSD from vault ${vault} for USD at no worse than 0.99 USD per VUSD, `
      + `swap USD for ETHX on ${router} at no worse than 0.00049 ETHX per USD for 1 day`;
    const tc = await arm(tour, tourSentence);
    const sym = (a: Address) => Object.entries(tokens).find(([, t]) => t.address.toLowerCase() === a.toLowerCase())?.[0] ?? (a === NATIVE ? "QOR" : a);
    const dec = (a: Address, v: bigint) => `${formatUnits(v, 18)} ${sym(a)}`;
    const common = { guard: tour, adapters, amountIn: parseEther("5") };
    const steps = [
      wrap({ ...common, target: wqor }), unwrap({ ...common, target: wqor, amountIn: parseEther("2") }),
      vaultDeposit({ ...common, target: vault, asset: usd, amountIn: parseEther("40") }), vaultRedeem({ ...common, target: vault, asset: usd, amountIn: parseEther("10") }),
      swap({ ...common, target: router, tokenIn: usd, tokenOut: ethx, amountIn: parseEther("40"), minOut: floorOut(parseEther("40"), tc.mandate!.routes.find((r) => r.kind === "swap")!.minOutPerInE18) }),
    ];
    console.log("\nAdapter tour (second guard, TypeScript action builders):");
    const tourLog: unknown[] = [];
    for (const a of steps) {
      const h = await agent.writeContract({ address: tour, abi: guardV2Abi, functionName: "execute", args: [a.adapter, a.target, a.data, a.value], chain, account: agent.account!, gas: 2_000_000n });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const ev = r.logs.length;
      console.log(`  ${r.status === "success" ? "ok  " : "FAIL"} ${a.kind.padEnd(8)} ${dec(a.tokenIn, a.amountIn)} (${ev} logs)`);
      tourLog.push({ kind: a.kind, ok: r.status === "success", tx: h });
      if (r.status !== "success") process.exitCode = 1;
    }

    // 3. The drill.
    console.log("\nMandate applied on chain. Running the Q-Day drill for guarded actions...\n");
    const swapRoute = compiled.mandate!.routes.find((r) => r.target.toLowerCase() === router.toLowerCase())!;
    const results = await runSuiteV2({
      chain, pub, guard, agent: agent as never, owner: owner as never, stranger: stranger as never, ownerPqc: mockSigner, mandate: compiled.mandate!,
      swapAdapter: adapters.univ2, router, tokenIn: swapRoute.tokenIn, tokenOut: swapRoute.tokenOut, unlistedRouter: unlisted, shortRouter, otherGuard,
      warp: async (s) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); },
    });
    const report = render(results);
    console.log(report);
    mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../reports/local-v2-drill.json", import.meta.url), json({ sentence, tourSentence, guard, tour: tourLog, results }));
    if (results.some((r) => !r.pass)) process.exitCode = 1;
  } finally {
    anvil.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
