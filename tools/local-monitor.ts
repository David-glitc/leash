/**
 * local-monitor.ts - the monitor catching two bad days on a local node, and freezing the guard with a stop-only key.
 *   1. A burst: the agent key fires swaps in a loop.
 *   2. An exploit the contract's own events do not explain: the guard's balance drops with no Spent or Executed event.
 * The watcher holds only the owner's CLASSICAL key. It can freeze; it cannot loosen anything.
 *
 *   pnpm demo:monitor
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compile } from "./policy.ts";
import { mockSigner } from "./attack.ts";
import { guardV2Abi, wireMandateV2 } from "./wire.ts";
import { swap, floorOut } from "./actions.ts";
import { tick, freezerFor, DEFAULT_CONFIG, type Snapshot } from "./monitor.ts";

const PORT = 8602;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
} as const; // public Anvil keys, local only
const art = (p: string) => JSON.parse(readFileSync(new URL(`../out/${p}`, import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function main() {
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const transcript: string[] = [];
  const log = (s: string) => { console.log(s); transcript.push(s); };
  try {
    for (let i = 0; i < 50; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const wallet = (k: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) });
    const owner = wallet(KEYS.owner), agent = wallet(KEYS.agent);
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
    const mocks = art("Mocks.sol/MockERC20.json"), rt = art("Mocks.sol/MockRouterV2.json");
    const usd = await deploy("Mocks", "MockERC20"), ethx = await deploy("Mocks", "MockERC20"), wqor = await deploy("Mocks", "MockWETH");
    const router = await deploy("Mocks", "MockRouterV2", [wqor]);
    const swapAd = await deploy("UniV2Adapter", "UniV2Adapter");
    await owner.writeContract({ address: router, abi: rt.abi, functionName: "setRate", args: [usd, ethx, parseEther("0.0005")], chain, account: owner.account! } as never);
    const own = owner.account!.address, ag = agent.account!.address;
    const guard = await deploy("LeashGuardV2", "LeashGuardV2", [own], parseEther("10"));
    await owner.writeContract({ address: usd, abi: mocks.abi, functionName: "mint", args: [guard, parseEther("1000")], chain, account: owner.account! } as never);
    const tokens = { USD: { address: usd, decimals: 18 }, ETHX: { address: ethx, decimals: 18 } };
    const now = Number((await pub.getBlock()).timestamp);
    const sentence = `agent ${ag} up to 200 USD a day, at most 10 USD per payment, swap USD for ETHX on router ${router} at no worse than 0.00049 ETHX per USD for 1 day`;
    const arm = async (nonce: bigint) => {
      const c = compile(sentence, { now, tokens, adapters: { univ2: swapAd }, guard });
      if (!c.ok || !c.mandate) throw new Error(JSON.stringify(c.findings));
      const msg = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(c.mandate), nonce] })) as Hex;
      await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: guard, abi: guardV2Abi, functionName: "applyMandate", args: [wireMandateV2(c.mandate), mockSigner.sign(msg)], chain, account: owner.account!, gas: 3_000_000n }) });
      return c.mandate;
    };
    const mandate = await arm(0n);
    const route = mandate.routes[0]!;
    const doSwap = (usdAmount: string) => {
      const a = swap({ guard, adapters: { univ2: swapAd }, target: router, tokenIn: usd, tokenOut: ethx, amountIn: parseEther(usdAmount), minOut: floorOut(parseEther(usdAmount), route.minOutPerInE18) });
      return agent.writeContract({ address: guard, abi: guardV2Abi, functionName: "execute", args: [a.adapter, a.target, a.data, a.value], chain, account: agent.account!, gas: 2_000_000n });
    };
    // The watcher: owner's CLASSICAL key, freeze only.
    const w = { pub, guard, tokens, cfg: { ...DEFAULT_CONFIG }, freezer: freezerFor(pub, guard, KEYS.owner, chain, RPC), log: (l: string) => log(`  alert  ${l.replace(/"at":"[^"]*",/, "").replace(/"guard":"[^"]*",/, "")}`) };
    let prev: Snapshot | undefined = (await tick(w)).snap;
    log("Watcher armed (owner's classical key, freeze only). Baseline taken.\n");

    log("Day 1: the agent does one normal swap.");
    await pub.waitForTransactionReceipt({ hash: await doSwap("5") });
    let r = await tick(w, prev); prev = r.snap;
    log(`  -> ${r.alerts.length ? r.alerts.length + " alert(s)" : "no alerts (the swap is fully explained by the guard's own events)"}\n`);

    log("Day 1, later: a leaked agent key fires swaps in a loop.");
    for (let i = 0; i < 6; i++) await pub.waitForTransactionReceipt({ hash: await doSwap("1") });
    r = await tick(w, prev); prev = r.snap;
    const frozen1 = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "frozen" })) as boolean;
    log(`  -> guard frozen by the watcher: ${frozen1}\n`);
    let blocked = "NOT BLOCKED";
    try { await pub.simulateContract({ address: guard, abi: guardV2Abi, functionName: "execute", account: agent.account!, args: [swapAd, router, "0x", 0n] }); } catch (e) { blocked = (e as { walk?: (f: (x: unknown) => boolean) => { data?: { errorName?: string } } }).walk?.((x) => (x as { data?: unknown })?.data !== undefined)?.data?.errorName ?? "reverted"; }
    log(`  -> the agent's next call: ${blocked}\n`);

    log("The owner reviews, then signs a fresh mandate with the post-quantum key (stubbed here). Guard re-armed.");
    await arm(1n);
    prev = (await tick(w)).snap;

    log("\nDay 2: an exploit the contract's events do not explain. 4 QOR leave the guard with no Spent or Executed event.");
    const bal = await pub.getBalance({ address: guard });
    await rpc("anvil_setBalance", [guard, toHex(bal - parseEther("4"))]);
    await rpc("evm_mine", []);
    r = await tick(w, prev); prev = r.snap;
    const frozen2 = (await pub.readContract({ address: guard, abi: guardV2Abi, functionName: "frozen" })) as boolean;
    log(`  -> guard frozen by the watcher: ${frozen2}`);
    mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../reports/local-monitor.json", import.meta.url), JSON.stringify({ sentence, scenarios: [{ name: "burst of agent swaps", frozenByWatcher: frozen1 }, { name: "unexplained outflow", frozenByWatcher: frozen2 }], transcript }, null, 2));
    if (!frozen1 || !frozen2) process.exitCode = 1;
  } finally {
    anvil.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
