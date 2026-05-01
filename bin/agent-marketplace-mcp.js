#!/usr/bin/env node
// agent-marketplace-mcp — MCP server exposing agent-marketplace-proxy as Claude/Cursor tools.
//
// Two wallet modes:
//
//   1. LOCAL (default, zero config):
//        - Private key auto-generated on first run, stored at ~/.agent-marketplace/wallet.json (chmod 600).
//        - User just runs `wallet_info`, funds the printed address with USDC on Base, done.
//        - Suitable as a "petty cash" hot wallet ($1–$10 of USDC).
//
//   2. CDP (opt-in, set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET):
//        - Private key held by Coinbase Developer Platform; you never see it.
//        - Better for teams / audited spend / key rotation.
//
// Without CDP creds you still get a working paid `search` — local mode kicks in automatically.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { createWalletClient, http, createPublicClient, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey, toAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROXY_URL = process.env.AGENT_MARKETPLACE_URL || "https://agent-marketplace-proxy.vercel.app";
const NETWORK = process.env.X402_NETWORK || "base";
const ACCOUNT_NAME = process.env.AGENT_MARKETPLACE_ACCOUNT || "agent-marketplace-buyer";
const WALLET_DIR = process.env.AGENT_MARKETPLACE_WALLET_DIR || join(homedir(), ".agent-marketplace");
const WALLET_FILE = join(WALLET_DIR, "wallet.json");

// USDC contract addresses on Base
const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

let _walletClient = null;
let _account = null;
let _fetchWithPay = null;
let _mode = null; // "local" | "cdp"

function chain() {
  return NETWORK === "base-sepolia" ? baseSepolia : base;
}

// LOCAL mode: read or generate a private key in ~/.agent-marketplace/wallet.json (mode 0600).
function loadOrCreateLocalKey() {
  if (existsSync(WALLET_FILE)) {
    const data = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
    if (!data.privateKey?.startsWith("0x")) throw new Error(`Malformed wallet file at ${WALLET_FILE}`);
    return data.privateKey;
  }
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  const pk = generatePrivateKey();
  writeFileSync(WALLET_FILE, JSON.stringify({ privateKey: pk, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(WALLET_FILE, 0o600);
  return pk;
}

async function ensureWallet() {
  if (_fetchWithPay) return { fetchWithPay: _fetchWithPay, account: _account, mode: _mode };

  const hasCdp = process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET;

  if (hasCdp) {
    // Lazy-import CDP SDK so users without CDP creds don't pay the import cost.
    const { CdpClient } = await import("@coinbase/cdp-sdk");
    const cdp = new CdpClient();
    let cdpAccount;
    try {
      cdpAccount = await cdp.evm.getAccount({ name: ACCOUNT_NAME });
    } catch {
      cdpAccount = await cdp.evm.createAccount({ name: ACCOUNT_NAME });
    }
    _account = cdpAccount;
    _walletClient = createWalletClient({ account: toAccount(cdpAccount), chain: chain(), transport: http() });
    _mode = "cdp";
  } else {
    const pk = loadOrCreateLocalKey();
    _account = privateKeyToAccount(pk);
    _walletClient = createWalletClient({ account: _account, chain: chain(), transport: http() });
    _mode = "local";
  }

  _fetchWithPay = wrapFetchWithPayment(fetch, _walletClient);
  return { fetchWithPay: _fetchWithPay, account: _account, mode: _mode };
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

const server = new McpServer({ name: "agent-marketplace", version: "0.2.0" });

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
  "Google SERP via agent-marketplace-proxy — $0.001 USDC per call on Base, paid automatically from your local hot wallet (or CDP wallet if CDP creds set). Unlimited. Just fund the wallet (see `wallet_info`) and call.",
  {
    q: z.string().describe("Search query"),
    location: z.string().default("United States"),
    num: z.number().int().default(10),
  },
  async ({ q, location, num }) => {
    const { fetchWithPay } = await ensureWallet();
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
  "wallet_info",
  "Show your buyer wallet address, mode (local/CDP), current USDC balance, and how to fund. Run this once before calling `search` for the first time.",
  {},
  async () => {
    try {
      const { account, mode } = await ensureWallet();
      const bal = await usdcBalance(account.address);
      const netLabel = NETWORK === "base-sepolia" ? "Base Sepolia (testnet)" : "Base (mainnet)";
      const modeLabel = mode === "cdp"
        ? "CDP (Coinbase-managed key)"
        : `local (key at ${WALLET_FILE}, chmod 600)`;
      const fundHint = NETWORK === "base-sepolia"
        ? `Free testnet USDC: <https://faucet.circle.com> (Base Sepolia).`
        : `Fund with Apple Pay / card (no Coinbase account needed):
  Stripe Onramp: <https://crypto.link.com/?destination_currency=usdc&destination_network=base&destination_address=${account.address}>
  Coinbase Pay:  <https://pay.coinbase.com/buy/select-asset?addresses=%7B%22${account.address}%22%3A%5B%22base%22%5D%7D&assets=%5B%22USDC%22%5D>
Or transfer existing USDC on Base to the address above.`;
      const backupHint = mode === "local"
        ? `\nBackup: copy ${WALLET_FILE} somewhere safe. This is a hot wallet — keep balance small ($1–$10).`
        : "";
      const text = `Buyer wallet
  Address: ${account.address}
  Network: ${netLabel}
  Balance: ${bal} USDC
  Mode:    ${modeLabel}

Cost: $0.001 per \`search\` call → $1 covers ~1000 calls.
${fundHint}${backupHint}`;
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
