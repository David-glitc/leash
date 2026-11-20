/**
 * testnet.ts - run Leash on the real QoreChain testnet (qorechain-diana).
 *
 *   pnpm testnet status     balances, post-quantum keys and windows for owner and agent
 *   pnpm testnet register   register both accounts' ML-DSA-87 keys (once each; the agent needs a little QOR first)
 *   pnpm testnet fund       owner sends 25 QOR to the agent (hybrid-signed), so one faucet claim is enough
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
import { createPublicClient, createWalletClient, defineChain, http, hexToBytes, toHex, formatEther, parseAbi, type Address, type Hex } from "viem";
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "./policy.ts";
import { runSuite, render, guardAbi, wireMandate, type PqcSigner } from "./attack.ts";
import { runSuiteV2 } from "./attack-v2.ts";
import { guardV2Abi, wireMandateV2 } from "./wire.ts";
import { swap, wrap, unwrap, vaultDeposit, vaultRedeem, floorOut } from "./actions.ts";

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
async function retry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw e; console.log(`  ${label}: ${e instanceof Error ? e.message : e} (retry ${i}/${tries - 1})`); await sleep(4000 * i); }
  }
}
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

async function fund() {
  const owner = await acct("owner"), agent = await acct("agent");
  const have = await pub.getBalance({ address: agent.evm.address });
  if (have >= 20n * 10n ** 18n) { console.log(`agent already has ${formatEther(have)} QOR`); return; }
  const o = await fetchPqcStatus({ rest: REST, address: owner.unified.cosmos });
  if (!o.registered) throw new Error("register the owner first: pnpm testnet register");
  const msg = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: owner.unified.cosmos, toAddress: agent.unified.cosmos, amount: [{ denom: "uqor", amount: "25000000" }] } };
  console.log(`funded agent with 25 QOR: ${await nativeTx(owner.unified, "hybrid", [msg as never])}`);
  await sleep(8000);
}

async function register() {
  for (const role of ["owner", "agent"] as Role[]) {
    if (role === "agent") { const b = await pub.getBalance({ address: (await acct("agent")).evm.address }); if (b === 0n) { await fund(); } }
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
  const cur = await retry("window status", () => evmWindowStatus({ rest: REST, address: a.unified.cosmos }));
  if (cur.found && cur.live && BigInt(cur.remainingTxs) >= opts.maxTxs) { console.log(`${a.role}: window already live (${cur.remainingBlocks} blocks, ${cur.remainingTxs} txs)`); return; }
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

  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-state.json", JSON.stringify({ guard: guard.address, otherGuard: other.address, deployTx: guard.hash, applyTx: applyHash, sentence }, null, 2));
  await drill({ guard: guard.address, otherGuard: other.address, deployTx: guard.hash, applyTx: applyHash, sentence }, t0);
}

type State = { guard: Address; otherGuard?: Address; deployTx?: string; applyTx?: string; sentence?: string };

/** Rebuild the mandate from the guard's own on-chain state, so a drill can resume after a failure. */
async function mandateFromChain(guard: Address) {
  const abi = parseAbi([
    "function agent() view returns (address)", "function expiry() view returns (uint64)",
    "function tokens() view returns (address[])", "function recipients() view returns (address[])",
    "function limitOf(address) view returns (uint128 perTx, uint128 daily)",
  ]);
  const read = <T,>(fn: string, args: unknown[] = []) => retry(fn, () => pub.readContract({ address: guard, abi, functionName: fn as never, args: args as never }) as Promise<T>);
  const [agentAddr, expiry, tokens, recipients] = await Promise.all([read<Address>("agent"), read<bigint>("expiry"), read<Address[]>("tokens"), read<Address[]>("recipients")]);
  const limits = await Promise.all(tokens.map(async (t) => { const [perTx, daily] = await read<readonly [bigint, bigint]>("limitOf", [t]); return { perTx, daily }; }));
  return { agent: agentAddr, expiry: Number(expiry), tokens, limits, recipients, routes: [] };
}

async function drill(st: State, t0 = Date.now()) {
  const owner = await acct("owner"), agent = await acct("agent");
  const m = await mandateFromChain(st.guard);
  const ownerPqc: PqcSigner = { sign: (msg) => toHex(pqcSign(owner.unified.pqc.secretKey, hexToBytes(msg))) };
  // 3. Agent window, scoped to the guard only. The agent never holds an ML-DSA-87 key for spending.
  await openWindow(agent, { blocks: 1200n, maxTxs: 10n, gas: 1_500_000n, targets: [st.guard] });

  // 4. The Q-Day drill on the real chain.
  const stranger = createWalletClient({ chain, transport: http(EVM_RPC), account: privateKeyToAccount(generatePrivateKey()) });
  const results = await runSuite({
    chain, pub, guard: st.guard, agent: agent.wallet as never, owner: owner.wallet as never, stranger: stranger as never,
    ownerPqc, mandate: m, otherGuard: st.otherGuard, gas: 1_500_000n,
  });
  console.log("\n" + render(results));
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-drill.json", JSON.stringify({
    network: "qorechain-diana", evmChainId: 9800, sentence: st.sentence, guard: st.guard, otherGuard: st.otherGuard, deployTx: st.deployTx, applyTx: st.applyTx,
    explorer: `https://explore.qore.network/address/${st.guard}`, seconds: Math.round((Date.now() - t0) / 1000), results,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}


