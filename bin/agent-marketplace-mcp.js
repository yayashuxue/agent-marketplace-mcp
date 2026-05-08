#!/usr/bin/env node
// agent-marketplace-mcp — MCP server exposing agent-marketplace-proxy as Claude/Cursor tools.
//
// Wallet model (v2 — Base Account + Spend Permission, no CDP signup):
//   - User opens a hosted setup page in their browser.
//   - The page generates a fresh "spender" EOA (private key never leaves the browser tab),
//     prompts the user to connect their Base Account (Coinbase Smart Wallet) with passkey,
//     and grants a SpendPermission scoped to USDC, $20 over 30 days.
//   - The page POSTs the spender privkey + permission JSON to a one-shot localhost listener
//     this MCP starts on demand. We persist to ~/.agent-marketplace/session.json (chmod 600).
//   - Searches sign x402 EIP-3009 transferWithAuthorization with the spender key — the
//     facilitator submits on-chain, so the spender wallet never needs ETH for gas.
//   - User retains control via the hosted dashboard at /wallet (revoke, view balance).
//
// Free tier (`search_try`) works without any wallet setup.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { createWalletClient, http, createPublicClient, formatUnits, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PROXY_URL = process.env.AGENT_MARKETPLACE_URL || "https://agent-marketplace-proxy.vercel.app";
const NETWORK = process.env.X402_NETWORK || "base";
const CONFIG_DIR = process.env.AGENT_MARKETPLACE_CONFIG_DIR || join(homedir(), ".agent-marketplace");
const SESSION_FILE = join(CONFIG_DIR, "session.json");
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for the user to complete setup

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

function readSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const mode = statSync(SESSION_FILE).mode & 0o777;
    if (mode !== 0o600) {
      console.error(`[agent-marketplace-mcp] warn: ${SESSION_FILE} mode is ${mode.toString(8)}, expected 600.`);
    }
  } catch {}
  return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
}

function writeSession(session) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

async function ensureWallet() {
  if (_fetchWithPay) return { fetchWithPay: _fetchWithPay, account: _account };
  // Allow env-var override for headless / CI: AGENT_MARKETPLACE_SPENDER_KEY.
  const envKey = process.env.AGENT_MARKETPLACE_SPENDER_KEY;
  const session = readSession();
  const privKey = envKey || session?.spenderPrivKey;
  if (!privKey || !isHex(privKey) || privKey.length !== 66) {
    throw new SetupRequiredError(
      "Wallet not configured. Run the `wallet_connect` tool to authorize a spender via your Base Account, " +
      "or set AGENT_MARKETPLACE_SPENDER_KEY env var (headless mode).",
    );
  }
  _account = privateKeyToAccount(privKey);
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

// Start a one-shot localhost listener on a free ephemeral port. Returns
// { port, awaitSession } — the caller can print the URL synchronously, then await
// the user-completed setup. Auto-closes after the first POST or CALLBACK_TIMEOUT_MS.
function startCallback() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const origin = req.headers.origin || "";
      res.setHeader("access-control-allow-origin", origin || "*");
      res.setHeader("access-control-allow-methods", "POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (req.method !== "POST" || !req.url.startsWith("/session")) {
        return res.writeHead(404).end();
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          clearTimeout(timer);
          server.close();
          server.emit("session", payload);
        } catch {
          res.writeHead(400).end("invalid JSON");
        }
      });
    });
    const timer = setTimeout(() => {
      server.close();
      server.emit("session-error", new Error(`Setup timed out after ${CALLBACK_TIMEOUT_MS / 1000}s.`));
    }, CALLBACK_TIMEOUT_MS);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const awaitSession = new Promise((res2, rej2) => {
        server.once("session", res2);
        server.once("session-error", rej2);
      });
      resolve({ port, awaitSession });
    });
    server.on("error", reject);
  });
}

