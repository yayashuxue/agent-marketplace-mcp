# Phase-1 Scenarios — Living Doc

**Source of truth for what the marketplace sells, why, and the current state of each endpoint.**

This doc is updated every time a scenario's vendor, price, or production status changes. Each change is also broadcast in `#agent-marketplace` as a one-line changelog (`Δ scenarios.md: <diff>`).

> Public mirror. Canonical edits happen alongside the app and are mirrored here so external integrators (e.g. awesome-x402 readers) can link to a stable URL.

---

## The thesis (shared by every scenario)

```
[Agent]  ──❌──  [Vendor that requires human KYC / signup / monthly billing]
                    ↓
[Agent]  ──✅──  [Marketplace x402 endpoint]  ──🟢──  [Vendor]
                       (we hold the human-only credentials,
                        we hand back the result, agent pays per call)
```

Agents are stateless. They cannot pass KYC, sign ToS, hold a credit card, or maintain a recurring subscription. Every phase-1 scenario is a vertical specialization of the same value prop: **"we eat the human-only ops so the agent doesn't have to."**

---

## Status legend

| | |
|---|---|
| 🟢 | Live in prod |
| 🟡 | Spec'd, blocked on input (key, decision, ToS) |
| ⚪ | Spec'd, not yet started |
| 🔴 | Outage / regression |

---

## /scrape

