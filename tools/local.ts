/**
 * local.ts - run the whole Leash flow on a local Anvil node, no wallet or testnet needed.
 *
 * The QoreChain precompiles do not exist on Anvil, so they are stubbed (same stub as the Foundry tests).
 * The point is to run the identical attack suite you will point at the real testnet.
 *
 *   pnpm demo:local
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compile } from "./policy.ts";
import { runSuite, render, mockSigner, guardAbi, wireMandate } from "./attack.ts";

const PORT = 8599;
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

async function main() {
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const wallet = (k: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) });
    const owner = wallet(KEYS.owner), agent = wallet(KEYS.agent), stranger = wallet(KEYS.stranger);

    // Stub the two precompiles with the test mock, registered and proven.
    const mockCode = art("LeashGuard.t.sol/MockPqc.json").deployedBytecode.object as Hex;
    for (const a of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
      await rpc("anvil_setCode", [a, mockCode]);
      await rpc("anvil_setStorageAt", [a, "0x0", "0x0000000000000000000000000000000000000000000000000000000000000101"]);
    }

    const deploy = async (name: string, file: string, args: unknown[] = [], value = 0n) => {
      const a = art(`${file}/${name}.json`);
      const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, value, account: owner.account! });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
    };
    const fusd = await deploy("MockToken", "LeashGuard.t.sol");
    const guard = await deploy("LeashGuard", "LeashGuard.sol", [owner.account!.address]);
    const otherGuard = await deploy("LeashGuard", "LeashGuard.sol", [owner.account!.address]);
    const mint = await owner.writeContract({ address: fusd, abi: art("LeashGuard.t.sol/MockToken.json").abi, functionName: "mint", args: [guard, parseEther("1000")], chain, account: owner.account! });
    await pub.waitForTransactionReceipt({ hash: mint });

    // The plain-English leash. Same compiler as `pnpm compile`.
    const sentence = `agent ${agent.account!.address} may spend up to 50 FUSD a day, at most 20 FUSD per payment, only to ${stranger.account!.address.replace(/./, (c) => c)} for 3 days`;
    // The recipient must be someone other than the attacker; use a fresh address.
    const recipient = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6").address;
    const text = sentence.replace(stranger.account!.address, recipient);
    const block = await pub.getBlock();
    const compiled = compile(text, { now: Number(block.timestamp), tokens: { FUSD: { address: fusd, decimals: 18 } }, guard });
    if (!compiled.ok || !compiled.mandate) throw new Error(JSON.stringify(compiled.findings));
    console.log(`Leash: ${text}\n`);
    for (const f of compiled.findings) console.log(`  [${f.severity}] ${f.message}`);

    // The owner signs with the post-quantum key (stubbed locally); anyone may submit.
    const m = compiled.mandate;
    const msg = (await pub.readContract({ address: guard, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(m), 0n] })) as Hex;
    const apply = await stranger.writeContract({ address: guard, abi: guardAbi, functionName: "applyMandate", args: [wireMandate(m), mockSigner.sign(msg)], chain, account: stranger.account!, gas: 2_000_000n });
    await pub.waitForTransactionReceipt({ hash: apply });
    console.log("\nMandate applied on chain. Running the Q-Day drill against it...\n");

    const results = await runSuite({
      chain, pub, guard, agent: agent as never, owner: owner as never, stranger: stranger as never, ownerPqc: mockSigner, mandate: m, otherGuard,
      warp: async (s) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); },
    });
    const report = render(results);
    console.log(report);
    mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../reports/local-drill.json", import.meta.url), JSON.stringify({ sentence: text, guard, results }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    if (results.some((r) => !r.pass)) process.exitCode = 1;
  } finally {
    anvil.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