/** Re-arm an existing guard with a fresh 5-hour mandate (same recipient and limits), signed by the owner's real ML-DSA-87 key, and reopen the agent's scoped window. */
async function rearm() {
  const st: State = JSON.parse(readFileSync("reports/testnet-state.json", "utf8"));
  const owner = await acct("owner"), agent = await acct("agent");
  const cur = await mandateFromChain(st.guard);
  const head = await pub.getBlock();
  const compiled = compile(`agent ${agent.evm.address} may spend up to 3 QOR a day, at most 1 QOR per payment, only to ${cur.recipients[0]} for 5 hours`, { now: Number(head.timestamp), guard: st.guard });
  if (!compiled.ok || !compiled.mandate) throw new Error(JSON.stringify(compiled.findings));
  const m = compiled.mandate;
  const n = (await pub.readContract({ address: st.guard, abi: guardAbi, functionName: "nonce" })) as bigint;
  const message = (await pub.readContract({ address: st.guard, abi: guardAbi, functionName: "mandateMessage", args: [wireMandate(m), n] })) as Hex;
  const sig = toHex(pqcSign(owner.unified.pqc.secretKey, hexToBytes(message)));
  await openWindow(owner, { blocks: 600n, maxTxs: 4n, gas: 1_500_000n });
  const h = await owner.wallet.writeContract({ address: st.guard, abi: guardAbi, functionName: "applyMandate", args: [wireMandate(m), sig], gas: 1_500_000n, ...FEES, account: owner.evm, chain });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`re-armed guard ${st.guard}: nonce ${n} -> ${n + 1n}, ${r.status} (${h})`);
  await openWindow(agent, { blocks: 1200n, maxTxs: 10n, gas: 1_500_000n, targets: [st.guard] });
}

// ------------------------------------------------------------------ LeashGuardV2: guarded actions on the real chain

const art2 = (file: string, name: string) => JSON.parse(readFileSync(`out/${file}.sol/${name}.json`, "utf8"));
const parseEth = (v: string) => BigInt(Math.round(Number(v) * 1e6)) * 10n ** 12n;

type StateV2 = { guard: Address; otherGuard: Address; adapters: { univ2: Address; wrap: Address; erc4626: Address }; tokens: { USD: Address; ETHX: Address; WQOR: Address; VUSD: Address }; router: Address; shortRouter: Address; unlistedRouter: Address; vault: Address; deployTx: string; applyTx: string; sentence: string };

const sentenceV2 = (agent: Address, s: StateV2) =>
  `agent ${agent} up to 100 USD a day, at most 40 USD per payment, up to 2 QOR a day, at most 1 QOR per payment, up to 2 WQOR a day, at most 1 WQOR per payment, up to 100 VUSD a day, at most 50 VUSD per payment, `
  + `swap USD for ETHX on ${s.router} at no worse than 0.00049 ETHX per USD, swap USD for ETHX on ${s.shortRouter} at no worse than 0.00049 ETHX per USD, `
  + `wrap QOR into WQOR on ${s.tokens.WQOR}, unwrap WQOR to QOR on ${s.tokens.WQOR}, deposit USD into vault ${s.vault} as VUSD at no worse than 0.99 VUSD per USD, redeem VUSD from vault ${s.vault} for USD at no worse than 0.99 USD per VUSD for ${process.env.LEASH_DURATION ?? "5 hours"}`;
const tokenRegV2 = (s: StateV2) => ({ USD: { address: s.tokens.USD, decimals: 18 }, ETHX: { address: s.tokens.ETHX, decimals: 18 }, WQOR: { address: s.tokens.WQOR, decimals: 18 }, VUSD: { address: s.tokens.VUSD, decimals: 18 } });