- **status**: 🟢 LIVE
- **slug (API)**: `POST /scrape` (paid x402) · `POST /try/scrape` (5/IP/day free)
- **slug (recipe page)**: `/web-scrape`
- **short pitch**: One-call web page → clean LLM-ready content for your AI agent.
- **problem solved**: Agents need to read pages without managing proxies, rotating user agents, parsing 50 different markup dialects, or signing up for a scraping vendor. We hand back `{url, title, content, tokens}` — they pay one cent and move on.
- **upstream vendor**: [Jina Reader](https://r.jina.ai) (free tier, no key required, 20 RPM ceiling)
- **upstream cost**: $0 (drops in `JINA_API_KEY` env if we outgrow 20 RPM)
- **retail price (x402)**: $0.001 USDC / call
- **hero anchor (landing rotation)**: ScrapingBee Business $7,188/yr — what a mid-market B2B scrape buyer actually pays today
- **why this vendor**: zero upstream cost = 100% margin on paid tier; no key management; instant fallback to Jina paid tier if rate-limited
- **demo curl**:
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/try/scrape \
    -H 'content-type: application/json' \
    -d '{"url":"https://example.com"}'
  # → {"url":"https://example.com/","title":"Example Domain","content":"...","tokens":29,
  #    "_trial":{"remaining_today":4,"daily_limit":5}}
  ```
- **status log**:
  - `2026-05-11` — shipped to prod via Jina, commit `1ab436e`. 100% margin.

---

## /email-find

- **status**: 🟡 spec'd, blocked on Julie's `ANYMAIL_API_KEY`
- **slug (API)**: `POST /email-find`
- **slug (recipe page)**: `/email-find`
- **short pitch**: Give us a name + domain, we hand back a verified work email.
- **problem solved**: Agents prospecting / enriching / cold-outreaching can't maintain a Hunter or Snov.io subscription (monthly billing, account login, quota tracking). We absorb the upstream subscription and re-sell per call.
- **upstream vendor**: Anymail Finder (Hunter-equivalent, monthly billing)
- **upstream cost**: $29/mo plan, ~$0.029/credit, **charged only on verified hits** (no charge for not-found / catch-all)
- **retail price (x402)**: ⚠️ TBD — see [decision log](#open-decisions) for loss-leader vs breakeven options
- **hero anchor (landing rotation)**: Apollo Professional 5-seat annual ≈ **$4,740/yr** (verified 2026-05-11 via G2 / Vendr / Warmly / Cognism — 5 seats × $79/seat/mo × 12)
- **why this vendor**:
  - monthly billing fits the "no big upfront" rule
  - "pay only for verified" is friendlier to our margin than per-search billing
  - REST API surface is Hunter-compatible → @小c's proxy keeps Hunter stub fallback; switch-back is a 5-line change
- **demo curl** (planned):
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/email-find \
    -H 'content-type: application/json' \
    -d '{"name":"jane doe","domain":"acme.com"}'
  ```
- **status log**:
  - `2026-05-11` — backend locked = Anymail Finder $29/mo monthly. Awaiting Julie's API key drop into Vercel env.

---

## /sms/verify

- **status**: 🟡 spec'd, blocked on Julie's Twilio SID + auth token
- **slug (API)**: `POST /sms/verify`
- **slug (recipe page)**: `/verify-sms` (parallels `/email-verify`, frozen 2026-05-11)
- **short pitch**: One-call phone OTP verification for your AI agent. No Twilio account, no A2P registration, no monthly fee.
- **problem solved**: Agents onboarding human users (sign-up, login, payment confirmation) need OTP delivery. Without us, the agent's owner has to register a Twilio account, complete A2P 10DLC brand registration (US), maintain $10/mo per-use-case fees, and rotate SID/Token. We provide a single PAYG endpoint.
- **upstream vendor**: Twilio **Verify API** (deliberately not Programmable SMS — see "why this vendor")
- **upstream cost**: $0.05 / verification check + $0.0083 / SMS sent. No monthly minimum. No A2P 10DLC required (Verify is exempt).
- **retail price (x402)**: TBD (proposing **$0.10/call → ~50% margin** once we factor SMS cost)
- **hero anchor (landing rotation)**: TBD
- **why this vendor**:
  - **Twilio Verify is the only major OTP API exempt from US A2P 10DLC**, which means we ship day-1 with no brand registration, no EIN, no 1-7 day audit wait
  - Global reach out of the box (Verify auto-handles geo-permission)
  - PAYG, no monthly floor — matches our cost shape
  - Built-in fraud protection (geo-permission default-deny for high-risk countries) reduces our OTP-pumping exposure to ~zero
- **demo curl** (planned):
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/sms/verify \
    -H 'content-type: application/json' \
    -d '{"phone":"+14155551234","code":"123456"}'
  ```
- **status log**:
  - `2026-05-11` — vendor locked = Twilio Verify (not Programmable SMS); KYC explanation posted in `#agent-marketplace:9cef71b6`. Awaiting Julie's SID/Token + recommended $50/day spending cap on the production account.

---

## /transcribe-call

- **status**: 🟡 spec'd, blocked on Julie's `DEEPGRAM_API_KEY`
- **slug (API)**: `POST /transcribe-call`
- **slug (recipe page)**: `/transcribe-call`
- **short pitch**: Drop an audio URL, get back time-stamped transcript. No Deepgram account, no upload pipeline.
- **problem solved**: Agents handling voice (meeting notes, voicemail summarization, call analytics) can't maintain Deepgram balances or wrangle multi-part upload APIs. We expose one endpoint that takes a public URL or pre-signed S3 link and returns the transcript.
- **upstream vendor**: Deepgram Nova-3 Mono (PAYG)
- **upstream cost**: $0.0048/minute audio · $200 free credit on signup (covers ~700 hours of demo traffic before we touch a dollar)
- **retail price (x402)**: TBD (proposing $0.01/minute → 2x margin even before free credit)
- **hero anchor (landing rotation)**: TBD
- **why this vendor**:
  - PAYG with no monthly floor
  - $200 free credit = ~14 months of phase-1 demo budget before we burn through
  - Nova-3 quality is at or above Whisper for English; faster than OpenAI's API in latency
  - Single HTTP POST surface — no SDK lock-in, no streaming complexity for v1
- **demo curl** (planned):
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/transcribe-call \
    -H 'content-type: application/json' \
    -d '{"audio_url":"https://example.com/call.mp3"}'
  ```
- **status log**:
  - `2026-05-11` — vendor locked = Deepgram Nova-3 Mono. Awaiting Julie's API key.

---

## /serp

- **status**: ⚪ spec'd, backend pick locked, not yet wired
- **slug (API)**: `POST /serp`
- **slug (recipe page)**: `/serp`
- **short pitch**: Google SERP results in one call. No SerpAPI subscription, no monthly seat.
- **problem solved**: Agents doing competitive research, lead gen, or domain discovery need Google results. SerpAPI ($1,800/yr), DataForSEO, Bright Data all gate behind monthly subscription or seat licensing. We pass through PAYG.
- **upstream vendor**: DataForSEO PAYG (no monthly floor)
- **upstream cost**: ~$0.0006 per SERP query (live data, no minimum spend)
- **retail price (x402)**: TBD (proposing $0.005/call → ~8x margin)
- **hero anchor (landing rotation)**: SerpAPI $1,800/yr (verified ✅)
- **why this vendor**:
  - lowest PAYG per-call in the category
  - no monthly minimum — matches our cost shape
  - SerpAPI's $1,800/yr hero anchor makes our $0.005/call read as a 99% discount in the landing rotation
- **demo curl** (planned):
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/serp \
    -H 'content-type: application/json' \
    -d '{"query":"best b2b crm","gl":"us"}'
  ```
- **status log**:
  - `2026-05-11` — vendor locked = DataForSEO. SerpAPI $1,800/yr hero anchor verified. Pending @小c wiring.

---

## /email-verify

- **status**: ⚪ spec'd, backend candidate ZeroBounce, hero-anchor verify in flight
- **slug (API)**: `POST /email-verify`
- **slug (recipe page)**: `/email-verify`
- **short pitch**: Drop an email, get back `{deliverable, role, disposable}`. No ZeroBounce seat.
- **problem solved**: Agents doing outreach / list hygiene / signup-flow validation need to know if an email actually delivers. Vendors gate behind credit packs that don't expire — agents can't manage credit balances.
- **upstream vendor candidate**: ZeroBounce (hero anchor pending re-verify; pricing page is JS-blocked, alternative source in progress)
- **upstream cost**: ~$0.0075/check at low volume (to be re-verified)
- **retail price (x402)**: TBD
- **hero anchor (landing rotation)**: ZeroBounce ONE annual ≈ **$948/yr** (verified 2026-05-11 via usebouncer.com / mailmend.io / checkthat.ai — 10K verifies/mo plan × 12, $79/mo annual-billed). PAYG alt: $425/yr for 100K credits if a more aggressive anchor is needed.
- **why this vendor**: ZeroBounce is the most widely-cited consumer-facing brand in the verify category (good for hero anchor recognition). Cost is competitive at low volume.
- **demo curl** (planned):
  ```bash
  curl -sX POST https://agent-marketplace-proxy.vercel.app/email-verify \
    -H 'content-type: application/json' \
    -d '{"email":"foo@bar.com"}'
  ```
- **status log**:
  - `2026-05-11` — vendor candidate ZeroBounce, awaiting hero-price re-verification.

---

## Open decisions <a id="open-decisions"></a>

| # | Owner | Decision | Status | Deadline / next-review |
|---|---|---|---|---|
| 1 | @julie | `/email-find` retail price-per-call: loss-leader $0.005 / breakeven $0.05 / mid $0.02 | awaiting pick | **2026-05-13** (blocks `/email-find` ship) |
| 2 | @小cc | `/email-verify` hero anchor: re-verify ZeroBounce $816/yr via alternative source (pricing page JS-blocked) | **closed 2026-05-11** → $948/yr (ZeroBounce ONE annual; PAYG alt $425/yr for 100K credits) | — |
| 3 | @小cc | `/email-find` hero anchor: re-verify Apollo $2,388/yr | **closed 2026-05-11** → $4,740/yr (5-seat Professional annual) | — |
| 4 | @julie | Twilio production account spending cap → recommend $50/day for phase-1 (prevents fraud-review auto-trigger) | proposed | on Twilio key drop |

---

## Out-of-scope (phase-2 candidates, do not start)

These are tracked here so we don't get pulled into them prematurely.

- `/translate` — DeepL ToS verification needed
- `/tts` — ElevenLabs ToS verification needed
- `/geocode` — Mapbox ToS verification needed
- `/lead-enrich` — needs separate research on full-stack enrichment vendors (Clearbit, Apollo, FullContact)

---

## Changelog convention

When this doc changes, broadcast in `#agent-marketplace` as:

```
Δ scenarios.md: <one-line diff>

e.g.:
Δ scenarios.md: /sms/verify → 🟢 LIVE (Twilio key landed, commit abc1234)
Δ scenarios.md: /email-find retail price = $0.02/call (julie's pick)
Δ scenarios.md: /email-verify backend swapped ZeroBounce → NeverBounce (cost win)
```

The one-line format lets us mine this for landing-page social-proof timeline ("v1: 1 endpoint live → today: 6 endpoints live").

---

*Maintained by @小cc · scenarios + spec lane. Repo wiring (README link / llms.txt / x402.json `documentation_url`) maintained by @小c.*
