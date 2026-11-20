// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeashGuardV2} from "../src/LeashGuardV2.sol";
import {UniV2Adapter} from "../src/adapters/UniV2Adapter.sol";
import {MockPqc} from "./LeashGuard.t.sol";
import {MockERC20, MockWETH, MockRouterV2} from "./mocks/Mocks.sol";

/// Fires random sequences of agent, attacker and owner actions at a LeashGuardV2. The invariants below must hold after every step.
contract Handler is Test {
    LeashGuardV2 public guard;
    MockERC20 public usd;
    MockERC20 public ethx;
    MockRouterV2 public router;
    UniV2Adapter public swapAd;
    address public owner;
    address public agent;
    address public alice;
    address public mallory;

    // ghost state
    mapping(uint256 => uint256) public movedInBucket; // bucketStart => USD moved out of the guard by the agent
    uint256 public ghostEthxReceived;
    uint256 public attackerSuccesses; // successful calls by someone who must not be able to do the thing
    uint256 public floorViolations; // successful execute() that received less than the owner's floor
    uint256 public frozenSuccesses; // successful spend or execute while frozen
    uint256 public lastNonce;
    uint256 public calls;
    bool public nonceWentBackwards;

    uint256 constant FLOOR = 0.00049e18;

    constructor(LeashGuardV2 g, MockERC20 u, MockERC20 e, MockRouterV2 r, UniV2Adapter a, address o, address ag, address al, address m) {
        guard = g; usd = u; ethx = e; router = r; swapAd = a; owner = o; agent = ag; alice = al; mallory = m;
    }

    function _swapData(uint256 amountIn, address to) internal view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = address(usd);
        path[1] = address(ethx);
        return abi.encodeWithSignature("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", amountIn, 0, path, to, block.timestamp + 1);
    }

    function _noteBucket(uint256 usdBefore) internal {
        uint256 after_ = usd.balanceOf(address(guard));
        if (after_ < usdBefore) movedInBucket[guard.bucketStart(address(usd))] += usdBefore - after_;
    }

    function agentSpendUsd(uint96 amt) external {
        calls++;
        uint256 a = bound(amt, 1, 150e18);
        bool wasFrozen = guard.frozen();
        uint256 before = usd.balanceOf(address(guard));
        vm.prank(agent);
        try guard.spend(address(usd), payable(alice), a) { if (wasFrozen) frozenSuccesses++; } catch {}
        _noteBucket(before);
    }

    function agentSwap(uint96 amt, uint16 shortBps, bool toAttacker) external {
        calls++;
        uint256 a = bound(amt, 1, 150e18);
        router.setBehaviour(address(0), bound(shortBps, 0, 1000));
        bool wasFrozen = guard.frozen();
        uint256 usdBefore = usd.balanceOf(address(guard));
        uint256 ethxBefore = ethx.balanceOf(address(guard));
        vm.prank(agent);
        try guard.execute(address(swapAd), address(router), _swapData(a, toAttacker ? mallory : address(guard)), 0) returns (uint256 got) {
            if (wasFrozen) frozenSuccesses++;
            if (toAttacker) attackerSuccesses++;
            if (got < (a * FLOOR) / 1e18) floorViolations++;
            ghostEthxReceived += ethx.balanceOf(address(guard)) - ethxBefore;
        } catch {}
        _noteBucket(usdBefore);
    }

    function agentSpendEthx(uint96 amt) external {
        calls++;
        vm.prank(agent);
        try guard.spend(address(ethx), payable(alice), bound(amt, 1, 1e18)) { attackerSuccesses++; } catch {} // a receive-only token must never be spendable
    }

    function agentSpendToAttacker(uint96 amt) external {
        calls++;
        vm.prank(agent);
        try guard.spend(address(usd), payable(mallory), bound(amt, 1, 50e18)) { attackerSuccesses++; } catch {}
    }

    /// Mallory and the owner's classical key try to spend, run actions, or rewrite the mandate.
    function attackerCalls(uint8 who, uint96 amt, bytes calldata junk) external {
        calls++;
        address a = who % 2 == 0 ? mallory : owner;
        vm.startPrank(a);
        try guard.spend(address(usd), payable(a), bound(amt, 1, 50e18)) { attackerSuccesses++; } catch {}
        try guard.execute(address(swapAd), address(router), _swapData(bound(amt, 1, 50e18), address(guard)), 0) { attackerSuccesses++; } catch {}
        LeashGuardV2.Mandate memory m;
        m.agent = a; m.expiry = uint64(block.timestamp + 365 days);
        try guard.applyMandate(m, junk) { attackerSuccesses++; } catch {}
        vm.stopPrank();
    }

    /// Owner, agent and mallory try to freeze: the first two may, mallory may not.
    function freezeAs(uint8 who) external {
        calls++;
        address a = who % 3 == 0 ? owner : who % 3 == 1 ? agent : mallory;
        vm.prank(a);
        try guard.freeze() { if (a == mallory) attackerSuccesses++; } catch {}
    }

    function warp(uint32 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    /// The owner signs a fresh mandate (the stand-in precompile accepts a signature equal to its hash).
    function reArm(uint8 salt) external {
        calls++;
        LeashGuardV2.Mandate memory m = _mandate(uint64(block.timestamp + 3 days), salt);
        bytes memory message = guard.mandateMessage(m, guard.nonce());
        bytes memory sig = abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", message)));
        guard.applyMandate(m, sig);
        if (guard.nonce() < lastNonce) nonceWentBackwards = true;
        lastNonce = guard.nonce();
    }

    function _mandate(uint64 expiry_, uint8 salt) internal view returns (LeashGuardV2.Mandate memory m) {
        m.agent = agent;
        m.expiry = expiry_;
        m.tokens = new address[](3);
        m.limits = new LeashGuardV2.TokenLimit[](3);
        m.tokens[0] = address(0);
        m.limits[0] = LeashGuardV2.TokenLimit(1 ether, 3 ether);
        m.tokens[1] = address(usd);
        m.limits[1] = LeashGuardV2.TokenLimit(100e18, uint128(200e18 + (uint256(salt) % 3) * 50e18));
        m.tokens[2] = address(ethx);
        m.recipients = new address[](1);
        m.recipients[0] = alice;
        m.routes = new LeashGuardV2.Route[](1);
        m.routes[0] = LeashGuardV2.Route(address(swapAd), address(router), address(usd), address(ethx), FLOOR);
    }
}

