// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// QoreChain precompiles (active on the qorechain-diana testnet).
interface IQorePQC {
    /// ML-DSA-87 (FIPS 204) verification: 2592-byte key, 4627-byte signature, raw message bytes.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);

    /// The ML-DSA-87 key an account registered on chain.
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LeashGuard
/// @notice A spending leash for an AI agent, built on one rule:
///
///   A classical key (secp256k1) can only STOP things. Starting or loosening anything
///   needs an ML-DSA-87 (post-quantum) signature from the owner.
///
/// - The agent holds an ordinary EVM key. It may call `spend` within a mandate:
///   per-token per-payment and per-day caps, a recipient allowlist and an expiry.
/// - The owner's classical key may only `freeze`. If it leaks, the attacker can pause
///   the agent, never grant spending power.
/// - A mandate (new agent, new limits, new recipients, unfreeze) takes effect only with
///   an ML-DSA-87 signature from the owner's key in the chain's key registry. The message
///   binds the chain id, this guard, a nonce and the whole mandate, so it cannot be replayed
///   on another chain or guard, used twice, or altered.
/// - The chain's own rules cannot cap token amounts in an EVM window (a token transfer counts
///   as zero value). This contract closes that gap for the funds it holds.
contract LeashGuard {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    uint256 public constant MAX_ITEMS = 16;
    uint256 public constant DAY = 1 days;

    struct TokenLimit {
        uint128 perTx; // maximum per payment; 0 means the token is not spendable
        uint128 daily; // maximum per 24-hour bucket
    }

    struct Mandate {
        address agent;
        uint64 expiry; // unix seconds; spending stops at this time
        address[] tokens; // address(0) is the native coin
        TokenLimit[] limits; // same length as tokens
        address[] recipients; // the only addresses the agent may pay
    }

    /// The QoreChain account whose registered ML-DSA-87 key authorises mandates.
    address public immutable owner;

    address public agent;
    uint64 public expiry;
    bool public frozen = true; // nothing is spendable until the first signed mandate
    uint256 public nonce;

    mapping(address => TokenLimit) public limitOf;
    mapping(address => bool) public allowedRecipient;
    mapping(address => uint64) public bucketStart;
    mapping(address => uint256) public spentInBucket;

    address[] private _tokens;
    address[] private _recipients;

    event MandateApplied(uint256 indexed nonce, address indexed agent, uint64 expiry, bytes32 mandateHash);
    event Frozen(address indexed by);
    event Spent(address indexed token, address indexed to, uint256 amount, uint256 spentToday);
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

    constructor(address owner_) payable {
        owner = owner_;
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- the agent

    /// Pay `to` up to the mandate's limits. `token == address(0)` pays in the native coin.
    function spend(address token, address payable to, uint256 amount) external {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert IsFrozen();
        if (block.timestamp >= expiry) revert Expired();
        if (!allowedRecipient[to]) revert RecipientNotAllowed();

        TokenLimit memory lim = limitOf[token];
        if (lim.perTx == 0) revert TokenNotSpendable();
        if (amount > lim.perTx) revert OverPerTxLimit();

        uint256 spent = spentInBucket[token];
        if (block.timestamp >= uint256(bucketStart[token]) + DAY) {
            bucketStart[token] = uint64(block.timestamp);
            spent = 0;
        }
        spent += amount;
        if (spent > lim.daily) revert OverDailyLimit();
        spentInBucket[token] = spent;
        emit Spent(token, to, amount, spent);

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }

    // ------------------------------------------------- the classical key: stop only

    /// Pause all spending. Allowed for the owner's classical key or the agent itself.
    /// This can only reduce power, so a leaked classical key cannot do harm with it.
    function freeze() external {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        frozen = true;
        emit Frozen(msg.sender);
    }

    // --------------------------------------- the post-quantum key: start or loosen

    /// The exact bytes the owner signs for the mandate with the current nonce.
    function mandateMessage(Mandate calldata m, uint256 nonce_) public view returns (bytes memory) {
        return abi.encodePacked("LeashGuard:mandate:v1", block.chainid, address(this), nonce_, keccak256(abi.encode(m)));
    }

    /// Replace the whole mandate (and unfreeze). Needs the owner's ML-DSA-87 signature.
    function applyMandate(Mandate calldata m, bytes calldata mldsaSignature) external {
        if (
            m.agent == address(0) || m.expiry <= block.timestamp || m.tokens.length != m.limits.length
                || m.tokens.length > MAX_ITEMS || m.recipients.length > MAX_ITEMS
        ) revert BadMandate();

        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(owner);
        if (!registered || pubkey.length == 0) revert OwnerKeyNotRegistered();
        if (!proven) revert OwnerKeyNotProven();

        uint256 n = nonce;
        if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, mandateMessage(m, n))) revert BadPqcSignature();
        nonce = n + 1;

        // Clear the previous mandate.
        for (uint256 i; i < _tokens.length; ++i) {
            delete limitOf[_tokens[i]];
            delete spentInBucket[_tokens[i]];
            delete bucketStart[_tokens[i]];
        }
        for (uint256 i; i < _recipients.length; ++i) {
            delete allowedRecipient[_recipients[i]];
        }
        delete _tokens;
        delete _recipients;

        // Apply the new one.
        for (uint256 i; i < m.tokens.length; ++i) {
            limitOf[m.tokens[i]] = m.limits[i];
            _tokens.push(m.tokens[i]);
        }
        for (uint256 i; i < m.recipients.length; ++i) {
            allowedRecipient[m.recipients[i]] = true;
            _recipients.push(m.recipients[i]);
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
}
