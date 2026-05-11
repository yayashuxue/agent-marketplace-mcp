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
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

const APP_URL = process.env.AGENT_MARKETPLACE_APP_URL || "https://agent-marketplace-app.vercel.app";
const CONFIG_DIR = process.env.AGENT_MARKETPLACE_CONFIG_DIR || join(homedir(), ".agent-marketplace");
const SESSION_FILE = join(CONFIG_DIR, "session.json");
const TIMEOUT_MS = 5 * 60 * 1000;

const HEX_RE = /^0x[0-9a-fA-F]+$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const MCP_SERVER_KEY = "agent-marketplace";
const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "github:yayashuxue/agent-marketplace-mcp"],
};

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

// MCP-client registration helpers ───────────────────────────────────────────
//
// Auto-detect installed MCP clients (Claude Desktop, Cursor, Claude Code) and
// register the agent-marketplace server in each. Idempotent — re-runs are no-ops
// when our key is already present. Backs up the original JSON config to `.bak`
// before mutating.

function claudeDesktopConfigPath() {
  const p = platform();
  if (p === "darwin") return join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  if (p === "win32") return join(process.env.APPDATA || join(homedir(), "AppData/Roaming"), "Claude/claude_desktop_config.json");
  return join(homedir(), ".config/Claude/claude_desktop_config.json");
}

function cursorConfigPath() {
  return join(homedir(), ".cursor/mcp.json");
}

// Write our entry into a JSON config that uses the canonical `mcpServers` map.
// Returns one of: "added" | "already" | "not-installed" | `failed: <reason>`.
function registerInJsonConfig(path) {
  // "Not installed" heuristic: we only touch a file/dir that already exists.
  // Creating Claude Desktop's config dir on a machine with no Claude Desktop
  // would be misleading, and Cursor users without the editor don't need an
  // ~/.cursor/ to spring into existence.
  if (!existsSync(dirname(path))) return "not-installed";

  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8")) || {};
    } catch (e) {
      return `failed: ${path} is not valid JSON (${e.message})`;
    }
  }

  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers[MCP_SERVER_KEY]) return "already";
  cfg.mcpServers[MCP_SERVER_KEY] = MCP_SERVER_ENTRY;

  try {
    if (existsSync(path)) copyFileSync(path, path + ".bak");
    else mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    return "added";
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

// Claude Code uses a CLI for config — `claude mcp add` writes to the user-scoped
// settings. We only invoke it when the `claude` binary is on PATH.
function registerInClaudeCode() {
  const which = spawnSync(platform() === "win32" ? "where" : "which", ["claude"], { stdio: "ignore" });
  if (which.status !== 0) return "not-installed";

  const list = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (list.status === 0 && (list.stdout || "").includes(MCP_SERVER_KEY)) return "already";

  const add = spawnSync(
    "claude",
    ["mcp", "add", MCP_SERVER_KEY, "--", "npx", "-y", "github:yayashuxue/agent-marketplace-mcp"],
    { encoding: "utf8" },
  );
  if (add.status === 0) return "added";
  return `failed: ${(add.stderr || add.stdout || "").trim() || "claude mcp add exited " + add.status}`;
}

export function registerMcpClients() {
  return [
    { client: "Claude Desktop", path: claudeDesktopConfigPath(), result: registerInJsonConfig(claudeDesktopConfigPath()) },
    { client: "Cursor",         path: cursorConfigPath(),        result: registerInJsonConfig(cursorConfigPath())        },
    { client: "Claude Code",    path: "claude mcp",              result: registerInClaudeCode()                          },
  ];
}

function printRegistrationSummary(results) {
  log("MCP server registration:");
  for (const { client, path, result } of results) {
    const icon = result === "added" ? "✓" : result === "already" ? "✓" : result === "not-installed" ? "⊘" : "✗";
    const detail =
      result === "added" ? `added (${path})` :
      result === "already" ? "already configured" :
      result === "not-installed" ? "not installed" :
      result; // "failed: ..."
    log(`  ${icon} ${client} — ${detail}`);
  }
  const anyAdded = results.some((r) => r.result === "added");
  if (anyAdded) {
    log("");
    log("Restart Claude Desktop / Cursor to load the new server.");
  } else if (results.every((r) => r.result === "not-installed")) {
    log("");
    log("No supported MCP client detected. Add this entry manually:");
    log(`  "${MCP_SERVER_KEY}": ${JSON.stringify(MCP_SERVER_ENTRY)}`);
  }
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

export async function runInit() {
  const skipRegister = process.argv.includes("--skip-register") || process.argv.includes("--no-register");
  const force = process.argv.includes("--force");

  // Existing session → default behavior is to preserve the (possibly funded) spender
  // wallet and only re-run client registration. `--force` re-does the browser flow.
  const existing = existingSessionSummary();
  if (existing && !force) {
    log(`agent-marketplace: existing session for account ${existing.account}, spender ${existing.spender}.`);
    log(`Skipping wallet setup (use --force to redo). Registering MCP clients…`);
    log("");
    if (skipRegister) {
      log("Skipping MCP client registration (--skip-register). Nothing to do.");
      return;
    }
    printRegistrationSummary(registerMcpClients());
    log("");
    log(`Dashboard: ${APP_URL}/dashboard?account=${existing.account}&spender=${existing.spender}`);
    return;
  }
  if (existing && force) {
    log(`agent-marketplace: --force set; re-running wallet setup for account ${existing.account}. Existing spender ${existing.spender} will be replaced.`);
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

  if (skipRegister) {
    log("Skipping MCP client registration. Add manually:");
    log(`  "${MCP_SERVER_KEY}": ${JSON.stringify(MCP_SERVER_ENTRY)}`);
  } else {
    printRegistrationSummary(registerMcpClients());
  }
  log("");
  log(`Dashboard: ${APP_URL}/dashboard?account=${session.account}&spender=${session.spenderAddress}`);
}

// Auto-run only when this file is the process entry (i.e. invoked directly as the
// registered `init` bin). When imported by agent-marketplace-mcp.js's subcommand
// dispatch, the parent calls runInit() explicitly — we must NOT also run here, or
// the listener boots twice.
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runInit()
    .then(() => process.exit(0))
    .catch((e) => {
      log(`✗ init failed: ${e.message}`);
      process.exit(1);
    });
}
