#!/usr/bin/env node
// agent-marketplace-mcp — MCP server exposing agent-marketplace-proxy as Claude/Cursor tools.
//
// Wallet model: CDP-managed (Coinbase Developer Platform).
//   - Private key lives in Coinbase's MPC enclave, never on the user's disk.
//   - The user holds CDP API credentials (api key id + secret + wallet secret) in
//     ~/.agent-marketplace/config.json (chmod 600). Those credentials authorize signing
//     but are not signing keys themselves.
//   - First-run flow: user calls the `wallet_setup` tool, which prompts for the three
//     CDP secrets, creates a server-side EVM wallet, and persists config.
//   - Headless / CI: set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET env vars;
//     the tool resolves env first, file second.
//
// Free tier (`search_try`) works without any wallet setup.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { createWalletClient, http, createPublicClient, formatUnits } from "viem";
import { toAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROXY_URL = process.env.AGENT_MARKETPLACE_URL || "https://agent-marketplace-proxy.vercel.app";
const NETWORK = process.env.X402_NETWORK || "base";
const DEFAULT_ACCOUNT_NAME = process.env.AGENT_MARKETPLACE_ACCOUNT || "agent-marketplace-buyer";
const CONFIG_DIR = process.env.AGENT_MARKETPLACE_CONFIG_DIR || join(homedir(), ".agent-marketplace");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// USDC contract addresses on Base
const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

let _walletClient = null;
let _account = null;
let _fetchWithPay = null;

function chain() {
  return NETWORK === "base-sepolia" ? baseSepolia : base;
}

class SetupRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupRequiredError";
    this.code = "SETUP_REQUIRED";
  }
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const mode = statSync(CONFIG_FILE).mode & 0o777;
    if (mode !== 0o600) {
      console.error(`[agent-marketplace-mcp] warn: ${CONFIG_FILE} mode is ${mode.toString(8)}, expected 600.`);
    }
  } catch {}
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function writeConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

function resolveCreds() {
  const fromEnv = {
    cdpApiKeyId: process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
    cdpWalletSecret: process.env.CDP_WALLET_SECRET,
  };
  const fromFile = readConfig() || {};
  const creds = {
    cdpApiKeyId: fromEnv.cdpApiKeyId || fromFile.cdpApiKeyId,
    cdpApiKeySecret: fromEnv.cdpApiKeySecret || fromFile.cdpApiKeySecret,
    cdpWalletSecret: fromEnv.cdpWalletSecret || fromFile.cdpWalletSecret,
    accountName: fromFile.accountName || DEFAULT_ACCOUNT_NAME,
    cachedAddress: fromFile.address,
  };
  if (!creds.cdpApiKeyId || !creds.cdpApiKeySecret || !creds.cdpWalletSecret) {
    throw new SetupRequiredError(
      "Wallet not configured. Call the `wallet_setup` tool with your CDP API credentials, " +
      "or set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET env vars (headless mode).",
    );
  }
  return creds;
}

async function ensureWallet() {
  if (_fetchWithPay) return { fetchWithPay: _fetchWithPay, account: _account };
  const creds = resolveCreds();
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient({
    apiKeyId: creds.cdpApiKeyId,
    apiKeySecret: creds.cdpApiKeySecret,
    walletSecret: creds.cdpWalletSecret,
  });
  const cdpAccount = await cdp.evm.getOrCreateAccount({ name: creds.accountName });
  _account = toAccount({
    address: cdpAccount.address,
    sign: cdpAccount.sign,
    signMessage: cdpAccount.signMessage,
    signTransaction: cdpAccount.signTransaction,
    signTypedData: cdpAccount.signTypedData,
  });
  _walletClient = createWalletClient({ account: _account, chain: chain(), transport: http() });
  _fetchWithPay = wrapFetchWithPayment(fetch, _walletClient);
  return { fetchWithPay: _fetchWithPay, account: _account };
}

async function usdcBalance(address) {
  try {
    const client = createPublicClient({ chain: chain(), transport: http() });
    const bal = await client.readContract({
      address: USDC[NETWORK] || USDC.base,
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [address],
    });
    return formatUnits(bal, 6);
  } catch (e) {
    return `unknown (${e.message})`;
  }
}

const server = new McpServer({ name: "agent-marketplace", version: "1.0.0" });

server.tool(
  "search_try",
  "Free Google SERP via agent-marketplace-proxy — 5 calls per day, no wallet needed. Use this first to verify the API works for your use case before switching to paid `search`.",
  {
    q: z.string().describe("Search query"),
    location: z.string().default("United States").describe("DataForSEO location_name"),
    num: z.number().int().default(10).describe("Top-N organic results, max 100"),
  },
  async ({ q, location, num }) => {
    const r = await fetch(`${PROXY_URL}/try`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, location, num }),
    });
    const text = await r.text();
    return {
      content: [{ type: "text", text: r.ok ? text : `HTTP ${r.status}: ${text}` }],
      isError: !r.ok,
    };
  },
);

