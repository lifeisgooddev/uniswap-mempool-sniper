"use strict";
const env = require("dotenv");
const result = env.config();
if (result.error) {
  throw result.error;
}
const ethers = require("ethers");
const { BigNumber } = require("@ethersproject/bignumber");

const token = process.env.TARGET_TOKEN;

const { abi: Quoter } = require("@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json");
const { abi: QuoterV2ABI } = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
const { abi: PoolABI } = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const { abi: FactoryABI } = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const { abi: V3RouterABI } = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");

const ERC20ABI = require("./erc20.json");
const WETHABI = require("./weth.json");

const UNISWAPV3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const getAbi = (address) => (address === WETH_ADDRESS ? WETHABI : ERC20ABI);

function sqrtToPrice(sqrt, decimals0, decimals1, token0IsInput = true) {
  const numerator = sqrt ** 2;
  const denominator = 2 ** 192;
  let ratio = numerator / denominator;
  const shiftDecimals = Math.pow(10, Number(decimals0) - Number(decimals1));
  ratio *= shiftDecimals;
  if (!token0IsInput) {
    ratio = 1 / ratio;
  }
  return ratio;
}

const EXPECTED_PONG_BACK = process.env.KEEP_ALIVE_CHECK_INTERVAL || 30000;
const KEEP_ALIVE_CHECK_INTERVAL = process.env.KEEP_ALIVE_CHECK_INTERVAL || 15000;

let pingTimeout = null,
  keepAliveInterval = null,
  jsonProvider,
  provider,
  wallet,
  account,
  router,
  factory,
  grasshopper;

const GLOBAL_CONFIG = {
  NODE_WSS: process.env.NODE_WSS,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  RECIPIENT: process.env.RECIPIENT,
  INFURA_URL: process.env.INFURA_URL,
};

if (!token) {
  throw "No token has been specified. Please specify in .env.";
}

if (!GLOBAL_CONFIG.PRIVATE_KEY) {
  throw "The private key was not found in .env. Enter the private key in .env.";
}

if (!GLOBAL_CONFIG.RECIPIENT) {
  throw "The public address (RECIPIENT) was not found in .env. Enter your public address in .env.";
}

const startConnection = () => {
  jsonProvider = new ethers.JsonRpcProvider(GLOBAL_CONFIG.INFURA_URL);
  provider = new ethers.WebSocketProvider(GLOBAL_CONFIG.NODE_WSS);
  wallet = new ethers.Wallet(GLOBAL_CONFIG.PRIVATE_KEY);
  account = wallet.connect(provider);
  factory = new ethers.Contract(FACTORY_ADDRESS, FactoryABI, account);
  router = new ethers.Contract(UNISWAPV3_ROUTER, V3RouterABI, account);
  grasshopper = 0;

  provider.websocket.on("open", () => {
    console.log(`Sniping has started. Watching the mempool for events for token ${token}...`);
    keepAliveInterval = setInterval(() => {
      provider.websocket.ping();
      pingTimeout = setTimeout(() => {
        provider.websocket.terminate();
      }, EXPECTED_PONG_BACK);
    }, KEEP_ALIVE_CHECK_INTERVAL);

    provider.on("pending", async (txHash) => {
      provider
        .getTransaction(txHash)
        .then(async (tx) => {
          if (grasshopper === 0) {
            console.log("Still watching... Please wait.");
            grasshopper = 1;
          }
          if (tx && tx.to) {
            if (ethers.getAddress(tx.to) === ethers.getAddress(UNISWAPV3_ROUTER)) {
              try {
                // Get data slice in Hex
                const dataSlice = ethers.dataSlice(tx.data, 4);

                // Ensure desired data length, 522 meaning buy tx, 1162 meaning sell tx
                if (tx.data.length === 522) {
                  const abiCoder = new ethers.AbiCoder();
                  // Decode data
                  // first param: [tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, deadline]
                  const decoded = abiCoder.decode(
                    ["address", "address", "uint24", "address", "uint256", "uint256", "uint256", "uint160"],
                    dataSlice
                  );

                  // if (ethers.getAddress(decoded[1]) !== ethers.getAddress(token)) {
                  //   return ;
                  // }

                  // params: token_in, token_out, fee
                  const poolAddress = await factory.getPool(decoded[0], decoded[1], decoded[2]);
                  console.log(`${tx.data.length === 522 ? "Buy" : "Sell"} transaction dected`);
                  console.log("detected Pool address: ", poolAddress);
                  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);
                  const slot0 = await poolContract.slot0();
                  const sqrtPriceX96 = slot0.sqrtPriceX96;

                  const token0 = await poolContract.token0();
                  const token1 = await poolContract.token1();

                  const token0IsInput = decoded[0] === token0;

                  const tokenInAbi = getAbi(decoded[0]);
                  const tokenOutAbi = getAbi(decoded[1]);

                  // Log decoded data
                  console.log("Open Transaction: ", tx.hash);
                  console.log(decoded);

                  const tokenInContract = new ethers.Contract(decoded[0], tokenInAbi, provider);
                  const tokenOutContract = new ethers.Contract(decoded[1], tokenOutAbi, provider);

                  const decimalsIn = await tokenInContract.decimals();
                  const decimalsOut = await tokenOutContract.decimals();

                  const amountOut = Number(ethers.formatUnits(decoded[5], decimalsOut));
                  const amountInMax = Number(ethers.formatUnits(decoded[6], decimalsIn));

                  const quoter = new ethers.Contract(QUOTER2_ADDRESS, QuoterV2ABI, provider);
                  const params = {
                    tokenIn: decoded[0],
                    tokenOut: decoded[1],
                    fee: decoded[2],
                    amountIn: decoded[4],
                    sqrtPriceLimitX96: "0",
                  };
                  const quote = await quoter.getFunction("quoteExactInputSingle").staticCall(params);
                  const sqrtPriceX96After = quote.sqrtPriceX96After;

                  const price = sqrtToPrice(
                    parseFloat(ethers.formatEther(sqrtPriceX96)),
                    decimalsIn,
                    decimalsOut,
                    token0IsInput
                  );
                  const priceAfter = sqrtToPrice(
                    parseFloat(ethers.formatEther(sqrtPriceX96After)),
                    decimalsIn,
                    decimalsOut,
                    token0IsInput
                  );

                  console.log("price", price);
                  console.log("priceAfter", priceAfter);

                  const absoluteChange = price - priceAfter;
                  const percentChange = absoluteChange / price;
                  console.log("percent change ", (percentChange * 100).toFixed(3), "%");
                }
              } catch (error) {
                console.log(error);
              }
            }
          }
        })
        .catch(() => {});
    });
  });

  provider.websocket.on("close", () => {
    console.log("WebSocket Closed. Reconnecting...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider.websocket.on("error", () => {
    console.log("Error. Attemptiing to Reconnect...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider.websocket.on("pong", () => {
    clearInterval(pingTimeout);
  });
};

startConnection();