const server = new McpServer({ name: "agent-marketplace", version: "2.0.0" });

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
  "Google SERP via agent-marketplace-proxy — $0.001 USDC per call on Base. Paid automatically from the spender wallet authorized via `wallet_connect`. Run `wallet_connect` once if you haven't, then `wallet_info` to check balance and fund.",
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

function openBrowser(url) {
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

server.tool(
  "wallet_connect",
  "One-time setup (~30 sec). Opens a browser to a hosted setup page where you connect your Base Account (Coinbase Smart Wallet) with a passkey and authorize a scoped spender for this MCP — up to $20 USDC over 30 days, scoped to this app's revenue address. THE BROWSER WILL OPEN AUTOMATICALLY. After you complete the flow there, this tool returns. Revoke anytime via the dashboard URL printed by `wallet_info`.",
  {},
  async () => {
    try {
      const { port, awaitSession } = await startCallback();
      const callbackUrl = `http://127.0.0.1:${port}/session`;
      const connectUrl = `${PROXY_URL}/wallet/connect?callback=${encodeURIComponent(callbackUrl)}`;
      // Auto-open the user's default browser to the setup page. We still log to stderr
      // as a fallback in case the spawn fails (e.g. headless / no DISPLAY).
      const opened = openBrowser(connectUrl);
      console.error(`[wallet_connect] ${opened ? "opened browser to" : "open this URL in your browser"}: ${connectUrl}`);
      console.error(`[wallet_connect] listening on ${callbackUrl}; will save to ${SESSION_FILE}`);

      const session = await awaitSession;
      // Validate payload shape.
      if (
        !session?.spenderPrivKey || !isHex(session.spenderPrivKey) ||
        !session?.spenderAddress || !isAddress(session.spenderAddress) ||
        !session?.account || !isAddress(session.account)
      ) {
        throw new Error("Invalid session payload from setup page");
      }
      writeSession({
        spenderPrivKey: session.spenderPrivKey,
        spenderAddress: session.spenderAddress,
        account: session.account,
        chainId: session.chainId,
        permission: session.permission,
        createdAt: session.createdAt || new Date().toISOString(),
      });
      _account = null; _walletClient = null; _fetchWithPay = null;
      return {
        content: [{ type: "text", text:
          `✓ Base Account connected: ${session.account}\n` +
          `✓ Spender authorized:     ${session.spenderAddress}\n` +
          `✓ Saved to ${SESSION_FILE} (chmod 600)\n\n` +
          `Next: call wallet_info to see balance + fund link, then run any \`search\`.`
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `wallet_connect failed: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "wallet_info",
  "Show your spender wallet (Base Account-authorized), current USDC balance, and dashboard / fund links. Run wallet_connect first if you haven't.",
  {},
  async () => {
    try {
      const session = readSession();
      if (!session?.spenderAddress) {
        throw new SetupRequiredError("No session found. Run `wallet_connect` first.");
      }
      const bal = await usdcBalance(session.spenderAddress);
      const netLabel = NETWORK === "base-sepolia" ? "Base Sepolia (testnet)" : "Base (mainnet)";
      const dashboardUrl = `${PROXY_URL}/wallet?account=${session.account}&spender=${session.spenderAddress}`;
      const fundUrl = NETWORK === "base-sepolia"
        ? `Free testnet USDC: <https://faucet.circle.com> (Base Sepolia).`
        : `${PROXY_URL}/fund?addr=${session.spenderAddress}&amount=5`;
      const text = `Agent spender wallet (Base Account-authorized — you control via Coinbase passkey)
  Base Account: ${session.account}
  Spender:      ${session.spenderAddress}
  Network:      ${netLabel}
  Balance:      ${bal} USDC
  Config:       ${SESSION_FILE} (chmod 600)

Cost: $0.001 per \`search\` call → $5 covers ~5000 calls.
Fund (Apple Pay): ${fundUrl}
Manage / revoke: ${dashboardUrl}`;
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
