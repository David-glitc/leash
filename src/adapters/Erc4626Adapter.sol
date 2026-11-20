// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ILeashAdapter} from "../LeashGuardV2.sol";

interface IERC4626Asset {
    function asset() external view returns (address);
}

/// Vault adapter for ERC-4626 vaults: deposit(assets, receiver) and redeem(shares, receiver, owner).
/// The vault is the route's target and its own share token. Redeem must burn the guard's own shares.
contract Erc4626Adapter is ILeashAdapter {
    error UnsupportedSelector(bytes4 selector);
    error NotOwnShares();

    bytes4 internal constant DEPOSIT = 0x6e553f65; // deposit(uint256,address)
    bytes4 internal constant REDEEM = 0xba087652; // redeem(uint256,address,address)

    function inspect(address target, bytes calldata data, uint256) external view returns (Flow memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == DEPOSIT) {
            (uint256 assets, address receiver) = abi.decode(data[4:], (uint256, address));
            return Flow(IERC4626Asset(target).asset(), assets, target, receiver);
        }
        if (sel == REDEEM) {
            (uint256 shares, address receiver, address from) = abi.decode(data[4:], (uint256, address, address));
            if (from != msg.sender) revert NotOwnShares();
            return Flow(target, shares, IERC4626Asset(target).asset(), receiver);
        }
        revert UnsupportedSelector(sel);
    }
}
