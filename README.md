# agent-marketplace-mcp

**One-line install: a Google SERP tool for Claude / Cursor / any MCP agent. Free trial out of the box; for production volume, register a Coinbase-managed wallet (CDP) and your agent auto-pays $0.001/call. The private key never lives on your disk — Coinbase's enclave holds it.**

```bash
# Option A — direct from GitHub (works today, no npm publish needed)
claude mcp add agent-marketplace -- npx -y github:yayashuxue/agent-marketplace-mcp

# Option B — once published to npm
claude mcp add agent-marketplace -- npx -y agent-marketplace-mcp
```

That's it. Restart Claude. Ask: *"search the web for best small language models 2026"*.

---

## What you get

Four tools in your agent's toolbelt:

| Tool | What it does | Cost | Setup |
|---|---|---|---|
| `search_try` | Google SERP, free | $0 (5/IP/day) | none |
| `search` | Google SERP, unlimited | $0.001 USDC/call on Base | run `wallet_setup` once, then fund |
| `wallet_setup` | One-time CDP API key registration; creates a server-side EVM wallet under your CDP project | $0 | get a CDP API key + Wallet Secret from the [CDP portal](https://portal.cdp.coinbase.com/projects/api-keys) |
| `wallet_info` | Show your buyer wallet address, balance, and fund URL | $0 | run `wallet_setup` first |

`search_try` works immediately with zero setup so you can verify the data quality. When you're ready for production volume, run `wallet_setup` once (~90 sec) and fund the wallet (~30 sec). The CDP API credentials sit in `~/.agent-marketplace/config.json` (chmod 600); the wallet's private key never leaves Coinbase's enclave.

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

## Enabling paid `search` (no rate limit, key never on your disk)

The paid `search` tool buys SERP queries via the [x402](https://x402.org) micropayment protocol — every call settles $0.001 USDC on Base mainnet to the API operator.

The buyer wallet is **CDP-managed**: Coinbase's MPC enclave holds the private key, you hold CDP API credentials that authorize signing, and the MCP server never touches a private key. This eliminates the EOA-on-disk drain risk where a single mis-committed `.json` file can cost you the wallet.

### One-time wallet setup

1. **Create a CDP API key + Wallet Secret** at https://portal.cdp.coinbase.com/projects/api-keys (~90 sec):
   - Click "Create API Key", download the JSON — gives you `id` and `privateKey`.
   - Click "Create Wallet Secret" (separate string from the API key).
2. **Run `wallet_setup`** in your agent. Paste the three values when prompted. The MCP server creates a server-side EVM wallet under your CDP project and saves the credentials to `~/.agent-marketplace/config.json` (chmod 600). **No private key is ever written to disk.**
3. **Fund the wallet.** Run `wallet_info` to get the address + Apple Pay link, send USDC on Base, done.
4. **Use `search`.** Your agent auto-pays per call; CDP signs each EIP-3009 authorization inside the enclave.

> **Headless / CI**: skip `wallet_setup` and set `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` env vars in your MCP config instead. Env vars take precedence over the config file.

> **Still a hot wallet — keep balance small ($1–$10).** Real funds belong in your main wallet. CDP credentials are easier to rotate than a leaked privkey, but they still authorize spending; treat them like an API token.

### Headless config example (Claude Desktop / Cursor JSON)

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

### Want to test on testnet first (free test USDC)?

```json
"env": {
  "X402_NETWORK": "base-sepolia"
}
```

Then fund from https://faucet.circle.com (Base Sepolia). Switch back to mainnet by removing the env var.

---

## How it works

1. Your agent calls `search` (an MCP tool exposed by this package).
2. This server makes an HTTP request to https://agent-marketplace-proxy.vercel.app/search.
3. The proxy returns `HTTP 402 Payment Required` with x402 payment requirements.
4. [`x402-fetch`](https://github.com/coinbase/x402) calls into the [CDP SDK](https://www.npmjs.com/package/@coinbase/cdp-sdk) to sign an EIP-3009 USDC `transferWithAuthorization`. **The signing happens inside Coinbase's MPC enclave** — the MCP server only ever sees CDP API credentials, never a private key.
5. The signed request is retried; the Coinbase facilitator settles on-chain.
6. The proxy forwards your query to DataForSEO, returns Google SERP JSON.

Your agent only sees the final JSON. The payment plumbing is invisible.

## Security model

- **No private key on disk.** The wallet's signing key lives in Coinbase's MPC enclave. The local config file at `~/.agent-marketplace/config.json` (chmod 600, dir chmod 700) holds only CDP API credentials.
- **Credential leakage blast radius.** If the local config leaks, attacker can sign EIP-3009 transfers as your wallet but only up to the wallet's USDC balance. Keep balance small ($1–$10) and rotate the CDP API key in the [CDP portal](https://portal.cdp.coinbase.com) if you suspect compromise.
- **Spending cap**: x402-fetch defaults to a max of 0.1 USDC per request. Override with the `MAX_PAYMENT_USD` env var (in base units of USDC, where `1000` = $0.001).
- **Config location override**: set `AGENT_MARKETPLACE_CONFIG_DIR` to use a custom directory.
- **Wallet name override**: defaults to `agent-marketplace-buyer`. Set `AGENT_MARKETPLACE_ACCOUNT` for multiple isolated buyer wallets under one CDP project.
- **Endpoint**: defaults to `https://agent-marketplace-proxy.vercel.app`. Override with `AGENT_MARKETPLACE_URL` to point at a self-hosted proxy.

## Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`viem`](https://viem.sh) — EVM utilities + local key generation
- [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) — auto-pay HTTP middleware
- [`@coinbase/cdp-sdk`](https://www.npmjs.com/package/@coinbase/cdp-sdk) — *optional*, only loaded when CDP env vars are set
- Upstream API: [agent-marketplace-proxy](https://github.com/yayashuxue/agent-marketplace-proxy)

## License

MIT
