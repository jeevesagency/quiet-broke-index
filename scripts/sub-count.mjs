#!/usr/bin/env node
/**
 * sub-count.mjs — Read-only Henry Finance Substack subscriber-count probe.
 *
 * Spawns Chrome 147 against the existing authenticated substack-jimmy profile
 * on CDP port 9334 (publish.mjs uses 9333), connects via Playwright CDP,
 * then issues an authenticated GET (cookies reused from the profile) to
 *   https://henryfinance.substack.com/api/v1/publish-dashboard/summary-v2?range=365
 * which returns total/paid subscriber counts. Free = total - paid.
 *
 * Output:
 *   - JSON object pretty-printed to stdout
 *   - Single-line JSON appended to ~/projects/quiet-broke-index/data/sub-history.jsonl
 *
 * Read-only. Never modifies state.
 * Exits with code 2 (and "profile in use" message) if substack-jimmy is busy.
 *
 * Usage:
 *   node scripts/sub-count.mjs
 *   SUB_COUNT_DEBUG=1 node scripts/sub-count.mjs  # dump endpoint payload to stderr
 */

import { spawn, spawnSync } from "node:child_process";
import { unlink, appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const PROFILE_DIR = "/Users/mike/.playwright-profiles/substack-jimmy";
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9334; // publish.mjs uses 9333
const HISTORY_PATH = path.join(
  os.homedir(),
  "projects/quiet-broke-index/data/sub-history.jsonl",
);
const PUB_HOST = "https://henryfinance.substack.com";
const SUMMARY_PATH = "/api/v1/publish-dashboard/summary-v2?range=365";

const DEBUG = process.env.SUB_COUNT_DEBUG === "1";

function logErr(...a) { console.error("[sub-count]", ...a); }

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((r) => {
      const s = net.createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.end(); r(true); });
      s.once("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function profileInUse() {
  const r = spawnSync("pgrep", ["-f", `user-data-dir=${PROFILE_DIR}`]);
  return r.status === 0 && r.stdout.toString().trim().length > 0;
}

async function cleanSingletonFiles() {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await unlink(`${PROFILE_DIR}/${f}`).catch(() => {});
    await unlink(`${PROFILE_DIR}/Default/${f}`).catch(() => {});
  }
}

async function main() {
  if (profileInUse()) {
    console.log(JSON.stringify({ error: "profile in use", profile: PROFILE_DIR }));
    logErr("profile in use — exiting without disturbing the existing session");
    process.exit(2);
  }

  await cleanSingletonFiles();
  await new Promise((r) => setTimeout(r, 400));

  const child = spawn(CHROME_BIN, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore", detached: false });

  let browser;
  let exitCode = 0;
  try {
    if (!(await waitForPort(DEBUG_PORT))) {
      throw new Error(`CDP port ${DEBUG_PORT} never opened`);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    const page = context.pages().filter(
      (p) => !p.url().startsWith("chrome://") && !p.url().startsWith("devtools://"),
    )[0] || (await context.newPage());
    await page.bringToFront();

    // Land on the publish dashboard once so the SPA bootstraps cookies/CSRF
    // exactly as the browser would. Read-only.
    await page.goto(`${PUB_HOST}/publish/home`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (/\/sign-in/.test(page.url())) {
      throw new Error("redirected to sign-in — auth profile is not logged in");
    }

    // Issue the authenticated API call via the page's fetch (uses session cookies).
    const apiUrl = PUB_HOST + SUMMARY_PATH;
    const summary = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, body: JSON.parse(text) }; }
      catch { return { ok: r.ok, status: r.status, body: null, text }; }
    }, apiUrl);

    if (DEBUG) logErr("summary-v2 response:", JSON.stringify(summary).slice(0, 1000));
    if (!summary.ok || !summary.body) {
      throw new Error(`summary-v2 fetch failed: status=${summary.status}`);
    }

    const b = summary.body;
    // Field names per Substack response (observed 2026-05-13):
    //   totalSubscribersEnd, paidSubscribersEnd (current counts at end of window)
    const total = typeof b.totalSubscribersEnd === "number" ? b.totalSubscribersEnd : null;
    const paid = typeof b.paidSubscribersEnd === "number" ? b.paidSubscribersEnd : null;
    const free = (typeof total === "number" && typeof paid === "number") ? total - paid : null;

    if (total == null) {
      throw new Error("summary-v2 response missing totalSubscribersEnd field");
    }

    const result = {
      timestamp: new Date().toISOString(),
      total,
      free,
      paid,
      source: "stats-api",
      sourceUrl: apiUrl,
    };

    await mkdir(path.dirname(HISTORY_PATH), { recursive: true });
    await appendFile(HISTORY_PATH, JSON.stringify(result) + "\n");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    exitCode = 1;
    console.error("[sub-count] ERROR:", err?.message || err);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
    await cleanSingletonFiles().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
