// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IQorePQC} from "./LeashGuard.sol";

/// Decodes one kind of on-chain action (a swap, a wrap, a vault deposit) into the value flow it would cause.
/// `inspect` runs as a STATICCALL from the guard, so `msg.sender` is the guard. Adapters hold no funds and no state.
interface ILeashAdapter {
    struct Flow {
        address tokenIn; // what leaves the guard; address(0) is the native coin
        uint256 amountIn;
        address tokenOut; // what must come back; address(0) is the native coin
        address recipient; // who the call sends tokenOut to; must be the guard
    }

    function inspect(address target, bytes calldata data, uint256 value) external view returns (Flow memory);
}

interface IERC20Ext {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title LeashGuardV2
/// @notice LeashGuard plus guarded on-chain actions. Same one rule: a classical key can only STOP things;
/// starting or loosening anything needs the owner's ML-DSA-87 signature, verified on chain by pqcVerify.
///
/// New in v2: `execute(adapter, target, data, value)` lets the agent swap, wrap or deposit, but only
/// along a ROUTE the owner signed: (adapter, target, tokenIn, tokenOut, minimum output per input).
/// The guard does not trust the call data. It enforces the value flow by measurement:
///  - the input is charged against the same per-payment and daily caps as `spend`;
///  - the output must come back to the guard, and the guard's balance of tokenOut must rise by at least
///    amountIn * minOutPerIn (the owner's rate floor, checked on what was actually received);
///  - no other listed token's balance may fall, and tokenIn may fall by at most amountIn;
///  - approvals are exact and are reset to zero afterwards.
/// There is no price oracle: the floor is the owner's own number. It bounds slippage, not market risk.
contract LeashGuardV2 {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    uint256 public constant MAX_ITEMS = 16;
    uint256 public constant DAY = 1 days;
    uint256 public constant RATE_ONE = 1e18;

    struct TokenLimit {
        uint128 perTx; // maximum per payment or action; 0 means the token may be received but never spent
        uint128 daily; // maximum per 24-hour bucket
    }

    struct Route {
        address adapter;
        address target;
        address tokenIn;
        address tokenOut;
        uint256 minOutPerInE18; // raw units of tokenOut per raw unit of tokenIn, scaled by 1e18; must be > 0
    }

    struct Mandate {
        address agent;
        uint64 expiry;
        address[] tokens; // every token the guard may hold or touch; address(0) is the native coin
        TokenLimit[] limits; // same length as tokens
        address[] recipients; // the only addresses `spend` may pay
        Route[] routes; // the only actions `execute` may perform
    }

    address public immutable owner;

    address public agent;
    uint64 public expiry;
    bool public frozen = true;
    uint256 public nonce;

    mapping(address => TokenLimit) public limitOf;
    mapping(address => bool) public listed;
    mapping(address => bool) public allowedRecipient;
    mapping(address => uint64) public bucketStart;
    mapping(address => uint256) public spentInBucket;
    mapping(bytes32 => uint256) public floorOf; // route key => minOutPerIn; 0 means no such route

    address[] private _tokens;
    address[] private _recipients;
    Route[] private _routes;
    bool private _locked;

    event MandateApplied(uint256 indexed nonce, address indexed agent, uint64 expiry, bytes32 mandateHash);
    event Frozen(address indexed by);
    event Spent(address indexed token, address indexed to, uint256 amount, uint256 spentToday);
    event Executed(
        address indexed adapter, address indexed target, address tokenIn, uint256 amountIn, address tokenOut, uint256 received
    );
    event Deposited(address indexed from, uint256 amount);

    error NotAgent();
    error NotOwnerOrAgent();
    error IsFrozen();
    error Expired();
    error TokenNotSpendable();
    error RecipientNotAllowed();
    error OverPerTxLimit();
    error OverDailyLimit();
    error OwnerKeyNotRegistered();
    error OwnerKeyNotProven();
    error BadPqcSignature();
    error BadMandate();
    error TransferFailed();
    error RouteNotAllowed();
    error OutputNotToGuard();
    error ValueMismatch();
    error TokenNotListed();
    error ZeroAmount();
    error ExecFailed();
    error BadAction();
    error BelowRateFloor();
    error UnexpectedOutflow(address token);
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address owner_) payable {
        owner = owner_;
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- the agent: pay

    function spend(address token, address payable to, uint256 amount) external nonReentrant {
        _agentCan();
        if (!allowedRecipient[to]) revert RecipientNotAllowed();
        uint256 spent = _charge(token, amount);
        emit Spent(token, to, amount, spent);

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Ext.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }

    // ------------------------------------------------------- the agent: guarded actions

    /// Run one action through an owner-signed route. Returns the amount of tokenOut received.
    function execute(address adapter, address target, bytes calldata data, uint256 value)
        external
        nonReentrant
        returns (uint256 received)
    {
        _agentCan();
        if (target == address(this) || target == address(PQC_VERIFY) || target == address(PQC_KEYS)) revert BadAction();

        ILeashAdapter.Flow memory f = _inspect(adapter, target, data, value);
        bytes32 key = _routeKey(adapter, target, f.tokenIn, f.tokenOut);
        uint256 floor = floorOf[key];
        if (floor == 0) revert RouteNotAllowed();
        if (f.recipient != address(this)) revert OutputNotToGuard();
        if (f.amountIn == 0) revert ZeroAmount();
        if (f.tokenIn == address(0) ? value != f.amountIn : value != 0) revert ValueMismatch();
        _charge(f.tokenIn, f.amountIn);

        address[] memory toks = _tokens;
        uint256[] memory before = new uint256[](toks.length);
        for (uint256 i; i < toks.length; ++i) before[i] = _balance(toks[i]);

        if (f.tokenIn != address(0)) _approve(f.tokenIn, target, f.amountIn);
        (bool ok,) = target.call{value: value}(data);
        if (!ok) revert ExecFailed();
        if (f.tokenIn != address(0)) _approve(f.tokenIn, target, 0);

        for (uint256 i; i < toks.length; ++i) {
            uint256 b = before[i];
            uint256 a = _balance(toks[i]);
            if (toks[i] == f.tokenOut) {
                if (a < b) revert UnexpectedOutflow(toks[i]);
                received = a - b;
            } else if (toks[i] == f.tokenIn) {
                if (a < b && b - a > f.amountIn) revert UnexpectedOutflow(toks[i]);
            } else if (a < b) {
                revert UnexpectedOutflow(toks[i]);
            }
        }
        if (received < (f.amountIn * floor) / RATE_ONE) revert BelowRateFloor();
        emit Executed(adapter, target, f.tokenIn, f.amountIn, f.tokenOut, received);
    }

    // ------------------------------------------------- the classical key: stop only

    function freeze() external {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        frozen = true;
        emit Frozen(msg.sender);
    }

    // --------------------------------------- the post-quantum key: start or loosen

    function mandateMessage(Mandate calldata m, uint256 nonce_) public view returns (bytes memory) {
        return abi.encodePacked("LeashGuard:mandate:v2", block.chainid, address(this), nonce_, keccak256(abi.encode(m)));
    }

    function applyMandate(Mandate calldata m, bytes calldata mldsaSignature) external {
        if (
            m.agent == address(0) || m.expiry <= block.timestamp || m.tokens.length != m.limits.length
                || m.tokens.length > MAX_ITEMS || m.recipients.length > MAX_ITEMS || m.routes.length > MAX_ITEMS
        ) revert BadMandate();

        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(owner);
        if (!registered || pubkey.length == 0) revert OwnerKeyNotRegistered();
        if (!proven) revert OwnerKeyNotProven();

        uint256 n = nonce;
        if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, mandateMessage(m, n))) revert BadPqcSignature();
        nonce = n + 1;

