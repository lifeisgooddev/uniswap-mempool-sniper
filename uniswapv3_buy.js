"use strict";
const env = require("dotenv");
const result = env.config();

if (result.error) {
  throw result.error;
}

const ethers = require("ethers");
const retry = require("async-retry");
const { abi: V3RouterABI } = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");

const token = process.env.TARGET_TOKEN;

const tokens = {
  router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  purchaseAmount: process.env.PURCHASEAMOUNT || "0.01",
  pair: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token],
  GASLIMIT: process.env.GASLIMIT || "1000000",
  GASPRICE: process.env.GASPRICE || "5",
  buyDelay: 1,
  buyRetries: 3,
  retryMinTimeout: 250,
  retryMaxTimeout: 3000,
  deadline: 60,
};

const purchaseAmount = ethers.parseUnits(tokens.purchaseAmount, "ether");
const EXPECTED_PONG_BACK = 30000;
const KEEP_ALIVE_CHECK_INTERVAL = 15000;

let pingTimeout = null;
let keepAliveInterval = null;
let provider;
let wallet;
let account;
let router;
let grasshopper;

const GLOBAL_CONFIG = {
  NODE_WSS: process.env.NODE_WSS || "wss://bsc-ws-node.nariox.org:443",
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  RECIPIENT: process.env.RECIPIENT,
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

async function Wait(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

const startConnection = () => {
  provider = new ethers.WebSocketProvider(GLOBAL_CONFIG.NODE_WSS);
  wallet = new ethers.Wallet(GLOBAL_CONFIG.PRIVATE_KEY);
  account = wallet.connect(provider);
  router = new ethers.Contract(tokens.router, V3RouterABI, account);
  grasshopper = 0;

  provider.websocket.on("open", () => {
    console.log(`Sniping has started. Watching the txpool for events for token ${token}...`);
    tokens.router = ethers.getAddress(tokens.router);
    keepAliveInterval = setInterval(() => {
      provider._websocket.ping();
      pingTimeout = setTimeout(() => {
        provider._websocket.terminate();
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
            if (tx.to === tokens.router) {
              const re1 = new RegExp("^0xf305d719");
              if (re1.test(tx.data)) {
                const decodedInput = V3RouterABI.parseTransaction({
                  data: tx.data,
                  value: tx.value,
                });
                if (ethers.getAddress(pair[1]) === decodedInput.args[0]) {
                  provider.off("pending");
                  await Wait(tokens.buyDelay);
                  await BuyToken(tx);
                }
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

const BuyToken = async (txLP) => {
  const tx = await retry(
    async () => {
      const amountOutMin = 0;
      let buyConfirmation = await router.swapExactETHForTokens(
        amountOutMin,
        tokens.pair,
        process.env.RECIPIENT,
        Date.now() + 1000 * tokens.deadline,
        {
          value: tokens.purchaseAmount,
          gasLimit: tokens.gasLimit,
          gasPrice: ethers.utils.parseUnits(tokens.gasPrice, "gwei"),
        }
      );
      return buyConfirmation;
    },
    {
      retries: tokens.buyRetries,
      minTimeout: tokens.retryMinTimeout,
      maxTimeout: tokens.retryMaxTimeout,
      onRetry: (err, number) => {
        console.log("Buy Failed - Retrying", number);
        console.log("Error", err);
        if (number === tokens.buyRetries) {
          console.log("Sniping has failed...");
          process.exit();
        }
      },
    }
  );
  console.log("Associated LP Event txHash: " + txLP.hash);
  console.log("Your [pending] txHash: " + tx.hash);
  process.exit();
};
startConnection();