contract LeashInvariants is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    LeashGuardV2 guard;
    MockERC20 usd;
    MockERC20 ethx;
    MockRouterV2 router;
    Handler handler;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");

    function setUp() public {
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0101)));
        vm.warp(1_800_000_000);
        usd = new MockERC20();
        ethx = new MockERC20();
        MockWETH wqor = new MockWETH();
        router = new MockRouterV2(address(wqor));
        router.setRate(address(usd), address(ethx), 0.0005e18);
        UniV2Adapter ad = new UniV2Adapter();
        guard = new LeashGuardV2{value: 50 ether}(owner);
        usd.mint(address(guard), 100_000e18);
        handler = new Handler(guard, usd, ethx, router, ad, owner, agent, alice, mallory);
        handler.reArm(0); // arm the first mandate
        targetContract(address(handler));
    }

    /// The agent never moves more than the daily cap of USD in one 24-hour bucket (payments and swaps share it).
    function invariant_dailyCapHoldsInEveryBucket() public view {
        // the bucket currently open is the only one that can still grow; older buckets are already settled and were checked as they grew
        uint256 bucket = guard.bucketStart(address(usd));
        (, uint128 daily) = guard.limitOf(address(usd));
        assertLe(handler.movedInBucket(bucket), uint256(daily) + 1, "USD moved in a bucket exceeds the daily cap");
    }

    function invariant_spentCounterNeverExceedsCap() public view {
        (, uint128 daily) = guard.limitOf(address(usd));
        assertLe(guard.spentInBucket(address(usd)), daily);
    }

    function invariant_attackerNeverReceivesFundsOrPower() public view {
        assertEq(handler.attackerSuccesses(), 0, "someone who must not act succeeded");
        assertEq(usd.balanceOf(mallory), 0);
        assertEq(ethx.balanceOf(mallory), 0);
        assertEq(mallory.balance, 0);
    }

    function invariant_noActionSucceedsWhileFrozen() public view {
        assertEq(handler.frozenSuccesses(), 0);
    }

    function invariant_everySwapMetTheOwnersRateFloor() public view {
        assertEq(handler.floorViolations(), 0);
    }

    function invariant_noApprovalIsLeftOpen() public view {
        assertEq(usd.allowance(address(guard), address(router)), 0);
    }

    function invariant_receiveOnlyTokenOnlyGrows() public view {
        assertEq(ethx.balanceOf(address(guard)), handler.ghostEthxReceived(), "the output token moved some other way");
    }

    function invariant_nonceNeverGoesBackwards() public view {
        assertFalse(handler.nonceWentBackwards());
    }
}