async function applyV2(st: StateV2, owner: A, agent: A) {
  const head = await pub.getBlock();
  const sentence = sentenceV2(agent.evm.address, st);
  const c = compile(sentence, { now: Number(head.timestamp), guard: st.guard, tokens: tokenRegV2(st), adapters: st.adapters });
  if (!c.ok || !c.mandate) throw new Error(JSON.stringify(c.findings));
  const n = (await pub.readContract({ address: st.guard, abi: guardV2Abi, functionName: "nonce" })) as bigint;
  const message = (await pub.readContract({ address: st.guard, abi: guardV2Abi, functionName: "mandateMessage", args: [wireMandateV2(c.mandate), n] })) as Hex;
  console.log(`mandate message ${hexToBytes(message).length} bytes; signing with the owner's ML-DSA-87 key`);
  const sig = toHex(pqcSign(owner.unified.pqc.secretKey, hexToBytes(message)));
  const h = await owner.wallet.writeContract({ address: st.guard, abi: guardV2Abi, functionName: "applyMandate", args: [wireMandateV2(c.mandate), sig], gas: 3_000_000n, ...FEES, account: owner.evm, chain });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`applyMandate ${r.status} gas ${r.gasUsed} (${h}): pqcVerify accepted a real ML-DSA-87 signature: ${r.status === "success"}`);
  if (r.status !== "success") throw new Error("mandate was not applied");
  return { mandate: c.mandate, sentence, applyHash: h };
}

async function allV2() {
  const owner = await acct("owner"), agent = await acct("agent");
  const t0 = Date.now();
  await openWindow(owner, { blocks: 1500n, maxTxs: 36n, gas: 3_000_000n });
  const deploy = async (file: string, name: string, args: unknown[] = [], value = 0n) => {
    const a = art2(file, name);
    const hash = await retry(`deploy ${name}`, () => owner.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, value, gas: 3_000_000n, ...FEES, account: owner.evm, chain }));
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed ${hash}`);
    console.log(`  ${name.padEnd(16)} ${r.contractAddress}`);
    return { address: r.contractAddress as Address, hash };
  };
  const write = async (to: Address, abi: unknown, fn: string, args: unknown[]) => {
    const h = await retry(fn, () => owner.wallet.writeContract({ address: to, abi, functionName: fn, args, gas: 500_000n, ...FEES, account: owner.evm, chain } as never));
    await pub.waitForTransactionReceipt({ hash: h });
  };
  console.log("deploying test tokens, routers, a vault, three adapters and two guards...");
  const usd = await deploy("Mocks", "MockERC20"), ethx = await deploy("Mocks", "MockERC20"), wqor = await deploy("Mocks", "MockWETH");
  const router = await deploy("Mocks", "MockRouterV2", [wqor.address]), shortRouter = await deploy("Mocks", "MockRouterV2", [wqor.address]), unlisted = await deploy("Mocks", "MockRouterV2", [wqor.address]);
  const vault = await deploy("Mocks", "MockVault", [usd.address]);
  const adapters = { univ2: (await deploy("UniV2Adapter", "UniV2Adapter")).address, wrap: (await deploy("WrapAdapter", "WrapAdapter")).address, erc4626: (await deploy("Erc4626Adapter", "Erc4626Adapter")).address };
  const guard = await deploy("LeashGuardV2", "LeashGuardV2", [owner.evm.address]), other = await deploy("LeashGuardV2", "LeashGuardV2", [owner.evm.address]);
  const rt = art2("Mocks", "MockRouterV2").abi, erc = art2("Mocks", "MockERC20").abi;
  for (const r of [router, shortRouter, unlisted]) await write(r.address, rt, "setRate", [usd.address, ethx.address, parseEth("0.0005")]);
  await write(shortRouter.address, rt, "setBehaviour", ["0x0000000000000000000000000000000000000000", 500n]); // under-delivers by 5 percent
  await write(usd.address, erc, "mint", [guard.address, parseEth("1000")]);
  const fund = await owner.wallet.sendTransaction({ to: guard.address, value: 3n * 10n ** 18n, gas: 200_000n, ...FEES, account: owner.evm, chain });
  await pub.waitForTransactionReceipt({ hash: fund });
  const st: StateV2 = { guard: guard.address, otherGuard: other.address, adapters, tokens: { USD: usd.address, ETHX: ethx.address, WQOR: wqor.address, VUSD: vault.address }, router: router.address, shortRouter: shortRouter.address, unlistedRouter: unlisted.address, vault: vault.address, deployTx: guard.hash, applyTx: "", sentence: "" };

  const { mandate, sentence, applyHash } = await applyV2(st, owner, agent);
  st.applyTx = applyHash; st.sentence = sentence;
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-v2-state.json", JSON.stringify(st, null, 2));
  await openWindow(agent, { blocks: 1500n, maxTxs: 30n, gas: 2_000_000n, targets: [st.guard] });

  // Every adapter, with the TypeScript action builders, as real transactions.
  console.log("\nadapter tour (real transactions through the guard):");
  const swapRoute = mandate.routes.find((r) => r.kind === "swap" && r.target.toLowerCase() === st.router.toLowerCase())!;
  const common = { guard: st.guard, adapters };
  const steps = [
    wrap({ ...common, target: st.tokens.WQOR, amountIn: parseEth("1") }), unwrap({ ...common, target: st.tokens.WQOR, amountIn: parseEth("0.5") }),
    vaultDeposit({ ...common, target: st.vault, asset: st.tokens.USD, amountIn: parseEth("40") }), vaultRedeem({ ...common, target: st.vault, asset: st.tokens.USD, amountIn: parseEth("10") }),
    swap({ ...common, target: st.router, tokenIn: st.tokens.USD, tokenOut: st.tokens.ETHX, amountIn: parseEth("20"), minOut: floorOut(parseEth("20"), swapRoute.minOutPerInE18) }),
  ];
  const tour: { kind: string; ok: boolean; tx: string }[] = [];
  for (const a of steps) {
    const h = await retry(a.kind, () => agent.wallet.writeContract({ address: st.guard, abi: guardV2Abi, functionName: "execute", args: [a.adapter, a.target, a.data, a.value], gas: 2_000_000n, ...FEES, account: agent.evm, chain }));
    const r = await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  ${r.status === "success" ? "ok  " : "FAIL"} ${a.kind.padEnd(8)} ${h}`);
    tour.push({ kind: a.kind, ok: r.status === "success", tx: h });
  }
  await drillV2(st, owner, agent, mandate, tour, t0);
}

