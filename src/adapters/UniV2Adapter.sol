// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ILeashAdapter} from "../LeashGuardV2.sol";

/// Swap adapter for Uniswap-V2-style routers (swapExactTokensForTokens, swapExactETHForTokens, swapExactTokensForETH).
/// It only decodes the call. The guard measures what actually happens.
contract UniV2Adapter is ILeashAdapter {
    error UnsupportedSelector(bytes4 selector);
    error BadPath();

    // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
    bytes4 internal constant TOKENS_FOR_TOKENS = 0x38ed1739;
    // swapExactETHForTokens(uint256,address[],address,uint256)
    bytes4 internal constant ETH_FOR_TOKENS = 0x7ff36ab5;
    // swapExactTokensForETH(uint256,uint256,address[],address,uint256)
    bytes4 internal constant TOKENS_FOR_ETH = 0x18cbafe5;

    function inspect(address, bytes calldata data, uint256 value) external pure returns (Flow memory f) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == TOKENS_FOR_TOKENS) {
            (uint256 amountIn,, address[] memory path, address to,) =
                abi.decode(data[4:], (uint256, uint256, address[], address, uint256));
            _checkPath(path);
            f = Flow(path[0], amountIn, path[path.length - 1], to);
        } else if (sel == ETH_FOR_TOKENS) {
            (, address[] memory path, address to,) = abi.decode(data[4:], (uint256, address[], address, uint256));
            _checkPath(path);
            f = Flow(address(0), value, path[path.length - 1], to);
        } else if (sel == TOKENS_FOR_ETH) {
            (uint256 amountIn,, address[] memory path, address to,) =
                abi.decode(data[4:], (uint256, uint256, address[], address, uint256));
            _checkPath(path);
            f = Flow(path[0], amountIn, address(0), to);
        } else {
            revert UnsupportedSelector(sel);
        }
    }

    function _checkPath(address[] memory path) private pure {
        if (path.length < 2 || path.length > 4) revert BadPath();
    }
}
