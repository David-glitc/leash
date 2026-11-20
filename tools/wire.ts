/**
 * wire.ts - the on-chain encoding of a v2 mandate, and the LeashGuardV2 ABI.
 * v1 (LeashGuard) uses attack.ts's wireMandate; v2 adds `routes` and a different signed-message domain.
 */
import { parseAbi } from "viem";
import type { Mandate } from "./policy.ts";

const MANDATE = "(address agent, uint64 expiry, address[] tokens, (uint128 perTx, uint128 daily)[] limits, address[] recipients, (address adapter, address target, address tokenIn, address tokenOut, uint256 minOutPerInE18)[] routes)";

export const guardV2Abi = parseAbi([
  "function owner() view returns (address)",
  "function agent() view returns (address)",
  "function frozen() view returns (bool)",
  "function nonce() view returns (uint256)",
  "function expiry() view returns (uint64)",
  "function tokens() view returns (address[])",
  "function recipients() view returns (address[])",
  `function routes() view returns ((address adapter, address target, address tokenIn, address tokenOut, uint256 minOutPerInE18)[])`,
  "function limitOf(address) view returns (uint128 perTx, uint128 daily)",
  "function remainingToday(address token) view returns (uint256)",
  "function spend(address token, address to, uint256 amount)",
  "function execute(address adapter, address target, bytes data, uint256 value) returns (uint256 received)",
  "function freeze()",
  `function mandateMessage(${MANDATE} m, uint256 nonce) view returns (bytes)`,
  `function applyMandate(${MANDATE} m, bytes sig)`,
  "event MandateApplied(uint256 indexed nonce, address indexed agent, uint64 expiry, bytes32 mandateHash)",
  "event Frozen(address indexed by)",
  "event Spent(address indexed token, address indexed to, uint256 amount, uint256 spentToday)",
  "event Executed(address indexed adapter, address indexed target, address tokenIn, uint256 amountIn, address tokenOut, uint256 received)",
  "event Deposited(address indexed from, uint256 amount)",
  "error NotAgent()", "error NotOwnerOrAgent()", "error IsFrozen()", "error Expired()", "error TokenNotSpendable()",
  "error RecipientNotAllowed()", "error OverPerTxLimit()", "error OverDailyLimit()", "error OwnerKeyNotRegistered()",
  "error OwnerKeyNotProven()", "error BadPqcSignature()", "error BadMandate()", "error TransferFailed()",
  "error RouteNotAllowed()", "error OutputNotToGuard()", "error ValueMismatch()", "error TokenNotListed()", "error ZeroAmount()",
  "error ExecFailed()", "error BadAction()", "error BelowRateFloor()", "error UnexpectedOutflow(address token)", "error Reentrancy()",
]);

export const wireMandateV2 = (m: Mandate) => ({
  agent: m.agent,
  expiry: BigInt(m.expiry),
  tokens: m.tokens,
  limits: m.limits,
  recipients: m.recipients,
  routes: m.routes.map((r) => ({ adapter: r.adapter, target: r.target, tokenIn: r.tokenIn, tokenOut: r.tokenOut, minOutPerInE18: r.minOutPerInE18 })),
});
