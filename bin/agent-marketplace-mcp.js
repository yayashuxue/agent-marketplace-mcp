#!/usr/bin/env node
// agent-marketplace-mcp — MCP server exposing agent-marketplace-proxy as Claude/Cursor tools.
//
// User config (claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "agent-marketplace": {
//         "command": "npx",
//         "args": ["-y", "agent-marketplace-mcp"],
//         "env": {
//           "CDP_API_KEY_ID": "...",
//           "CDP_API_KEY_SECRET": "...",
//           "CDP_WALLET_SECRET": "..."
//         }
//       }
//     }
//   }
//
// Without CDP creds, only `search_try` works (free 5/day, no wallet needed).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createWalletClient, http } from "viem";
import { toAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const PROXY_URL = process.env.AGENT_MARKETPLACE_URL || "https://agent-marketplace-proxy.vercel.app";
const NETWORK = process.env.X402_NETWORK || "base";
const ACCOUNT_NAME = process.env.AGENT_MARKETPLACE_ACCOUNT || "agent-marketplace-buyer";

let _cdp = null;
let _walletClient = null;
let _account = null;
let _fetchWithPay = null;

async function getCdp() {
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
    return null;
  }
  if (!_cdp) _cdp = new CdpClient();
  return _cdp;
}

// Lazy-init: create or fetch the buyer account, build a viem walletClient, wrap fetch with x402 auto-pay.
async function ensureWallet() {
  if (_fetchWithPay) return { fetchWithPay: _fetchWithPay, account: _account };

  const cdp = await getCdp();
  if (!cdp) throw new Error("CDP creds missing — set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET env vars in your MCP config");

  // getOrCreate semantics: try to fetch by name, else create.
  try {
    _account = await cdp.evm.getAccount({ name: ACCOUNT_NAME });
  } catch {
    _account = await cdp.evm.createAccount({ name: ACCOUNT_NAME });
  }

  const chain = NETWORK === "base-sepolia" ? baseSepolia : base;
  _walletClient = createWalletClient({ account: toAccount(_account), chain, transport: http() });
  _fetchWithPay = wrapFetchWithPayment(fetch, _walletClient);
  return { fetchWithPay: _fetchWithPay, account: _account };
}

const server = new McpServer({ name: "agent-marketplace", version: "0.1.0" });

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
  "Google SERP via agent-marketplace-proxy — $0.001 USDC per call on Base, paid automatically from your CDP-managed wallet. Unlimited. Requires CDP_API_KEY_ID/CDP_API_KEY_SECRET/CDP_WALLET_SECRET env vars and that your CDP wallet holds USDC on Base.",
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
  "Show your CDP-managed wallet address and how to fund it. Use this once before calling `search` for the first time so you know where to send USDC.",
  {},
  async () => {
    try {
      const { account } = await ensureWallet();
      const text = `Your buyer wallet (CDP-managed):
  Address: ${account.address}
  Network: ${NETWORK}

To use the paid \`search\` tool, send USDC on ${NETWORK === "base-sepolia" ? "Base Sepolia (testnet)" : "Base (mainnet)"} to that address.

- $0.001 per call → $1 covers 1000 calls.
- Easiest: buy USDC on Coinbase, withdraw on Base network to ${account.address}.
- Testnet: https://faucet.circle.com (Base Sepolia, free test USDC).

Coinbase manages the private key — you never see it.`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: `Wallet not configured: ${e.message}\n\nCreate a CDP API key at https://portal.cdp.coinbase.com/access/api and set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in your MCP config. Until then, use the free \`search_try\` tool.`,
        }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[agent-marketplace-mcp] ready on stdio");
