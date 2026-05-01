# AA Migration Plan — Coinbase Smart Wallet + Session Keys

> **Status**: scaffold only. Not merged. v0.3 (local hot wallet) ships today.
> **Branch**: `aa-migration`
> **Goal**: replace the on-disk EOA with a Coinbase Smart Wallet (passkey-secured) + a session-key delegation that the MCP can use within a daily/per-call cap. If the session key is stolen, the attacker can spend at most the cap before the wallet revokes it.

## Why this is the right model for headless agents

| | Local file (v0.3) | Smart Wallet + session keys (v1.0 target) |
|---|---|---|
| Secret on disk | Full private key | Session key, scope-limited at the contract layer |
| Recovery if device dies | None — funds lost | Passkey synced to iCloud/Google → recover on new device |
| Compromise blast radius | Entire balance | Daily cap (e.g. $10/day) + can only call our specific contract |
| First-run UX | None — auto generated | One browser tap (Touch ID / Face ID) to create + delegate |
| x402 compatibility | Native EOA, signs EIP-3009 | Smart Wallet supports EIP-3009 via 6492 / [Coinbase Smart Wallet docs](https://docs.cdp.coinbase.com/smart-wallet/docs/welcome) |

## High-level flow

```
User installs MCP
        │
        ▼
First `search` call → wallet not provisioned
        │
        ▼
MCP opens browser to:
  https://agent-marketplace-proxy.vercel.app/setup?sessionKeyAddr=0x<ephemeral>
        │
        ▼
Setup page (browser):
  1. User connects via Coinbase Smart Wallet (passkey / Touch ID)
  2. Page calls smartWallet.grantPermissions({
       account: ourSessionKeyEOA,
       permissions: [{
         type: "spending-limit",
         data: { token: USDC, amount: 10 USDC, period: 86400 }
       }, {
         type: "call-policy",
         data: { contracts: [agent-marketplace-proxy.payTo], selectors: [transferWithAuthorization] }
       }],
       expiry: now + 30 days
     })
  3. Page POSTs the granted permission proof to MCP local callback (http://127.0.0.1:RANDOM_PORT)
  4. MCP stores: { smartWalletAddr, sessionKeyPK, permissionProof, expiry } in ~/.agent-marketplace/wallet.json
        │
        ▼
Subsequent calls:
  MCP signs x402 payment with session key → adds permission proof header → facilitator validates against on-chain policy
```

## Components

1. **MCP changes** (`bin/agent-marketplace-mcp.js`):
   - On first paid `search`, if no smart-wallet config: spawn local HTTP server on random port, open browser to setup URL with `?callback=http://127.0.0.1:PORT/done&sessionKeyAddr=...`
   - Generate ephemeral session-key EOA, store its private key locally (still on disk, but contract-scope-limited so blast radius = daily cap)
   - Replace `wrapFetchWithPayment(fetch, walletClient)` with the AA-aware variant (likely needs a custom wallet client that includes the permission proof in signed payloads — TBD whether x402-fetch supports this natively or we fork)
   - `wallet_info`: show smart-wallet address + session-key spending status (used / cap / expiry)

2. **Setup page** (in agent-marketplace-proxy as `GET /setup`):
   - Wagmi + Coinbase Smart Wallet connector
   - `useGrantPermissions()` hook from `@coinbase/onchainkit` (or direct EIP-7715 calls)
   - On success, POST proof + smart-wallet address to local callback URL
   - Closes itself with a "✅ Wallet connected, you can return to your agent"

3. **Open question — x402 + session key signing**:
   - x402 currently expects an EOA signing EIP-3009 USDC transfer
   - With session keys via ERC-7715 (or 4337 paymaster), the actual `msg.sender` from the contract perspective is the smart wallet, but the off-chain signer is the session EOA
   - Need to confirm Coinbase facilitator validates this — may need to coordinate with x402 maintainers

## Estimated timeline

- Setup page (wagmi + smart wallet + grantPermissions): **4 hours**
- MCP local callback server + state machine: **2 hours**
- x402 signing path with session-key proof: **6-8 hours** (depends on x402-fetch fork need)
- E2E test on Base Sepolia: **2 hours**
- README + migration guide: **1 hour**

**Total: ~1.5–2 days** of focused work.

## What ships in v0.3 to bridge the gap

- Local file mode (chmod 600) — current default
- CDP-managed mode (env-var opt-in) — for teams with audit/rotation requirements
- Apple Pay funding via /fund page

v1.0 (this AA path) becomes the new default; v0.3 modes stay as fallbacks for users who don't want the browser handshake on first run.

## Risks I want julie's call on before starting

1. **Browser dependency on first run** — does this break headless CI agent use cases where there's no browser?
   - Mitigation: keep local-file mode as opt-in for headless contexts (`AGENT_MARKETPLACE_HEADLESS=1`)
2. **Passkey recovery dependency on Apple/Google** — users who don't trust them need EOA mode anyway
3. **x402-fetch fork** — if upstream doesn't accept the AA hook, we maintain a fork
4. **Coinbase Smart Wallet vendor lock-in** — could swap for any ERC-4337 wallet but Coinbase's UX is the cleanest right now

Pinging @julie when she wakes up to confirm direction before sinking 2 days into this.
