# agent-marketplace-mcp

**One-line install: a Google SERP tool for Claude / Cursor / any MCP agent. Free trial out of the box; for production volume, your wallet is managed by Coinbase — you only ever fund USDC, you never see a private key.**

```bash
# Option A — direct from GitHub (works today, no npm publish needed)
claude mcp add agent-marketplace -- npx -y github:yayashuxue/agent-marketplace-mcp

# Option B — once published to npm
claude mcp add agent-marketplace -- npx -y agent-marketplace-mcp
```

That's it. Restart Claude. Ask: *"search the web for best small language models 2026"*.

---

## What you get

Three tools in your agent's toolbelt:

| Tool | What it does | Cost | Setup |
|---|---|---|---|
| `search_try` | Google SERP, free | $0 (5/IP/day) | none |
| `search` | Google SERP, unlimited | $0.001 USDC/call on Base | CDP wallet |
| `wallet_info` | Show your buyer wallet address & how to fund it | $0 | CDP wallet |

`search_try` works immediately with zero setup so you can verify the data quality. When you're ready for production volume, add CDP credentials.

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

## Enabling paid `search` (no rate limit)

The paid `search` tool buys SERP queries via the [x402](https://x402.org) micropayment protocol — every call settles $0.001 USDC on Base mainnet to the API operator. Your private key is held by **Coinbase Developer Platform (CDP)** so you never see or manage it. You just fund USDC.

### One-time setup (~5 minutes)

1. **Create a CDP API key** at https://portal.cdp.coinbase.com/access/api — you get back three secrets: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`.
2. **Add them to your MCP config** under `env`:

   ```json
   {
     "mcpServers": {
       "agent-marketplace": {
         "command": "npx",
         "args": ["-y", "agent-marketplace-mcp"],
         "env": {
           "CDP_API_KEY_ID": "...",
           "CDP_API_KEY_SECRET": "...",
           "CDP_WALLET_SECRET": "..."
         }
       }
     }
   }
   ```

3. **Get your wallet address.** Restart your client and ask the agent: *"call wallet_info"*. It will print your CDP-managed address.
4. **Fund it.** Send USDC on Base to that address (~$1 buys 1000 calls). Easiest path: buy USDC on Coinbase and withdraw on the Base network.
5. **Use `search`.** Ask the agent any search question; it auto-pays per call. No more rate limit.

### Want to test on testnet first (free test USDC)?

```json
"env": {
  "CDP_API_KEY_ID": "...",
  "CDP_API_KEY_SECRET": "...",
  "CDP_WALLET_SECRET": "...",
  "X402_NETWORK": "base-sepolia"
}
```

Then fund from https://faucet.circle.com (Base Sepolia). Switch back to mainnet when you've verified.

---

## How it works

1. Your agent calls `search` (an MCP tool exposed by this package).
2. This server makes an HTTP request to https://agent-marketplace-proxy.vercel.app/search.
3. The proxy returns `HTTP 402 Payment Required` with x402 payment requirements.
4. [`x402-fetch`](https://github.com/coinbase/x402) inside this MCP server signs an EIP-3009 USDC `transferWithAuthorization` using your CDP-managed wallet (Coinbase signs server-side; the key never leaves their infra).
5. The signed request is retried; the Coinbase facilitator settles on-chain.
6. The proxy forwards your query to DataForSEO, returns Google SERP JSON.

Your agent only sees the final JSON. The payment plumbing is invisible.

## Security model

- **Private key**: held by Coinbase Developer Platform. You can rotate or destroy via the CDP portal.
- **Spending cap**: x402-fetch defaults to a max of 0.1 USDC per request. Override with the `MAX_PAYMENT_USD` env var (in base units of USDC, where `1000` = $0.001).
- **Wallet name**: defaults to `agent-marketplace-buyer`. Override with `AGENT_MARKETPLACE_ACCOUNT` env var if you want multiple isolated buyer wallets.
- **Endpoint**: defaults to `https://agent-marketplace-proxy.vercel.app`. Override with `AGENT_MARKETPLACE_URL` to point at a self-hosted proxy.

## Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`@coinbase/cdp-sdk`](https://www.npmjs.com/package/@coinbase/cdp-sdk) — Coinbase-managed wallet (viem-compatible via `toAccount`)
- [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) — auto-pay HTTP middleware
- [`viem`](https://viem.sh) — EVM utilities
- Upstream API: [agent-marketplace-proxy](https://github.com/yayashuxue/agent-marketplace-proxy)

## License

MIT
