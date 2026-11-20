// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeashGuardV2, ILeashAdapter} from "../src/LeashGuardV2.sol";
import {UniV2Adapter} from "../src/adapters/UniV2Adapter.sol";
import {WrapAdapter} from "../src/adapters/WrapAdapter.sol";
import {Erc4626Adapter} from "../src/adapters/Erc4626Adapter.sol";
import {MockPqc} from "./LeashGuard.t.sol";
import {MockERC20, MockWETH, MockRouterV2, MockVault, ReentrantTarget} from "./mocks/Mocks.sol";

/// Reports a fixed flow, whatever the call data says. Stands in for an adapter for the reentrancy test.
contract FixedFlowAdapter is ILeashAdapter {
    address public tokenOut;
    address public guard;

    constructor(address tokenOut_, address guard_) {
        tokenOut = tokenOut_;
        guard = guard_;
    }

    function inspect(address, bytes calldata, uint256 value) external view returns (Flow memory) {
        return Flow(address(0), value, tokenOut, guard);
    }
}

contract LeashGuardV2Test is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    LeashGuardV2 guard;
    MockERC20 usd;
    MockERC20 ethx;
    MockERC20 idle;
    MockWETH wqor;
    MockRouterV2 router;
    MockVault vault;
    UniV2Adapter swapAd;
    WrapAdapter wrapAd;
    Erc4626Adapter vaultAd;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address payable alice = payable(makeAddr("alice"));
    address mallory = makeAddr("mallory");

    function setUp() public {
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0101)));
        vm.warp(1_800_000_000);

        usd = new MockERC20();
        ethx = new MockERC20();
        idle = new MockERC20();
        wqor = new MockWETH();
        router = new MockRouterV2{value: 1_000 ether}(address(wqor));
        vault = new MockVault(usd);
        swapAd = new UniV2Adapter();
        wrapAd = new WrapAdapter();
        vaultAd = new Erc4626Adapter();
        router.setRate(address(usd), address(ethx), 0.0005e18); // 2000 usd per ethx
        router.setRate(address(wqor), address(usd), 2_000e18); // 1 native = 2000 usd
        router.setRate(address(usd), address(wqor), 0.0005e18); // 2000 usd = 1 native

        guard = new LeashGuardV2{value: 100 ether}(owner);
        usd.mint(address(guard), 1_000e18);
    }

    // ---- helpers

    function route(address ad, address target, address tIn, address tOut, uint256 floor) internal pure returns (LeashGuardV2.Route memory) {
        return LeashGuardV2.Route(ad, target, tIn, tOut, floor);
    }

    function mandate() internal view returns (LeashGuardV2.Mandate memory m) {
        m.agent = agent;
        m.expiry = uint64(block.timestamp + 3 days);
        m.tokens = new address[](5);
        m.limits = new LeashGuardV2.TokenLimit[](5);
        m.tokens[0] = address(0);
        m.limits[0] = LeashGuardV2.TokenLimit(10 ether, 30 ether);
        m.tokens[1] = address(usd);
        m.limits[1] = LeashGuardV2.TokenLimit(100e18, 300e18);
        m.tokens[2] = address(ethx); // receive only
        m.tokens[3] = address(vault); // vault shares
        m.limits[3] = LeashGuardV2.TokenLimit(100e18, 300e18);
        m.tokens[4] = address(idle); // listed, receive only, never touched by any route
        m.recipients = new address[](1);
        m.recipients[0] = alice;
        m.routes = new LeashGuardV2.Route[](7);
        m.routes[0] = route(address(swapAd), address(router), address(usd), address(ethx), 0.00049e18); // usd -> ethx
        m.routes[1] = route(address(swapAd), address(router), address(0), address(usd), 1_900e18); // native -> usd
        m.routes[2] = route(address(vaultAd), address(vault), address(usd), address(vault), 0.99e18); // deposit
        m.routes[3] = route(address(vaultAd), address(vault), address(vault), address(usd), 0.99e18); // redeem
        m.routes[4] = route(address(swapAd), address(router), address(vault), address(ethx), 0.00049e18); // shares -> ethx (unused)
        m.routes[5] = route(address(swapAd), address(router), address(usd), address(vault), 1); // never used
        m.routes[6] = route(address(swapAd), address(router), address(vault), address(usd), 1); // never used
    }

    function sig(LeashGuardV2.Mandate memory m, uint256 n) internal view returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", guard.mandateMessage(m, n))));
    }

    function arm() internal returns (LeashGuardV2.Mandate memory m) {
        m = mandate();
        guard.applyMandate(m, sig(m, 0));
    }

    function pathOf(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function swapUsdForEthx(uint256 amountIn, address to) internal view returns (bytes memory) {
        return abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", amountIn, 0, pathOf(address(usd), address(ethx)), to, block.timestamp + 1
        );
    }

    // ---- swaps

    function test_swapTokensForTokens_withinMandate() public {
        arm();
        vm.prank(agent);
        uint256 got = guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        assertEq(got, 0.05e18);
        assertEq(ethx.balanceOf(address(guard)), 0.05e18);
        assertEq(usd.balanceOf(address(guard)), 900e18);
        assertEq(usd.allowance(address(guard), address(router)), 0, "approval reset");
        assertEq(guard.remainingToday(address(usd)), 200e18);
    }

    function test_noApprovalIsLeftOpen_evenIfTheRouterPullsLess() public {
        arm();
        router.setPull(5_000); // the router only takes half of what was approved
        vm.prank(agent);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        assertEq(usd.allowance(address(guard), address(router)), 0, "leftover allowance must be reset to zero");
        assertEq(usd.balanceOf(address(guard)), 950e18);
    }

    function test_swapNativeForTokens() public {
        arm();
        bytes memory data = abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)", 0, pathOf(address(wqor), address(usd)), address(guard), block.timestamp + 1
        );
        vm.prank(agent);
        uint256 got = guard.execute(address(swapAd), address(router), data, 2 ether);
        assertEq(got, 4_000e18);
        assertEq(address(guard).balance, 98 ether);
    }

    function test_swapTokensForNative_needsRoute() public {
        arm(); // no usd -> native route in this mandate
        bytes memory data = abi.encodeWithSignature(
            "swapExactTokensForETH(uint256,uint256,address[],address,uint256)", 100e18, 0, pathOf(address(usd), address(wqor)), address(guard), block.timestamp + 1
        );
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.RouteNotAllowed.selector);
        guard.execute(address(swapAd), address(router), data, 0);
    }

    function test_rateFloorIsEnforcedOnWhatWasReceived() public {
        arm();
        router.setBehaviour(address(0), 500); // router quietly under-delivers by 5 percent: 0.0475 < floor
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BelowRateFloor.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        router.setBehaviour(address(0), 100); // 1 percent short is inside the owner's 2 percent floor
        vm.prank(agent);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
    }

    function test_outputMustGoToTheGuard() public {
        arm();
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.OutputNotToGuard.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, mallory), 0);
    }

    function test_routerThatDivertsOutputIsCaughtByMeasurement() public {
        arm();
        router.setBehaviour(mallory, 0); // calldata says guard, router pays mallory: received is zero
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BelowRateFloor.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        assertEq(ethx.balanceOf(mallory), 0, "reverted: nothing left the guard");
        assertEq(usd.balanceOf(address(guard)), 1_000e18);
    }

    function test_capsApplyToActions_andShareTheBucketWithSpend() public {
        arm();
        vm.startPrank(agent);
        vm.expectRevert(LeashGuardV2.OverPerTxLimit.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18 + 1, address(guard)), 0);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        guard.spend(address(usd), alice, 100e18);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(100e18, address(guard)), 0);
        vm.expectRevert(LeashGuardV2.OverDailyLimit.selector); // 300 used across swaps and a payment
        guard.spend(address(usd), alice, 1);
        vm.stopPrank();
    }

    function test_unknownRouterOrAdapterIsNotARoute() public {
        arm();
        MockRouterV2 other = new MockRouterV2(address(wqor));
        other.setRate(address(usd), address(ethx), 1e18);
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.RouteNotAllowed.selector);
        guard.execute(address(swapAd), address(other), swapUsdForEthx(10e18, address(guard)), 0);
    }

    function test_unsupportedCallDataIsRefused() public {
        arm();
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BadAction.selector);
        guard.execute(address(swapAd), address(router), abi.encodeWithSignature("setRate(address,address,uint256)", usd, ethx, 1), 0);
    }

    function test_valueMustMatchNativeInput() public {
        arm();
        bytes memory data = abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)", 0, pathOf(address(wqor), address(usd)), address(guard), block.timestamp + 1
        );
        // The adapter reads the input amount from `value`, so a mismatch cannot even be expressed; a zero value is refused.
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.ZeroAmount.selector);
        guard.execute(address(swapAd), address(router), data, 0);
    }

    // ---- wrap, unwrap

    function test_wrapAndUnwrap() public {
        LeashGuardV2.Mandate memory m = mandate();
        // swap the unused routes for wrap and unwrap
        m.tokens[4] = address(wqor);
        m.limits[4] = LeashGuardV2.TokenLimit(10 ether, 30 ether);
        m.routes[5] = route(address(wrapAd), address(wqor), address(0), address(wqor), 1e18);
        m.routes[6] = route(address(wrapAd), address(wqor), address(wqor), address(0), 1e18);
        guard.applyMandate(m, sig(m, 0));
        vm.startPrank(agent);
        guard.execute(address(wrapAd), address(wqor), abi.encodeWithSignature("deposit()"), 5 ether);
        assertEq(wqor.balanceOf(address(guard)), 5 ether);
        assertEq(address(guard).balance, 95 ether);
        guard.execute(address(wrapAd), address(wqor), abi.encodeWithSignature("withdraw(uint256)", 3 ether), 0);
        assertEq(wqor.balanceOf(address(guard)), 2 ether);
        assertEq(address(guard).balance, 98 ether);
        vm.stopPrank();
    }

    function test_ethSentWithATokenInputIsRefused() public {
        LeashGuardV2.Mandate memory m = mandate();
        m.tokens[4] = address(wqor);
        m.limits[4] = LeashGuardV2.TokenLimit(10 ether, 30 ether);
        m.routes[5] = route(address(wrapAd), address(wqor), address(0), address(wqor), 1e18);
        m.routes[6] = route(address(wrapAd), address(wqor), address(wqor), address(0), 1e18);
        guard.applyMandate(m, sig(m, 0));
        vm.startPrank(agent);
        guard.execute(address(wrapAd), address(wqor), abi.encodeWithSignature("deposit()"), 5 ether);
        vm.expectRevert(LeashGuardV2.ValueMismatch.selector); // unwrap is a token input: no native value may ride along
        guard.execute(address(wrapAd), address(wqor), abi.encodeWithSignature("withdraw(uint256)", 1 ether), 1 ether);
        vm.stopPrank();
    }

    // ---- vault

    function test_vaultDepositAndRedeem() public {
        arm();
        vm.startPrank(agent);
        guard.execute(address(vaultAd), address(vault), abi.encodeWithSignature("deposit(uint256,address)", 100e18, address(guard)), 0);
        assertEq(vault.balanceOf(address(guard)), 100e18);
        guard.execute(address(vaultAd), address(vault), abi.encodeWithSignature("redeem(uint256,address,address)", 50e18, address(guard), address(guard)), 0);
        assertEq(vault.balanceOf(address(guard)), 50e18);
        assertEq(usd.balanceOf(address(guard)), 950e18);
        vm.stopPrank();
    }

    function test_vaultRefusesSharesRedeemedFromSomeoneElse() public {
        arm();
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BadAction.selector);
        guard.execute(address(vaultAd), address(vault), abi.encodeWithSignature("redeem(uint256,address,address)", 1e18, address(guard), mallory), 0);
    }

    function test_vaultThatSkimsDepositsIsCaught() public {
        arm();
        vault.setRates(0.5e18, 1e18); // 50 shares for 100 assets, below the 0.99 floor
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BelowRateFloor.selector);
        guard.execute(address(vaultAd), address(vault), abi.encodeWithSignature("deposit(uint256,address)", 100e18, address(guard)), 0);
    }

    // ---- who may call, and when

    function test_onlyTheAgent_notFrozen_notExpired() public {
        arm();
        bytes memory d = swapUsdForEthx(10e18, address(guard));
        vm.prank(owner);
        vm.expectRevert(LeashGuardV2.NotAgent.selector);
        guard.execute(address(swapAd), address(router), d, 0);
        vm.prank(mallory);
        vm.expectRevert(LeashGuardV2.NotAgent.selector);
        guard.execute(address(swapAd), address(router), d, 0);
        vm.prank(owner);
        guard.freeze();
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.IsFrozen.selector);
        guard.execute(address(swapAd), address(router), d, 0);
    }

    function test_expiryStopsActions() public {
        arm();
        vm.warp(block.timestamp + 3 days);
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.Expired.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(10e18, address(guard)), 0);
    }

    function test_cannotTargetTheGuardOrPrecompiles() public {
        arm();
        vm.startPrank(agent);
        vm.expectRevert(LeashGuardV2.BadAction.selector);
        guard.execute(address(swapAd), address(guard), swapUsdForEthx(1, address(guard)), 0);
        vm.expectRevert(LeashGuardV2.BadAction.selector);
        guard.execute(address(swapAd), PQC_VERIFY, swapUsdForEthx(1, address(guard)), 0);
        vm.stopPrank();
    }

    function test_reentrancyIsBlocked() public {
        LeashGuardV2.Mandate memory m = mandate();
        ReentrantTarget evil = new ReentrantTarget();
        FixedFlowAdapter fixedAd = new FixedFlowAdapter(address(usd), address(guard));
        m.routes[5] = route(address(fixedAd), address(evil), address(0), address(usd), 1);
        guard.applyMandate(m, sig(m, 0));
        evil.setup(address(guard), abi.encodeCall(LeashGuardV2.freeze, ()));
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.ExecFailed.selector); // the target calls back into the guard: it is neither the owner nor the agent
        guard.execute(address(fixedAd), address(evil), abi.encodeWithSignature("deposit()"), 1 ether);
        evil.setup(address(guard), abi.encodeCall(LeashGuardV2.execute, (address(fixedAd), address(evil), abi.encodeWithSignature("deposit()"), 1 ether)));
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.ExecFailed.selector); // reentering execute hits the lock (and is not the agent either)
        guard.execute(address(fixedAd), address(evil), abi.encodeWithSignature("deposit()"), 1 ether);
    }

    // ---- the mandate and the post-quantum key

    function test_mandateNeedsTheOwnersPqSignature() public {
        LeashGuardV2.Mandate memory m = mandate();
        vm.expectRevert(LeashGuardV2.BadPqcSignature.selector);
        guard.applyMandate(m, hex"deadbeef");
        // a signature for the v1 domain or another guard does not work either
        bytes memory wrong = abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", abi.encodePacked("LeashGuard:mandate:v1", block.chainid, address(guard), uint256(0), keccak256(abi.encode(m))))));
        vm.expectRevert(LeashGuardV2.BadPqcSignature.selector);
        guard.applyMandate(m, wrong);
    }

    function test_agentCannotLoosenRoutes() public {
        arm();
        LeashGuardV2.Mandate memory m = mandate();
        m.routes[5] = route(address(swapAd), address(router), address(usd), address(ethx), 1); // a duplicate, much looser floor
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.BadPqcSignature.selector);
        guard.applyMandate(m, hex"00");
    }

    function test_replacingTheMandateClearsOldRoutes() public {
        arm();
        LeashGuardV2.Mandate memory m = mandate();
        m.routes = new LeashGuardV2.Route[](1);
        m.routes[0] = route(address(vaultAd), address(vault), address(usd), address(vault), 0.99e18);
        guard.applyMandate(m, sig(m, 1));
        vm.prank(agent);
        vm.expectRevert(LeashGuardV2.RouteNotAllowed.selector);
        guard.execute(address(swapAd), address(router), swapUsdForEthx(10e18, address(guard)), 0);
        assertEq(guard.routes().length, 1);
    }

    function test_badRoutesAreRefusedAtApply() public {
        LeashGuardV2.Mandate memory m = mandate();
        m.routes[0].minOutPerInE18 = 0; // a zero floor would allow any rate
        bytes memory s1 = sig(m, 0);
        vm.expectRevert(LeashGuardV2.BadMandate.selector);
        guard.applyMandate(m, s1);

        m = mandate();
        m.routes[0].tokenOut = address(0xBEEF); // not a listed token
        bytes memory s2 = sig(m, 0);
        vm.expectRevert(LeashGuardV2.BadMandate.selector);
        guard.applyMandate(m, s2);

        m = mandate();
        m.routes[1] = m.routes[0]; // duplicate route
        bytes memory s3 = sig(m, 0);
        vm.expectRevert(LeashGuardV2.BadMandate.selector);
        guard.applyMandate(m, s3);

        m = mandate();
        m.routes[0].tokenIn = address(ethx); // input token that can never be spent
        bytes memory s4 = sig(m, 0);
        vm.expectRevert(LeashGuardV2.BadMandate.selector);
        guard.applyMandate(m, s4);
    }

    // ---- invariant under random swaps and payments: the daily cap is never exceeded

    function testFuzz_dailyCapHoldsAcrossActions(uint96[8] calldata amounts, uint8[8] calldata kinds) public {
        arm();
        uint256 moved;
        vm.startPrank(agent);
        for (uint256 i; i < 8; ++i) {
            uint256 a = bound(amounts[i], 1, 120e18);
            bool doSwap = kinds[i] % 2 == 0;
            uint256 beforeBal = usd.balanceOf(address(guard));
            if (doSwap) {
                try guard.execute(address(swapAd), address(router), swapUsdForEthx(a, address(guard)), 0) {} catch {}
            } else {
                try guard.spend(address(usd), alice, a) {} catch {}
            }
            moved += beforeBal - usd.balanceOf(address(guard));
        }
        vm.stopPrank();
        assertLe(moved, 300e18, "never more than the daily cap");
    }
}
