// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeashGuard} from "../src/LeashGuard.sol";

/// Stand-in for the QoreChain precompiles on Foundry's local EVM, which has none. The real ones
/// run on the testnet (see README, "On chain"). A signature counts as valid here when it equals
/// keccak256("ok", pubkey, message). Same idea as the organisers' qday-vault sample.
contract MockPqc {
    bool public registered = true;
    bool public proven = true;

    function set(bool registered_, bool proven_) external {
        registered = registered_;
        proven = proven_;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external pure returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(abi.encodePacked("ok", pubkey, message))));
    }

    function pqcKeyStatus(address) external view returns (bool, uint8, bytes memory, bool) {
        return (registered, 1, registered ? bytes(hex"c0ffee") : bytes(""), proven);
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract LeashGuardTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    LeashGuard guard;
    MockToken usd;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address payable alice = payable(makeAddr("alice"));
    address payable mallory = payable(makeAddr("mallory"));

    function setUp() public {
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0101))); // registered = proven = true
        vm.warp(1_800_000_000);
        guard = new LeashGuard{value: 100 ether}(owner);
        usd = new MockToken();
        usd.mint(address(guard), 1_000e18);
    }

    // ---- helpers

    function mandate(uint64 expiry_, uint128 perTx, uint128 daily) internal view returns (LeashGuard.Mandate memory m) {
        m.agent = agent;
        m.expiry = expiry_;
        m.tokens = new address[](2);
        m.limits = new LeashGuard.TokenLimit[](2);
        m.tokens[0] = address(0);
        m.limits[0] = LeashGuard.TokenLimit(1 ether, 3 ether);
        m.tokens[1] = address(usd);
        m.limits[1] = LeashGuard.TokenLimit(perTx, daily);
        m.recipients = new address[](1);
        m.recipients[0] = alice;
    }

    function sig(LeashGuard.Mandate memory m, uint256 n) internal view returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", guard.mandateMessage(m, n))));
    }

    function arm() internal returns (LeashGuard.Mandate memory m) {
        m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        guard.applyMandate(m, sig(m, 0));
    }

    // ---- agent spending inside the mandate

    function test_startsFrozen() public {
        vm.prank(agent);
        vm.expectRevert(LeashGuard.NotAgent.selector); // no agent until the first mandate
        guard.spend(address(0), alice, 1);
    }

    function test_spendsWithinLimits() public {
        arm();
        vm.startPrank(agent);
        guard.spend(address(usd), alice, 20e18);
        guard.spend(address(0), alice, 1 ether);
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 20e18);
        assertEq(alice.balance, 1 ether);
        assertEq(guard.remainingToday(address(usd)), 30e18);
    }

    function test_perPaymentCap() public {
        arm();
        vm.prank(agent);
        vm.expectRevert(LeashGuard.OverPerTxLimit.selector);
        guard.spend(address(usd), alice, 20e18 + 1);
    }

    function test_dailyCapAndReset() public {
        arm();
        vm.startPrank(agent);
        guard.spend(address(usd), alice, 20e18);
        guard.spend(address(usd), alice, 20e18);
        vm.expectRevert(LeashGuard.OverDailyLimit.selector);
        guard.spend(address(usd), alice, 20e18); // 60 > 50
        vm.warp(block.timestamp + 1 days);
        guard.spend(address(usd), alice, 20e18); // fresh bucket
        vm.stopPrank();
    }

    function test_onlyAllowedRecipients() public {
        arm();
        vm.prank(agent);
        vm.expectRevert(LeashGuard.RecipientNotAllowed.selector);
        guard.spend(address(usd), mallory, 1e18);
    }

    function test_tokenWithoutLimitIsNotSpendable() public {
        arm();
        MockToken other = new MockToken();
        other.mint(address(guard), 100e18);
        vm.prank(agent);
        vm.expectRevert(LeashGuard.TokenNotSpendable.selector);
        guard.spend(address(other), alice, 1e18);
    }

    function test_expiryStopsSpending() public {
        arm();
        vm.warp(block.timestamp + 3 days);
        vm.prank(agent);
        vm.expectRevert(LeashGuard.Expired.selector);
        guard.spend(address(usd), alice, 1e18);
    }

    function test_onlyTheAgentMaySpend() public {
        arm();
        vm.prank(mallory);
        vm.expectRevert(LeashGuard.NotAgent.selector);
        guard.spend(address(usd), alice, 1e18);
        vm.prank(owner); // even the owner's classical key cannot spend
        vm.expectRevert(LeashGuard.NotAgent.selector);
        guard.spend(address(usd), alice, 1e18);
    }

    // ---- the classical key can only stop

    function test_ownerKeyCanFreeze() public {
        arm();
        vm.prank(owner);
        guard.freeze();
        vm.prank(agent);
        vm.expectRevert(LeashGuard.IsFrozen.selector);
        guard.spend(address(usd), alice, 1e18);
    }

    function test_agentCanFreezeItself() public {
        arm();
        vm.prank(agent);
        guard.freeze();
        assertTrue(guard.frozen());
    }

    function test_strangerCannotFreeze() public {
        arm();
        vm.prank(mallory);
        vm.expectRevert(LeashGuard.NotOwnerOrAgent.selector);
        guard.freeze();
    }

    function test_leakedOwnerKeyCannotLoosenOrUnfreeze() public {
        LeashGuard.Mandate memory m = arm();
        vm.prank(owner);
        guard.freeze();
        // The attacker holds the owner's secp256k1 key but cannot produce an ML-DSA-87 signature.
        LeashGuard.Mandate memory greedy = mandate(uint64(block.timestamp + 30 days), 1_000e18, 1_000e18);
        greedy.recipients[0] = mallory;
        vm.prank(owner);
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(greedy, hex"deadbeef");
        bytes memory old = sig(m, 0);
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(m, old); // an old signature does not unfreeze either
        assertTrue(guard.frozen());
    }

    // ---- the post-quantum key starts and loosens

    function test_signedMandateUnfreezesAndReplaces() public {
        LeashGuard.Mandate memory m = arm();
        vm.prank(owner);
        guard.freeze();
        m.expiry = uint64(block.timestamp + 5 days);
        guard.applyMandate(m, sig(m, 1));
        assertFalse(guard.frozen());
        assertEq(guard.nonce(), 2);
    }

    function test_replacingClearsTheOldRecipients() public {
        arm();
        LeashGuard.Mandate memory m2 = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        m2.recipients[0] = mallory;
        guard.applyMandate(m2, sig(m2, 1));
        vm.startPrank(agent);
        vm.expectRevert(LeashGuard.RecipientNotAllowed.selector);
        guard.spend(address(usd), alice, 1e18); // alice was removed
        guard.spend(address(usd), mallory, 1e18);
        vm.stopPrank();
    }

    function test_signatureIsBoundToTheWholeMandate() public {
        LeashGuard.Mandate memory m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        bytes memory s = sig(m, 0);
        m.limits[1].perTx = 21e18; // tampered after signing
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(m, s);
    }

    function test_mandateCannotBeReplayed() public {
        LeashGuard.Mandate memory m = arm();
        bytes memory used = sig(m, 0);
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(m, used); // nonce is now 1
    }

    function test_signatureIsBoundToThisGuard() public {
        LeashGuard other = new LeashGuard(owner);
        LeashGuard.Mandate memory m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        bytes memory foreign = abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", other.mandateMessage(m, 0))));
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(m, foreign);
    }

    function test_signatureIsBoundToTheChain() public {
        LeashGuard.Mandate memory m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        bytes memory s = sig(m, 0);
        vm.chainId(9801);
        vm.expectRevert(LeashGuard.BadPqcSignature.selector);
        guard.applyMandate(m, s);
    }

    function test_rejectsMalformedMandates() public {
        LeashGuard.Mandate memory m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        m.agent = address(0);
        bytes memory s1 = sig(m, 0);
        vm.expectRevert(LeashGuard.BadMandate.selector);
        guard.applyMandate(m, s1);
        m = mandate(uint64(block.timestamp), 20e18, 50e18); // already expired
        bytes memory s2 = sig(m, 0);
        vm.expectRevert(LeashGuard.BadMandate.selector);
        guard.applyMandate(m, s2);
        m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        m.limits = new LeashGuard.TokenLimit[](1); // length mismatch
        bytes memory s3 = sig(m, 0);
        vm.expectRevert(LeashGuard.BadMandate.selector);
        guard.applyMandate(m, s3);
    }

    function test_ownerKeyMustBeRegisteredAndProven() public {
        LeashGuard.Mandate memory m = mandate(uint64(block.timestamp + 3 days), 20e18, 50e18);
        bytes memory s = sig(m, 0);
        MockPqc(PQC_KEYS).set(false, false);
        vm.expectRevert(LeashGuard.OwnerKeyNotRegistered.selector);
        guard.applyMandate(m, s);
        MockPqc(PQC_KEYS).set(true, false);
        vm.expectRevert(LeashGuard.OwnerKeyNotProven.selector);
        guard.applyMandate(m, s);
    }

    // ---- properties

    /// Whatever the agent tries, it can never move more than the daily cap in one bucket.
    function testFuzz_neverExceedsDailyCap(uint8 tries, uint96 amount) public {
        arm();
        uint256 moved;
        vm.startPrank(agent);
        for (uint256 i; i < tries; ++i) {
            try guard.spend(address(usd), alice, amount) {
                moved += amount;
            } catch {}
        }
        vm.stopPrank();
        assertLe(moved, 50e18);
        assertLe(usd.balanceOf(alice), 50e18);
    }
}
