/**
 * actions.ts - build the call data for each on-chain action a LeashGuardV2 route can allow.
 * Each builder returns what `guard.execute(adapter, target, data, value)` needs. Nothing here sends a transaction.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { AdapterRegistry, FlowKind } from "./policy.ts";

const v2Router = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);
const wrapAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);
const vaultAbi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function asset() view returns (address)",
]);

export const routerAbi = v2Router;
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export interface Action {
  kind: FlowKind;
  adapter: Address;
  target: Address;
  data: Hex;
  value: bigint; // native value forwarded with the call (native-in actions only)
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

interface Common { guard: Address; adapters: AdapterRegistry; target: Address; amountIn: bigint }
const need = (a: Address | undefined, what: string): Address => { if (!a) throw new Error(`No ${what} adapter configured (LEASH_ADAPTERS)`); return a; };

/** Swap through a V2-style router. Use NATIVE as tokenIn or tokenOut for the native coin; `wrapped` is the router's WETH. */
export function swap(c: Common & { tokenIn: Address; tokenOut: Address; wrapped?: Address; minOut: bigint; deadline?: bigint; to?: Address }): Action {
  const deadline = c.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 600);
  const to = c.to ?? c.guard;
  const nativeIn = c.tokenIn === NATIVE, nativeOut = c.tokenOut === NATIVE;
  if (nativeIn && nativeOut) throw new Error("tokenIn and tokenOut are both native");
  if ((nativeIn || nativeOut) && !c.wrapped) throw new Error("A native swap needs the router's wrapped-native address");
  const path = [nativeIn ? c.wrapped! : c.tokenIn, nativeOut ? c.wrapped! : c.tokenOut];
  const data = nativeIn
    ? encodeFunctionData({ abi: v2Router, functionName: "swapExactETHForTokens", args: [c.minOut, path, to, deadline] })
    : nativeOut
      ? encodeFunctionData({ abi: v2Router, functionName: "swapExactTokensForETH", args: [c.amountIn, c.minOut, path, to, deadline] })
      : encodeFunctionData({ abi: v2Router, functionName: "swapExactTokensForTokens", args: [c.amountIn, c.minOut, path, to, deadline] });
  return { kind: "swap", adapter: need(c.adapters.univ2, "swap (univ2)"), target: c.target, data, value: nativeIn ? c.amountIn : 0n, tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: c.amountIn };
}

/** Wrap the native coin into the wrapped token at `target`. */
export function wrap(c: Common): Action {
  return { kind: "wrap", adapter: need(c.adapters.wrap, "wrap"), target: c.target, data: encodeFunctionData({ abi: wrapAbi, functionName: "deposit" }), value: c.amountIn, tokenIn: NATIVE, tokenOut: c.target, amountIn: c.amountIn };
}

export function unwrap(c: Common): Action {
  return { kind: "unwrap", adapter: need(c.adapters.wrap, "wrap"), target: c.target, data: encodeFunctionData({ abi: wrapAbi, functionName: "withdraw", args: [c.amountIn] }), value: 0n, tokenIn: c.target, tokenOut: NATIVE, amountIn: c.amountIn };
}

/** Deposit `amountIn` of the vault's asset. */
export function vaultDeposit(c: Common & { asset: Address }): Action {
  return { kind: "deposit", adapter: need(c.adapters.erc4626, "erc4626"), target: c.target, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [c.amountIn, c.guard] }), value: 0n, tokenIn: c.asset, tokenOut: c.target, amountIn: c.amountIn };
}

/** Redeem `amountIn` shares for the vault's asset. */
export function vaultRedeem(c: Common & { asset: Address }): Action {
  return { kind: "redeem", adapter: need(c.adapters.erc4626, "erc4626"), target: c.target, data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [c.amountIn, c.guard, c.guard] }), value: 0n, tokenIn: c.target, tokenOut: c.asset, amountIn: c.amountIn };
}

/** The smallest output the owner's rate floor allows for an input, so the router itself refuses anything the guard would. */
export const floorOut = (amountIn: bigint, minOutPerInE18: bigint): bigint => (amountIn * minOutPerInE18) / 10n ** 18n;