async function drillV2(st: StateV2, owner: A, agent: A, mandate: Awaited<ReturnType<typeof applyV2>>["mandate"], tour: unknown[], t0 = Date.now()) {
  const ownerPqc: PqcSigner = { sign: (msg) => toHex(pqcSign(owner.unified.pqc.secretKey, hexToBytes(msg))) };
  const stranger = createWalletClient({ chain, transport: http(EVM_RPC), account: privateKeyToAccount(generatePrivateKey()) });
  const swapRoute = mandate.routes.find((r) => r.kind === "swap" && r.target.toLowerCase() === st.router.toLowerCase())!;
  const results = await runSuiteV2({
    chain, pub, guard: st.guard, agent: agent.wallet as never, owner: owner.wallet as never, stranger: stranger as never, ownerPqc, mandate,
    swapAdapter: st.adapters.univ2, router: st.router, tokenIn: swapRoute.tokenIn, tokenOut: swapRoute.tokenOut, unlistedRouter: st.unlistedRouter, shortRouter: st.shortRouter, otherGuard: st.otherGuard, gas: 2_000_000n,
  });
  console.log("\n" + render(results));
  writeFileSync("reports/testnet-v2-drill.json", JSON.stringify({
    network: "qorechain-diana", evmChainId: 9800, sentence: st.sentence, guard: st.guard, otherGuard: st.otherGuard, adapters: st.adapters, tokens: st.tokens, router: st.router, shortRouter: st.shortRouter, vault: st.vault,
    deployTx: st.deployTx, applyTx: st.applyTx, explorer: `https://explore.qore.network/address/${st.guard}`, seconds: Math.round((Date.now() - t0) / 1000), tour, results,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

/** Re-arm the v2 guard with a fresh 5-hour mandate (real ML-DSA-87 signature) and reopen the agent's scoped window. */
async function rearmV2() {
  const st: StateV2 = JSON.parse(readFileSync("reports/testnet-v2-state.json", "utf8"));
  const owner = await acct("owner"), agent = await acct("agent");
  await openWindow(owner, { blocks: 600n, maxTxs: 4n, gas: 3_000_000n });
  const { sentence, applyHash } = await applyV2(st, owner, agent);
  st.sentence = sentence; st.applyTx = applyHash;
  writeFileSync("reports/testnet-v2-state.json", JSON.stringify(st, null, 2));
  await openWindow(agent, { blocks: 1500n, maxTxs: 30n, gas: 2_000_000n, targets: [st.guard] });
}

async function resume() {
  const f = "reports/testnet-state.json";
  const st: State = process.argv[3] ? { guard: process.argv[3] as Address, otherGuard: process.argv[4] as Address | undefined } : JSON.parse(readFileSync(f, "utf8"));
  await drill(st);
}

const cmds: Record<string, () => Promise<void>> = { status, register, fund, all, drill: resume, rearm, v2: allV2, v2rearm: rearmV2 };
const c = cmds[process.argv[2] ?? "status"];
if (!c) { console.error("Use: status | register | fund | all | drill [guard] [otherGuard] | rearm | v2 | v2rearm"); process.exit(1); }
c().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
