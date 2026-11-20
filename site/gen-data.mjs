// Generates site/assets/verify-data.json: everything the in-browser verifier needs (tx hashes from the reports, expected masked runtime code).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const rd = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const refsOf = (art) => Object.values(art.deployedBytecode.immutableReferences ?? {}).flat().map((r) => ({ start: r.start, length: r.length }));
const mask = (art) => {
  const hex = art.deployedBytecode.object.toLowerCase().replace(/^0x/, "");
  const refs = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat();
  const b = hex.split("");
  for (const r of refs) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = "0";
  return b.join("");
};
const v1 = rd("reports/testnet-drill.json"), v2 = rd("reports/testnet-v2-drill.json"), mcp = rd("reports/mcp-live-demo-v2.json"), mcp1 = existsSync(new URL("../reports/mcp-live-demo.json", import.meta.url)) ? rd("reports/mcp-live-demo.json") : null;
const out = {
  rpc: "https://evm-testnet.qore.host", chainId: 9800,
  owner: "0x9fA42BbB41d8a7c13123e3BE086b79bc924B2750",
  guards: { v1: v1.guard, v2: v2.guard },
  code: { v1: mask(rd("out/LeashGuard.sol/LeashGuard.json")), v2: mask(rd("out/LeashGuardV2.sol/LeashGuardV2.json")) },
  refs: { v1: refsOf(rd("out/LeashGuard.sol/LeashGuard.json")), v2: refsOf(rd("out/LeashGuardV2.sol/LeashGuardV2.json")) },
  applyTx: { v1: v1.applyTx, v2: v2.applyTx },
  registry: { tokens: v2.tokens, adapters: v2.adapters, router: v2.router, shortRouter: v2.shortRouter, vault: v2.vault, agent: "0x3E137Aa22320c998405C917aa8A74d67fF23c705", payee: "0x794B8d53ddcF93c05D97134f15Dc905223accD3e" },
  selectors: { owner: "0x8da5cb5b", nonce: "0xaffed0e0", frozen: "0x054f7d9c", expiry: "0xe184c9be", routes: "0xb1ffd471" },
  executedTopic: "0xc52394b8c75b37ee58cdbe7136df01e6a81a7ca7a69ae0f25db4618f1ff518d5",
  tour: v2.tour.map((t) => ({ kind: t.kind, tx: t.tx })),
  mcpTx: mcp.calls.filter((c) => c.result && typeof c.result === "object" && c.result.sent && c.result.txHash).map((c) => ({ tool: c.tool, tx: c.result.txHash })),
  drills: { testnetV1: v1.results, testnetV2: v2.results, localV2: rd("reports/local-v2-drill.json").results, localV1: rd("reports/local-drill.json").results },
  mcpTranscript: mcp.calls.map((c) => ({ tool: c.tool, args: c.args, isError: c.isError, result: c.result })),
  monitor: rd("reports/local-monitor.json"),
  campaign: existsSync(new URL("../reports/attack-campaign.json", import.meta.url)) ? rd("reports/attack-campaign.json") : null,
  staticAnalysis: existsSync(new URL("../reports/static-analysis.json", import.meta.url)) ? rd("reports/static-analysis.json") : null,
  mutation: existsSync(new URL("../reports/mutation.json", import.meta.url)) ? rd("reports/mutation.json").summary : null,
};
writeFileSync(new URL("./assets/verify-data.json", import.meta.url), JSON.stringify(out));
console.log("wrote verify-data.json", Math.round(JSON.stringify(out).length / 1024), "KB");
