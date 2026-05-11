#!/usr/bin/env node
// agent-marketplace init — terminal-first onboarding CLI.
//
// Flow (mirrors `wallet_connect` MCP tool but standalone):
//   1. Start a one-shot loopback HTTP listener on an ephemeral port.
//   2. Open the user's browser to https://agent-marketplace-app.vercel.app/connect?callback=...
//   3. The web page generates a spender EOA in-browser, walks the user through passkey +
//      Spend Permission, then POSTs { account, spenderAddress, spenderPrivKey, ... } back.
//   4. Validate, write ~/.agent-marketplace/session.json (chmod 600), print next steps.
//
// Invoked via: `npx -y github:yayashuxue/agent-marketplace-mcp init`

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const APP_URL = process.env.AGENT_MARKETPLACE_APP_URL || "https://agent-marketplace-app.vercel.app";
const CONFIG_DIR = process.env.AGENT_MARKETPLACE_CONFIG_DIR || join(homedir(), ".agent-marketplace");
const SESSION_FILE = join(CONFIG_DIR, "session.json");
const TIMEOUT_MS = 5 * 60 * 1000;

const HEX_RE = /^0x[0-9a-fA-F]+$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function log(msg) { process.stderr.write(msg + "\n"); }

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

function startCallback() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const origin = req.headers.origin || "*";
      res.setHeader("access-control-allow-origin", origin);
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
      server.emit("session-error", new Error(`Setup timed out after ${TIMEOUT_MS / 1000}s. Re-run \`npx -y github:yayashuxue/agent-marketplace-mcp init\` to retry.`));
    }, TIMEOUT_MS);
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

function writeSession(session) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

function existingSessionSummary() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    return { account: s.account, spender: s.spenderAddress };
  } catch {
    return null;
  }
}

async function main() {
  const existing = existingSessionSummary();
  if (existing) {
    log(`agent-marketplace: session already exists for account ${existing.account}.`);
    log(`Overwriting on success. Cancel with Ctrl-C if you'd rather keep it.`);
    log("");
  }

  const { port, awaitSession } = await startCallback();
  const callbackUrl = `http://127.0.0.1:${port}/session`;
  const setupUrl = `${APP_URL}/connect?callback=${encodeURIComponent(callbackUrl)}`;

  const opened = openBrowser(setupUrl);
  log("agent-marketplace setup");
  log("───────────────────────");
  log(opened
    ? `Opened your browser to: ${setupUrl}`
    : `Open this URL in your browser:\n  ${setupUrl}`);
  log(`Listening on ${callbackUrl} (5min timeout)…`);
  log("");

  let session;
  try {
    session = await awaitSession;
  } catch (e) {
    log(`✗ ${e.message}`);
    process.exit(1);
  }

  if (!session?.spenderPrivKey || !HEX_RE.test(session.spenderPrivKey) || session.spenderPrivKey.length !== 66) {
    log("✗ Invalid session payload from setup page (missing/malformed spenderPrivKey).");
    process.exit(1);
  }
  if (!ADDR_RE.test(session?.spenderAddress || "") || !ADDR_RE.test(session?.account || "")) {
    log("✗ Invalid session payload from setup page (missing/malformed addresses).");
    process.exit(1);
  }

  writeSession({
    spenderPrivKey: session.spenderPrivKey,
    spenderAddress: session.spenderAddress,
    account: session.account,
    chainId: session.chainId,
    permission: session.permission,
    createdAt: session.createdAt || new Date().toISOString(),
  });

  log(`✓ Base Account connected: ${session.account}`);
  log(`✓ Spender authorized:     ${session.spenderAddress}`);
  log(`✓ Saved to ${SESSION_FILE} (chmod 600)`);
  log("");
  log("Next: add the MCP server to Claude / Cursor:");
  log(`  npx -y github:yayashuxue/agent-marketplace-mcp`);
  log("");
  log(`Dashboard: ${APP_URL}/dashboard?account=${session.account}&spender=${session.spenderAddress}`);
}

main().catch((e) => {
  log(`✗ init failed: ${e.message}`);
  process.exit(1);
});
