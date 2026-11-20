// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ILeashAdapter} from "../LeashGuardV2.sol";

/// Wrap and unwrap adapter for WETH9-style wrapped native tokens (deposit() payable, withdraw(uint256)).
/// The wrapped token is the route's target. Both actions credit the caller, which is the guard.
contract WrapAdapter is ILeashAdapter {
    error UnsupportedSelector(bytes4 selector);

    bytes4 internal constant DEPOSIT = 0xd0e30db0; // deposit()
    bytes4 internal constant WITHDRAW = 0x2e1a7d4d; // withdraw(uint256)

    function inspect(address target, bytes calldata data, uint256 value) external view returns (Flow memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == DEPOSIT) return Flow(address(0), value, target, msg.sender);
        if (sel == WITHDRAW) {
            uint256 amount = abi.decode(data[4:], (uint256));
            return Flow(target, amount, address(0), msg.sender);
        }
        revert UnsupportedSelector(sel);
    }
}
