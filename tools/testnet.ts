/**
 * testnet.ts - run Leash on the real QoreChain testnet (qorechain-diana).
 *
 *   pnpm testnet status     balances, post-quantum keys and windows for owner and agent
 *   pnpm testnet register   register both accounts' ML-DSA-87 keys (once each)
 *   pnpm testnet all        open windows, deploy, apply a signed mandate, run the Q-Day drill, write a report
 *
 * Accounts come from .env (`pnpm accounts`). Throwaway testnet keys only.
 * Flow follows the organisers' qday-vault sample: register, open a hybrid-signed EVM window, then send EVM txs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, getNetwork, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus, openEvmWindowMsg,
  signProofOfPossession, pqcSign, type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { createPublicClient, createWalletClient, defineChain, http, hexToBytes, toHex, formatEther, type Address, type Hex } from "viem";
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "./policy.ts";
import { runSuite, render, guardAbi, wireMandate, type PqcSigner } from "./attack.ts";

for (const l of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}
const net = getNetwork("testnet");
const REST = process.env.QORE_REST_URL?.trim() || net.endpoints.rest;
const RPC = process.env.QORE_RPC_URL?.trim() || net.endpoints.rpc;
const EVM_RPC = "https://evm-testnet.qore.host";
const chain = defineChain({ id: 9800, name: "QoreChain Testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [EVM_RPC] } } });
const pub = createPublicClient({ chain, transport: http(EVM_RPC) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const FEES = { maxFeePerGas: 250_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

type Role = "owner" | "agent";
async function acct(role: Role) {
  const mnemonic = process.env[`${role.toUpperCase()}_MNEMONIC`];
  if (!mnemonic) throw new Error(`${role.toUpperCase()}_MNEMONIC missing in .env: run pnpm accounts`);
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  const evm = mnemonicToAccount(mnemonic); // m/44'/60'/0'/0/0, the same key as the unified account
  if (evm.address.toLowerCase() !== unified.evm.toLowerCase()) throw new Error(`${role}: viem and SDK derive different EVM addresses`);
  return { role, unified, evm, wallet: createWalletClient({ chain, transport: http(EVM_RPC), account: evm }) };
}
type A = Awaited<ReturnType<typeof acct>>;

async function seq(addr: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${addr}`);
  if (res.status === 404) throw new Error(`${addr} has no QOR yet: fund it from the faucet first`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(a.account_number ?? "0"), sequence: BigInt(a.sequence ?? "0") };
}

async function nativeTx(u: UnifiedAccount, mode: "hybrid" | "classical", messages: Parameters<EthNativeSigner["sign"]>[0]["messages"]): Promise<string> {
  const { accountNumber, sequence } = await seq(u.cosmos);
  const signer = new EthNativeSigner(u, { signMode: mode, rest: REST });
  const t = await StargateClient.connect(RPC);
  try { return (await signer.signAndBroadcast(t, { chainId: net.chainId, accountNumber, sequence, fee: FEE, messages })).transactionHash; }
  finally { t.disconnect(); }
}

async function status() {
  for (const role of ["owner", "agent"] as Role[]) {
    const a = await acct(role);
    const bal = await pub.getBalance({ address: a.evm.address });
    const pqc = await fetchPqcStatus({ rest: REST, address: a.unified.cosmos });
    const w = await evmWindowStatus({ rest: REST, address: a.unified.cosmos });
    console.log(`${role.padEnd(6)} ${a.unified.cosmos}  ${formatEther(bal)} QOR  PQC key: ${pqc.registered ? "registered" : "not registered"}  window: ${w.found && w.live ? `live (${w.remainingBlocks} blocks, ${w.remainingTxs} txs)` : "none"}`);
  }
}

async function register() {
  for (const role of ["owner", "agent"] as Role[]) {
    const a = await acct(role);
    const pqc = await fetchPqcStatus({ rest: REST, address: a.unified.cosmos });
    if (pqc.registered) { console.log(`${role}: already registered`); continue; }
    const proof = signProofOfPossession({ chainId: net.chainId, account: a.unified.cosmos, keypair: a.unified.pqc });
    const msg = buildRegisterPqcKeyMsg(a.unified.cosmos, { pqcKeypair: a.unified.pqc, proofOfPossession: proof });
    console.log(`${role}: registered ${await nativeTx(a.unified, "classical", [msg])}`);
    await sleep(8000);
  }
}

async function openWindow(a: A, opts: { blocks: bigint; maxTxs: bigint; gas: bigint; targets?: Address[] }) {
  const perTx = evmWindowCost({ gas: opts.gas, maxFeePerGas: FEES.maxFeePerGas });
  const maxValue = perTx * opts.maxTxs + (a.role === "owner" ? 20_000_000n : 0n); // owner also sends 10 QOR to the guard
  const msg = openEvmWindowMsg({ sender: a.unified.cosmos, blocks: opts.blocks, maxTxs: opts.maxTxs, maxValue, ...(opts.targets ? { allowedTargets: opts.targets } : {}) });
  console.log(`${a.role}: window opened ${await nativeTx(a.unified, "hybrid", [msg])}`);
  await sleep(12000); // opening advances the nonce; the docs say to wait about 10 s
}

async function all() {
  const owner = await acct("owner"), agent = await acct("agent");
  const t0 = Date.now();
  // 1. Owner window (unscoped: deploying needs one), deploy guard + a second guard, fund the guard.
  await openWindow(owner, { blocks: 1200n, maxTxs: 8n, gas: 3_000_000n });
  const art = JSON.parse(readFileSync("out/LeashGuard.sol/LeashGuard.json", "utf8"));
  const deploy = async () => {
    const hash = await owner.wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [owner.evm.address], gas: 3_000_000n, ...FEES, account: owner.evm, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
    console.log(`deployed ${r.contractAddress} (${hash})`);
    return { address: r.contractAddress, hash };
  };
  const guard = await deploy();
  const other = await deploy();
  const fundHash = await owner.wallet.sendTransaction({ to: guard.address, value: 10n * 10n ** 18n, gas: 200_000n, ...FEES, account: owner.evm, chain });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  console.log(`guard funded with 10 QOR (${fundHash})`);

  // 2. The plain-English leash, compiled and applied with a REAL ML-DSA-87 signature from the owner.
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const sentence = `agent ${agent.evm.address} may spend up to 3 QOR a day, at most 1 QOR per payment, only to ${recipient} for 3 hours`;
  const head = await pub.getBlock();
  const compiled = compile(sentence, { now: Number(head.timestamp), guard: guard.address });
  if (!compiled.ok || !compiled.mandate) throw new Error(JSON.stringify(compiled.findings));
  const m = compiled.mandate;
  const ownerPqc: PqcSigner = { sign: (msg) => toHex(pqcSign(owner.unified.pqc.secretKey, hexToBytes(msg))) };
  const message = (await pub.readContract({ address: guard.address, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(m), 0n] })) as Hex;
  console.log(`mandate message ${hexToBytes(message).length} bytes; signing with ML-DSA-87`);
  const applyHash = await owner.wallet.writeContract({ address: guard.address, abi: guardAbi, functionName: "applyMandate", args: [wireMandate(m), ownerPqc.sign(message)], gas: 1_500_000n, ...FEES, account: owner.evm, chain });
  const ar = await pub.waitForTransactionReceipt({ hash: applyHash });
  console.log(`applyMandate ${ar.status} gas ${ar.gasUsed} (${applyHash}): pqcVerify accepted a real ML-DSA-87 signature: ${ar.status === "success"}`);
  if (ar.status !== "success") throw new Error("mandate was not applied");

  // 3. Agent window, scoped to the guard only. The agent never holds an ML-DSA-87 key for spending.
  await openWindow(agent, { blocks: 1200n, maxTxs: 10n, gas: 1_500_000n, targets: [guard.address] });

  // 4. The Q-Day drill on the real chain.
  const stranger = createWalletClient({ chain, transport: http(EVM_RPC), account: privateKeyToAccount(generatePrivateKey()) });
  const results = await runSuite({
    chain, pub, guard: guard.address, agent: agent.wallet as never, owner: owner.wallet as never, stranger: stranger as never,
    ownerPqc, mandate: m, otherGuard: other.address, gas: 1_500_000n,
  });
  console.log("\n" + render(results));
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-drill.json", JSON.stringify({
    network: "qorechain-diana", evmChainId: 9800, sentence, guard: guard.address, otherGuard: other.address, deployTx: guard.hash, applyTx: applyHash,
    explorer: `https://explore.qore.network/address/${guard.address}`, seconds: Math.round((Date.now() - t0) / 1000), results,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

const cmds: Record<string, () => Promise<void>> = { status, register, all };
const c = cmds[process.argv[2] ?? "status"];
if (!c) { console.error("Use: status | register | all"); process.exit(1); }
c().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