server.tool(
  "search",
  "Google SERP via agent-marketplace-proxy — $0.001 USDC per call on Base, paid automatically from a CDP-managed wallet (Coinbase enclave holds the key, never your disk). Unlimited. Run `wallet_setup` once if you haven't, then `wallet_info` to see the address + fund.",
  {
    q: z.string().describe("Search query"),
    location: z.string().default("United States"),
    num: z.number().int().default(10),
  },
  async ({ q, location, num }) => {
    let fetchWithPay;
    try {
      ({ fetchWithPay } = await ensureWallet());
    } catch (e) {
      return {
        content: [{ type: "text", text: `${e.message}` }],
        isError: true,
      };
    }
    const r = await fetchWithPay(`${PROXY_URL}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, location, num }),
    });
    const text = await r.text();
    return {
      content: [{ type: "text", text: r.ok ? text : `HTTP ${r.status}: ${text}` }],
      isError: !r.ok,
    };
  },
);

server.tool(
  "wallet_setup",
  "One-time setup for the CDP-managed buyer wallet. Get the three values from https://portal.cdp.coinbase.com/projects/api-keys — create an API Key (download JSON; you get `id` and `privateKey`) and a Wallet Secret (separate string). The skill creates a server-side EVM wallet under your CDP project; the private key never leaves Coinbase's enclave.",
  {
    cdp_api_key_id: z.string().describe("CDP API Key ID, looks like 'organizations/.../apiKeys/...'"),
    cdp_api_key_secret: z.string().describe("CDP API Key Secret, the PEM block starting with -----BEGIN PRIVATE KEY-----"),
    cdp_wallet_secret: z.string().describe("CDP Wallet Secret, separate from the API Key Secret (also from the portal)"),
  },
  async ({ cdp_api_key_id, cdp_api_key_secret, cdp_wallet_secret }) => {
    let address;
    try {
      const { CdpClient } = await import("@coinbase/cdp-sdk");
      const cdp = new CdpClient({
        apiKeyId: cdp_api_key_id,
        apiKeySecret: cdp_api_key_secret,
        walletSecret: cdp_wallet_secret,
      });
      const account = await cdp.evm.getOrCreateAccount({ name: DEFAULT_ACCOUNT_NAME });
      address = account.address;
    } catch (e) {
      return {
        content: [{ type: "text", text:
          `CDP error: ${e?.message || e}\n\n` +
          `Common causes:\n` +
          `  - API key secret pasted with line breaks mangled (copy directly from the JSON file)\n` +
          `  - Wallet Secret confused with API Key Secret (two separate strings)\n` +
          `  - API key not enabled for the EVM scope (re-create with default scopes)\n`
        }],
        isError: true,
      };
    }
    writeConfig({
      cdpApiKeyId: cdp_api_key_id,
      cdpApiKeySecret: cdp_api_key_secret,
      cdpWalletSecret: cdp_wallet_secret,
      accountName: DEFAULT_ACCOUNT_NAME,
      address,
      createdAt: new Date().toISOString(),
    });
    // Reset cached singletons so the next `search` call picks up the new creds.
    _account = null;
    _walletClient = null;
    _fetchWithPay = null;
    return {
      content: [{ type: "text", text:
        `✓ CDP authentication OK\n` +
        `✓ Wallet created: ${address}\n` +
        `✓ Saved to ${CONFIG_FILE} (chmod 600, no privkey on disk)\n\n` +
        `Next: call wallet_info to see your address + balance, then fund via Apple Pay.`
      }],
    };
  },
);

server.tool(
  "wallet_info",
  "Show your buyer wallet address (CDP-managed), current USDC balance, and how to fund. Run wallet_setup first if you haven't.",
  {},
  async () => {
    try {
      const { account } = await ensureWallet();
      const bal = await usdcBalance(account.address);
      const netLabel = NETWORK === "base-sepolia" ? "Base Sepolia (testnet)" : "Base (mainnet)";
      const fundHint = NETWORK === "base-sepolia"
        ? `Free testnet USDC: <https://faucet.circle.com> (Base Sepolia).`
        : `Fund with Apple Pay (Coinbase Onramp guest checkout — email + card, no ID for first $500):
  ${PROXY_URL}/fund?addr=${account.address}&amount=5
Or transfer existing USDC on Base directly to the address above (zero KYC).`;
      const text = `Buyer wallet (CDP-managed — Coinbase enclave holds the key)
  Address: ${account.address}
  Network: ${netLabel}
  Balance: ${bal} USDC
  Config:  ${CONFIG_FILE} (chmod 600, no privkey)

Cost: $0.001 per \`search\` call → $1 covers ~1000 calls.
${fundHint}`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: `Wallet error: ${e.message}\n\nFallback: use the free \`search_try\` tool (5/day, no wallet).`,
        }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agent-marketplace-mcp] ready on stdio (network=${NETWORK})`);
