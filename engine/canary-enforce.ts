/**
 * SPECTRAL TERRAIN — ENFORCE CANARY
 *
 * Runs a controlled enforce-mode canary:
 *   1. Starts watchdog in enforce mode as a child process
 *   2. Waits for Channel B to come online
 *   3. Sends N known-safe source files through /intercept
 *   4. Reads telemetry/watchdog-events.jsonl for the canary window
 *   5. Prints classification summary + lists any unexpected HOLD events
 *   6. Kills watchdog and exits with code 0 (pass) or 1 (fail)
 *
 * Usage:
 *   npx tsx engine/canary-enforce.ts [--count 30] [--domain source-audit]
 *
 * Success gates:
 *   - Zero system errors (embed/net failures)
 *   - No systemic HOLD flapping (≤ 10% alarm rate on known-safe files)
 *   - All defense artifacts produced by genuine alarms have selfCheckPass=true
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { spawn, ChildProcess } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TERRAIN_ROOT = join(__dirname, "..");
const ENGINE_ROOT  = __dirname;

const INTERCEPT_URL  = "http://127.0.0.1:7340/intercept";
const EVENTS_LOG     = join(TERRAIN_ROOT, "telemetry/watchdog-events.jsonl");
const DEFENSE_DIR    = join(TERRAIN_ROOT, "defense");
const REPORTS_DIR    = join(DEFENSE_DIR, "reports");
const SOURCES_ROOT   = join(TERRAIN_ROOT);

// ── CLI args ─────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const countIdx  = args.indexOf("--count");
const domainIdx = args.indexOf("--domain");
const count  = countIdx  !== -1 ? (parseInt(args[countIdx  + 1]) || 30) : 30;
const domain = domainIdx !== -1 ? (args[domainIdx + 1] ?? "roblox-luau") : "roblox-luau";

// ── File walker ───────────────────────────────────────────────────────────────

// Domain → file extensions for canary source selection
const DOMAIN_EXTS: Record<string, Set<string>> = {
  "roblox-luau":  new Set([".lua", ".luau"]),
  "source-audit": new Set([".ts", ".py", ".go", ".rs", ".java"]),
  "general":      new Set([".ts", ".js", ".py"]),
};
const SOURCE_EXTS = DOMAIN_EXTS[domain] ?? new Set([".ts", ".py", ".js", ".lua", ".luau"]);

function walkSources(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st   = statSync(full);
    if (st.isDirectory()) {
      walkSources(full, results);
    } else if (SOURCE_EXTS.has(extname(entry)) && st.size > 50 && st.size < 200_000) {
      results.push(full);
    }
  }
  return results;
}

// ── Wait for watchdog Channel B ───────────────────────────────────────────────

async function waitForIntercept(maxMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  // Phase 1: wait for the HTTP server to accept connections (fast check, no body processing)
  while (Date.now() < deadline) {
    try {
      // Send invalid JSON — watchdog returns 400 immediately without touching the embed path
      const res = await fetch(INTERCEPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "PROBE",  // intentionally invalid JSON → 400 from watchdog, no embed
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200 || res.status === 400) return true;
    } catch {
      // server not up yet — keep polling
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

// ── Send one intercept ────────────────────────────────────────────────────────

interface InterceptResult {
  file:    string;
  action:  string;
  shatter: number | null;
  severity: string | null;
  error?:  string;
}

async function sendIntercept(filePath: string): Promise<InterceptResult> {
  const rel = relative(TERRAIN_ROOT, filePath);
  let code: string;
  try {
    code = readFileSync(filePath, "utf-8");
  } catch (e: any) {
    return { file: rel, action: "error", shatter: null, severity: null, error: `read: ${e.message}` };
  }

  try {
    const res = await fetch(INTERCEPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool:           "Write",
        args:           { file_path: filePath },
        code_to_write:  code,
        domain,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json() as any;
    return {
      file:     rel,
      action:   body.action ?? "unknown",
      shatter:  typeof body.shatter === "number" ? body.shatter : null,
      severity: body.severity ?? null,
    };
  } catch (e: any) {
    return { file: rel, action: "error", shatter: null, severity: null, error: `fetch: ${e.message}` };
  }
}

// ── Read event log for canary window ─────────────────────────────────────────

interface WatchdogEvent {
  timestamp:  string;
  mode:       string;
  channel:    string;
  severity:   "clean" | "watch" | "alarm";
  action:     "logged" | "held";
  shatter?:   number;
  intent?:    string;
  detail?:    string;
}

function readEventsSince(ts: Date): WatchdogEvent[] {
  if (!existsSync(EVENTS_LOG)) return [];
  return readFileSync(EVENTS_LOG, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) as WatchdogEvent; } catch { return null; } })
    .filter((e): e is WatchdogEvent => e !== null && new Date(e.timestamp) >= ts);
}

// ── Check defense artifacts ───────────────────────────────────────────────────

function checkDefenseArtifacts(): { total: number; selfCheckPass: number; selfCheckFail: number } {
  if (!existsSync(REPORTS_DIR)) return { total: 0, selfCheckPass: 0, selfCheckFail: 0 };
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith(".report.json"));
  let pass = 0, fail = 0;
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(REPORTS_DIR, f), "utf-8")) as any;
      if (r.patch?.selfCheckPass === true)  pass++;
      else if (r.patch?.selfCheckPass === false) fail++;
    } catch { /* skip */ }
  }
  return { total: files.length, selfCheckPass: pass, selfCheckFail: fail };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(` SPECTRAL TERRAIN — ENFORCE CANARY`);
  console.log(` Domain: ${domain} | Target intercepts: ${count}`);
  console.log(`══════════════════════════════════════════════════\n`);

  // ── 1. Collect source files for canary ──────────────────────────────────────
  const allFiles = walkSources(SOURCES_ROOT);
  const candidates = allFiles.filter(f => !f.includes("canary-enforce")).slice(0, count);

  if (candidates.length < 5) {
    console.error(`[canary] Not enough source files found (${candidates.length}). Abort.`);
    process.exit(1);
  }
  console.log(`[canary] Found ${candidates.length} source file(s) to use as canary payloads.`);

  // ── 2. Start watchdog in enforce mode ───────────────────────────────────────
  console.log(`[canary] Starting watchdog in enforce mode...`);
  const watchdogProc: ChildProcess = spawn(
    "npx", ["tsx", "engine/watchdog.ts", "--mode", "enforce", "--domain", domain],
    {
      cwd:   TERRAIN_ROOT,
      env:   { ...process.env, WATCHDOG_ENFORCE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  let watchdogOutput = "";
  watchdogProc.stdout?.on("data", (d: Buffer) => {
    const line = d.toString();
    watchdogOutput += line;
    process.stdout.write(`  [watchdog] ${line}`);
  });
  watchdogProc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    watchdogOutput += line;
    process.stderr.write(`  [watchdog:err] ${line}`);
  });

  // ── 3. Wait for Channel B to come online ────────────────────────────────────
  console.log(`[canary] Waiting for Channel B (:7340/intercept)...`);
  const ready = await waitForIntercept(20_000);
  if (!ready) {
    console.error(`[canary] Watchdog did not come online within 20s. Aborting.`);
    watchdogProc.kill("SIGTERM");
    process.exit(1);
  }
  console.log(`[canary] Channel B online.\n`);

  const canaryStart = new Date();

  // ── 4. Send intercepts sequentially (avoid embed queue saturation) ───────────
  const results: InterceptResult[] = [];
  console.log(`[canary] Sending ${candidates.length} intercepts (sequential, 1 concurrency)...\n`);

  for (let i = 0; i < candidates.length; i++) {
    const r = await sendIntercept(candidates[i]);
    results.push(r);
    const icon = r.action === "hold"  ? "[HOLD ]"
               : r.action === "error" ? "[ERROR]"
               : r.severity === "alarm" ? "[alarm]"
               : r.severity === "watch" ? "[watch]"
               : "[clean]";
    console.log(`  ${String(i+1).padStart(3)}/${candidates.length} ${icon} shatter:${r.shatter?.toFixed(4) ?? "    —"} ${r.file}${r.error ? ` — ${r.error}` : ""}`);
  }

  // ── 5. Read event log for canary window ─────────────────────────────────────
  const events = readEventsSince(canaryStart);
  const bEvents = events.filter(e => e.channel === "B-execution");

  // ── 6. Classification summary ────────────────────────────────────────────────
  const errCount    = results.filter(r => r.action === "error").length;
  const holdCount   = results.filter(r => r.action === "hold").length;
  const cleanCount  = results.filter(r => r.severity === "clean").length;
  const watchCount  = results.filter(r => r.severity === "watch").length;
  const alarmCount  = results.filter(r => r.severity === "alarm").length;
  const alarmRate   = candidates.length > 0 ? alarmCount / candidates.length : 0;

  const artifacts   = checkDefenseArtifacts();
  const selfCheckOk = artifacts.selfCheckFail === 0;

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(` CANARY RESULTS`);
  console.log(`══════════════════════════════════════════════════`);
  console.log(` Intercepts sent  : ${candidates.length}`);
  console.log(` clean            : ${cleanCount}`);
  console.log(` watch            : ${watchCount}`);
  console.log(` alarm            : ${alarmCount}  (${(alarmRate*100).toFixed(1)}%)`);
  console.log(` hold (blocked)   : ${holdCount}`);
  console.log(` errors           : ${errCount}`);
  console.log(`──────────────────────────────────────────────────`);
  console.log(` Defense artifacts: ${artifacts.total} reports`);
  console.log(` Self-check pass  : ${artifacts.selfCheckPass}`);
  console.log(` Self-check FAIL  : ${artifacts.selfCheckFail}`);
  console.log(`──────────────────────────────────────────────────`);

  // ── 7. Gate evaluation ───────────────────────────────────────────────────────
  const gate1 = errCount === 0;
  const gate2 = alarmRate <= 0.10 && holdCount === 0;  // ≤10% alarm on known-safe, no holds
  const gate3 = selfCheckOk;

  console.log(` Gate 1 — zero errors          : ${gate1 ? "PASS" : "FAIL"} (errors: ${errCount})`);
  console.log(` Gate 2 — no HOLD flapping     : ${gate2 ? "PASS" : "FAIL"} (alarm rate: ${(alarmRate*100).toFixed(1)}%, holds: ${holdCount})`);
  console.log(` Gate 3 — self-check pass rate : ${gate3 ? "PASS" : "FAIL"} (fail: ${artifacts.selfCheckFail})`);
  console.log(`══════════════════════════════════════════════════`);

  const allGreen = gate1 && gate2 && gate3;
  if (allGreen) {
    console.log(` STATUS: ALL GATES GREEN — enforce mode is safe to promote to full feed.`);
  } else {
    console.log(` STATUS: GATES FAILED — review events and artifacts before full feed.`);
    if (holdCount > 0) {
      console.log(`\n HOLD events (unexpected — these are safe files):`);
      results.filter(r => r.action === "hold").forEach(r =>
        console.log(`   → ${r.file} | shatter: ${r.shatter?.toFixed(4)}`)
      );
    }
    if (artifacts.selfCheckFail > 0) {
      console.log(`\n Self-check failures in defense/reports/ need manual review.`);
    }
  }

  // ── 8. Write canary summary JSON ─────────────────────────────────────────────
  const summary = {
    timestamp:    canaryStart.toISOString(),
    domain,
    totalSent:    candidates.length,
    clean:        cleanCount,
    watch:        watchCount,
    alarm:        alarmCount,
    alarmRatePct: parseFloat((alarmRate * 100).toFixed(2)),
    hold:         holdCount,
    errors:       errCount,
    defenseArtifacts: artifacts,
    gates:        { gate1, gate2, gate3, allGreen },
    results,
  };
  const summaryPath = join(TERRAIN_ROOT, "telemetry/canary-enforce-result.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n Summary written → ${summaryPath}`);
  console.log(`══════════════════════════════════════════════════\n`);

  // Kill watchdog
  watchdogProc.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 500));

  process.exit(allGreen ? 0 : 1);
}

main().catch(err => {
  console.error(`[canary] Fatal: ${err.message}`);
  process.exit(1);
});
