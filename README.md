# agent-marketplace-mcp

**A Google SERP tool for Claude / Cursor / any MCP agent. Free trial out of the box; for production volume, your agent gets its own scoped wallet authorized via your Base Account (Coinbase Smart Wallet) — no API signup, no email, just passkey + Apple Pay.**

```bash
# Direct from GitHub (works today)
claude mcp add agent-marketplace -- npx -y github:yayashuxue/agent-marketplace-mcp

# Once published to npm
claude mcp add agent-marketplace -- npx -y agent-marketplace-mcp
```

That's it. Restart Claude. Ask: *"search the web for best small language models 2026"*.

---

## What you get

| Tool | What it does | Cost | Setup |
|---|---|---|---|
| `search_try` | Google SERP, free | $0 (5/IP/day) | none |
| `search` | Google SERP, unlimited | $0.001 USDC/call on Base | run `wallet_connect` once, then fund |
| `wallet_connect` | Authorize a scoped spender via your Base Account passkey ($20/30 days, scoped to this app) | $0 | one-time, ~30 sec |
| `wallet_info` | Show spender address, balance, fund link, dashboard URL (revoke / view status) | $0 | run `wallet_connect` first |

`search_try` works immediately with zero setup so you can verify the data quality. When you're ready for production volume, run `wallet_connect` once (~30 sec — passkey + spend approval) and fund the spender via Apple Pay (~30 sec, no ID for first $500).

## Install (Claude Code)

```bash
claude mcp add agent-marketplace -- npx -y agent-marketplace-mcp
```

## Install (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agent-marketplace": {
      "command": "npx",
      "args": ["-y", "agent-marketplace-mcp"]
    }
  }
}
```

Restart Claude. The `search_try` tool is now available.

## Install (Cursor / Windsurf)

Same JSON in `.cursor/mcp.json` or `~/.codeium/windsurf/mcp_config.json`.

---

## Enabling paid `search`

The paid `search` tool buys SERP queries via the [x402](https://x402.org) micropayment protocol — every call settles $0.001 USDC on Base mainnet.

### One-time setup (~30 sec)

1. Run `wallet_connect` in your agent. The MCP starts a one-shot localhost listener and prints a URL.
2. Open the URL in your browser. The page:
   - Generates a fresh "spender" key (the privkey lives only in your browser tab and your local MCP — never on our servers).
   - Asks you to **Connect Base Account** → passkey login (Touch ID / Face ID).
   - Asks you to **Authorize $20/month** → another passkey signature grants a [SpendPermission](https://docs.base.org/identity/smart-wallet/guides/spend-permissions) scoped to this app's revenue address. Coinbase's Base paymaster sponsors the gas.
3. The page POSTs the spender private key + permission to your local MCP. Saved at `~/.agent-marketplace/session.json` (chmod 600).
4. Run `wallet_info` to see the fund link. Apple Pay $5 (no ID for first $500) → spender address.
5. Use `search`. Each call signs an EIP-3009 `transferWithAuthorization`; the x402 facilitator submits on-chain so your spender wallet never spends ETH for gas.

> **Manage / revoke**: `wallet_info` prints a dashboard URL where you can see balance, remaining allowance, and revoke the spend permission anytime.

> **Headless / CI**: skip `wallet_connect` and set `AGENT_MARKETPLACE_SPENDER_KEY` to a `0x…` private key in your MCP config. The env var takes precedence over the session file.

### Headless config example (Claude Desktop / Cursor JSON)

```json
{
  "mcpServers": {
    "agent-marketplace": {
      "command": "npx",
      "args": ["-y", "agent-marketplace-mcp"],
      "env": {
        "AGENT_MARKETPLACE_SPENDER_KEY": "0x..."
      }
    }
  }
}
```

### Test on testnet first (free test USDC)

```json
"env": {
  "X402_NETWORK": "base-sepolia"
}
```

Then fund from https://faucet.circle.com (Base Sepolia).

---

## How it works

1. Your agent calls `search` (an MCP tool exposed by this package).
2. This server makes an HTTP request to https://agent-marketplace-proxy.vercel.app/search.
3. The proxy returns `HTTP 402 Payment Required` with x402 payment requirements.
4. [`x402-fetch`](https://github.com/coinbase/x402) signs an EIP-3009 USDC `transferWithAuthorization` using the local spender key.
5. The Coinbase facilitator submits on-chain (it pays the gas, not you). Your spender's USDC balance ticks down by $0.001.
6. The proxy forwards your query to DataForSEO, returns Google SERP JSON.

Your agent only sees the final JSON. The payment plumbing is invisible.

## Security model

- **Spend cap.** Your Base Account grants the spender at most $20 USDC over 30 days, scoped to this app. Even if `~/.agent-marketplace/session.json` leaks, the attacker can drain at most that cap before your daily allowance recharges, and you can revoke instantly via the dashboard URL printed by `wallet_info`.
- **Master key never on disk.** Your Base Account passkey stays in your device's secure enclave. The local file holds only the scoped spender key, not the master key.
- **No gas exposure.** The spender wallet never holds ETH. x402's facilitator submits all on-chain transactions and pays gas itself.
- **x402-fetch payment cap.** Defaults to a max of 0.1 USDC per request. Override with `MAX_PAYMENT_USD` (base units of USDC, where `1000` = $0.001).
- **Config location override**: set `AGENT_MARKETPLACE_CONFIG_DIR` to use a custom directory.
- **Endpoint**: defaults to `https://agent-marketplace-proxy.vercel.app`. Override with `AGENT_MARKETPLACE_URL` to point at a self-hosted proxy.

## Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`@base-org/account`](https://www.npmjs.com/package/@base-org/account) — Base Account SDK + Spend Permissions (loaded in-browser at the hosted setup page; no Node-side dep)
- [`viem`](https://viem.sh) — EVM utilities + EIP-3009 signing
- [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) — auto-pay HTTP middleware
- Upstream API: [agent-marketplace-proxy](https://github.com/yayashuxue/agent-marketplace-proxy)

## Migrating from v1 (CDP-managed)

v1 used a CDP API key + Wallet Secret per user (~10 minute signup at the CDP portal). v2 replaces that with Base Account passkey + scoped Spend Permission (~30 seconds). v1's `~/.agent-marketplace/config.json` is ignored — run `wallet_connect` once to migrate. Your old CDP wallet still works if you want to drain it; it's just no longer used by this MCP.

## License

MIT
