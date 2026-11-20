// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 a) public {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function transfer(address to, uint256 a) public returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function approve(address s, uint256 a) public returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address from, address to, uint256 a) public returns (bool) {
        allowance[from][msg.sender] -= a;
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }

    function burn(address from, uint256 a) internal {
        balanceOf[from] -= a;
        totalSupply -= a;
    }
}

/// WETH9-style wrapped native token.
contract MockWETH is MockERC20 {
    function deposit() external payable {
        mint(msg.sender, msg.value);
    }

    function withdraw(uint256 a) external {
        burn(msg.sender, a);
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "send");
    }

    receive() external payable {
        mint(msg.sender, msg.value);
    }
}

/// Uniswap-V2-style router with a fixed, settable rate per pair (output per input, scaled by 1e18).
/// Mints the output token, so it never runs out. `divertTo` sends output elsewhere; `shortBps` under-delivers.
contract MockRouterV2 {
    address public immutable weth;
    mapping(address => mapping(address => uint256)) public rate;
    address public divertTo;
    uint256 public shortBps;
    uint256 public pullBps = 10_000; // share of amountIn the router actually pulls from the caller

    constructor(address weth_) payable {
        weth = weth_;
    }

    function setRate(address a, address b, uint256 r) external {
        rate[a][b] = r;
    }

    function setBehaviour(address divertTo_, uint256 shortBps_) external {
        divertTo = divertTo_;
        shortBps = shortBps_;
    }

    function setPull(uint256 bps) external {
        pullBps = bps;
    }

    function _out(uint256 amountIn, address[] memory path) internal view returns (uint256 out) {
        out = (amountIn * rate[path[0]][path[path.length - 1]]) / 1e18;
        out = out - (out * shortBps) / 10_000;
    }

    function _dest(address to) internal view returns (address) {
        return divertTo == address(0) ? to : divertTo;
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory amounts)
    {
        MockERC20(path[0]).transferFrom(msg.sender, address(this), (amountIn * pullBps) / 10_000);
        uint256 out = _out(amountIn, path);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20(path[path.length - 1]).mint(_dest(to), out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        require(path[0] == weth, "INVALID_PATH");
        uint256 out = _out(msg.value, path);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT");
        MockERC20(path[path.length - 1]).mint(_dest(to), out);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = out;
    }

    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory amounts)
    {
        require(path[path.length - 1] == weth, "INVALID_PATH");
        MockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = _out(amountIn, path);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT");
        (bool ok,) = _dest(to).call{value: out}("");
        require(ok, "send");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    receive() external payable {}
}

/// ERC-4626-style vault: shares are an ERC-20; fixed assets-per-share and shares-per-asset rates (1e18 scaled).
contract MockVault is MockERC20 {
    MockERC20 public immutable assetToken;
    uint256 public sharesPerAsset = 1e18;
    uint256 public assetsPerShare = 1e18;
    address public divertTo;

    constructor(MockERC20 asset_) {
        assetToken = asset_;
    }

    function setRates(uint256 s, uint256 a) external {
        sharesPerAsset = s;
        assetsPerShare = a;
    }

    function setDivert(address d) external {
        divertTo = d;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        assetToken.transferFrom(msg.sender, address(this), assets);
        shares = (assets * sharesPerAsset) / 1e18;
        mint(divertTo == address(0) ? receiver : divertTo, shares);
    }

    function redeem(uint256 shares, address receiver, address from) external returns (uint256 assets) {
        require(from == msg.sender, "no allowance model in mock");
        burn(from, shares);
        assets = (shares * assetsPerShare) / 1e18;
        assetToken.mint(divertTo == address(0) ? receiver : divertTo, assets);
    }
}

/// Calls back into the guard while it runs, to test the reentrancy lock.
contract ReentrantTarget {
    address public guard;
    bytes public payload;

    function setup(address g, bytes calldata p) external {
        guard = g;
        payload = p;
    }

    function deposit() external payable {
        (bool ok,) = guard.call(payload);
        require(ok, "reenter failed");
    }
}

/// A configurable stand-in for the key registry and verifier, to test the owner-key checks individually.
contract MockKeyRegistry {
    bool public registered = true;
    bool public proven = true;
    bytes public pubkey = hex"c0ffee";

    function set(bool registered_, bool proven_, bytes calldata pubkey_) external {
        registered = registered_;
        proven = proven_;
        pubkey = pubkey_;
    }

    function pqcVerify(bytes calldata pk, bytes calldata signature, bytes calldata message) external pure returns (bool) {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(abi.encodePacked("ok", pk, message))));
    }

    function pqcKeyStatus(address) external view returns (bool, uint8, bytes memory, bool) {
        return (registered, 1, pubkey, proven);
    }
}

/// transfer and approve report failure by returning false.
contract FalseToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function approve(address, uint256) external pure returns (bool) { return false; }
}

/// USDT-style: transfer and approve return nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
}

/// transfer and approve revert.
contract RevertingToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address, uint256) external pure { revert("no"); }
    function approve(address, uint256) external pure { revert("no"); }
}

/// A token whose reported balance can be quietly reduced by anyone (a rebasing or fee-on-transfer token gone wrong).
contract ShrinkingToken {
    mapping(address => uint256) private raw;
    mapping(address => uint256) public shrunk;
    mapping(address => mapping(address => uint256)) public allowance;
    function balanceOf(address a) external view returns (uint256) { return raw[a] > shrunk[a] ? raw[a] - shrunk[a] : 0; }
    function mint(address to, uint256 a) external { raw[to] += a; }
    function shrink(address a, uint256 n) external { shrunk[a] += n; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { raw[msg.sender] -= a; raw[to] += a; return true; }
}

/// Mints output to the guard and (optionally) shrinks one token's balance for the guard while it runs.
contract ShrinkTarget {
    function run(address outToken, address guard, uint256 mintAmount, address shrinkToken, uint256 shrinkAmount) external payable {
        ShrinkingToken(outToken).mint(guard, mintAmount);
        if (shrinkToken != address(0)) ShrinkingToken(shrinkToken).shrink(guard, shrinkAmount);
    }
}

/// Mints a plain ERC-20 to the guard and ignores the input.
contract MintTarget {
    function run(address outToken, address to, uint256 amount) external payable {
        MockERC20(outToken).mint(to, amount);
    }
}

contract RejectingRecipient {
    receive() external payable { revert("no thanks"); }
}

/// An agent that is a contract: when paid, it tries to call the guard again. The guard's lock must stop it.
contract ReentrantAgent {
    address public guard;
    bytes4 public sawError;
    bool public tried;

    function setGuard(address g) external { guard = g; }

    function pay(address token, address to, uint256 amount) external {
        (bool ok,) = guard.call(abi.encodeWithSignature("spend(address,address,uint256)", token, to, amount));
        require(ok, "outer spend failed");
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        (bool ok, bytes memory ret) = guard.call(abi.encodeWithSignature("spend(address,address,uint256)", address(0), address(this), 1));
        if (!ok && ret.length >= 4) sawError = bytes4(ret);
    }
}