        // Clear the previous mandate.
        for (uint256 i; i < _tokens.length; ++i) {
            address t = _tokens[i];
            delete limitOf[t];
            delete listed[t];
            delete spentInBucket[t];
            delete bucketStart[t];
        }
        for (uint256 i; i < _recipients.length; ++i) delete allowedRecipient[_recipients[i]];
        for (uint256 i; i < _routes.length; ++i) {
            Route memory r = _routes[i];
            delete floorOf[_routeKey(r.adapter, r.target, r.tokenIn, r.tokenOut)];
        }
        delete _tokens;
        delete _recipients;
        delete _routes;

        // Apply the new one.
        for (uint256 i; i < m.tokens.length; ++i) {
            address t = m.tokens[i];
            if (listed[t]) revert BadMandate(); // duplicate token
            listed[t] = true;
            limitOf[t] = m.limits[i];
            _tokens.push(t);
        }
        for (uint256 i; i < m.recipients.length; ++i) {
            allowedRecipient[m.recipients[i]] = true;
            _recipients.push(m.recipients[i]);
        }
        for (uint256 i; i < m.routes.length; ++i) {
            Route calldata r = m.routes[i];
            bytes32 key = _routeKey(r.adapter, r.target, r.tokenIn, r.tokenOut);
            if (
                r.adapter == address(0) || r.target == address(0) || r.minOutPerInE18 == 0 || r.tokenIn == r.tokenOut
                    || !listed[r.tokenIn] || !listed[r.tokenOut] || limitOf[r.tokenIn].perTx == 0 || floorOf[key] != 0
            ) revert BadMandate();
            floorOf[key] = r.minOutPerInE18;
            _routes.push(r);
        }
        agent = m.agent;
        expiry = m.expiry;
        frozen = false;
        emit MandateApplied(n, m.agent, m.expiry, keccak256(abi.encode(m)));
    }

    // -------------------------------------------------------------------- views

    function remainingToday(address token) external view returns (uint256) {
        TokenLimit memory lim = limitOf[token];
        if (block.timestamp >= uint256(bucketStart[token]) + DAY) return lim.daily;
        uint256 spent = spentInBucket[token];
        return spent >= lim.daily ? 0 : lim.daily - spent;
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function recipients() external view returns (address[] memory) {
        return _recipients;
    }

    function routes() external view returns (Route[] memory) {
        return _routes;
    }

    // ---------------------------------------------------------------- internals

    function _agentCan() internal view {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert IsFrozen();
        if (block.timestamp >= expiry) revert Expired();
    }

    /// Charge `amount` of `token` against its per-action and daily caps. Returns the bucket total.
    function _charge(address token, uint256 amount) internal returns (uint256 spent) {
        TokenLimit memory lim = limitOf[token];
        if (lim.perTx == 0) revert TokenNotSpendable();
        if (amount > lim.perTx) revert OverPerTxLimit();
        spent = spentInBucket[token];
        if (block.timestamp >= uint256(bucketStart[token]) + DAY) {
            bucketStart[token] = uint64(block.timestamp);
            spent = 0;
        }
        spent += amount;
        if (spent > lim.daily) revert OverDailyLimit();
        spentInBucket[token] = spent;
    }

    function _inspect(address adapter, address target, bytes calldata data, uint256 value)
        internal
        view
        returns (ILeashAdapter.Flow memory)
    {
        try ILeashAdapter(adapter).inspect(target, data, value) returns (ILeashAdapter.Flow memory f) {
            return f;
        } catch {
            revert BadAction();
        }
    }

    function _routeKey(address adapter, address target, address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encode(adapter, target, tokenIn, tokenOut));
    }

    function _balance(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20Ext(token).balanceOf(address(this));
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Ext.approve, (spender, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ExecFailed();
    }
}
