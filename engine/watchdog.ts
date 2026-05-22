/**
 * SPECTRAL TERRAIN — WATCHDOG (OBSERVER MODE)
 *
 * Persistent process that monitors three input channels for geometric anomalies.
 * In observer mode: logs, scores, and records — never holds or blocks.
 * Promote to enforce mode after one full circadian cycle confirms centroid stability.
 *
 * Channel A — Filesystem Watch
 *   Watches source files for creates/modifies. Embeds and shatter-checks against
 *   the source-audit centroid. Flags files that don't belong to canonical geometry.
 *
 * Channel B — Agent Execution Intercept
 *   Receives intent payloads before tool calls execute. Embeds intent, queries terrain.
 *   In observer mode: logs geometric distance but never issues HOLD.
 *
 * Channel C — Slop-Canon Continuous Query
 *   Every embed that passes through A or B is also checked against slop-canon (1024-D).
 *   High cosine similarity to a known failure pattern is surfaced as a warning.
 *
 * Mode contract:
 *   observe  — log all events, never block. Safe during calibration and initial deployment.
 *   enforce  — HOLD on shatter > alarmThreshold or slop cosine > slopQueryCutoff.
 *              Promote only after centroid confirmed stable via npm run integrity.
 *
 * Usage:
 *   npx tsx engine/watchdog.ts --mode observe [--watch /path/to/watch] [--domain source-audit]
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { watch } from "fs";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, extname, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { embed, computeShatter } from "./embed.js";
import { loadCentroid } from "./calibrate.js";
import type { Domain } from "../contracts/terrain.contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────

const QDRANT_URL         = "http://127.0.0.1:6340";
const SLOP_CANON_COLL    = "slop-canon";
const OLLAMA_URL         = "http://127.0.0.1:11434";

// Default domain profile thresholds — per blue-team-autonomous-defense.md spec.
// These should be overridden by calibration/{domain}-profile.json when available.
// Fixed literals are a known limitation; profile-based config is the target state.
const DEFAULT_PROFILE = {
  watchThreshold:  0.05,   // shatter below = false alarm
  alarmThreshold:  0.15,   // shatter above = threat intake opens (enforce mode only)
  slopQueryCutoff: 0.85,   // cosine above = slop-canon match
};

// File extensions monitored by Channel A
const WATCH_EXTENSIONS = new Set([".ts", ".js", ".py", ".lua", ".luau"]);

// ─────────────────────────────────────────────────────────────────
// WATCHDOG MODE
// ─────────────────────────────────────────────────────────────────

type WatchdogMode = "observe" | "enforce";

// ─────────────────────────────────────────────────────────────────
// EVENT LOG — append-only, written to telemetry/watchdog-events.jsonl
// ─────────────────────────────────────────────────────────────────

interface WatchdogEvent {
  timestamp:   string;
  mode:        WatchdogMode;
  channel:     "A-filesystem" | "B-execution" | "C-slop-canon";
  file?:       string;
  intent?:     string;
  shatter?:    number;
  slopScore?:  number;
  severity:    "clean" | "watch" | "alarm";
  action:      "logged" | "held";  // held only possible in enforce mode
  detail?:     string;
}

const telemetryDir = join(__dirname, "../telemetry");
mkdirSync(telemetryDir, { recursive: true });
const EVENT_LOG = join(telemetryDir, "watchdog-events.jsonl");

function logEvent(event: WatchdogEvent): void {
  const line = JSON.stringify(event) + "\n";
  writeFileSync(EVENT_LOG, line, { flag: "a" });

  const tag = event.severity === "alarm" ? "[ALARM]"
            : event.severity === "watch" ? "[WATCH]"
            : "[clean]";
  const src = event.file ?? event.intent ?? "unknown";
  console.log(`${tag} [${event.channel}] ${src} | shatter: ${event.shatter?.toFixed(4) ?? "—"} | action: ${event.action}`);
}

// ─────────────────────────────────────────────────────────────────
// SLOP-CANON QUERY (Channel C)
// ─────────────────────────────────────────────────────────────────

async function querySlopCanon(vec: number[]): Promise<{ score: number; title: string } | null> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${SLOP_CANON_COLL}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector: vec, limit: 1, with_payload: true }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { result: { score: number; payload: { title?: string } }[] };
    if (!data.result.length) return null;
    const top = data.result[0];
    return { score: top.score, title: top.payload?.title ?? "(unknown)" };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// GEOMETRIC ASSESSMENT — shared by Channel A and B
// ─────────────────────────────────────────────────────────────────

async function assessGeometry(
  text: string,
  domain: Domain,
  mode: WatchdogMode,
  channel: WatchdogEvent["channel"],
  source: string,
): Promise<void> {
  const centroid = loadCentroid(domain);
  if (!centroid) {
    console.warn(`[watchdog] No centroid for domain ${domain} — skipping geometry check`);
    return;
  }

  let vec: number[];
  try {
    vec = await embed(text);
  } catch (err: any) {
    console.error(`[watchdog] embed failed for ${source}: ${err.message}`);
    return;
  }

  const shatter = computeShatter(vec, centroid);

  // Channel C: slop-canon check on every embed
  const slop = await querySlopCanon(vec);
  if (slop && slop.score >= DEFAULT_PROFILE.slopQueryCutoff) {
    logEvent({
      timestamp: new Date().toISOString(),
      mode,
      channel: "C-slop-canon",
      file: channel === "A-filesystem" ? source : undefined,
      intent: channel === "B-execution" ? source : undefined,
      shatter,
      slopScore: slop.score,
      severity: "alarm",
      action:   mode === "enforce" ? "held" : "logged",
      detail:   `slop-canon match: "${slop.title}" (cosine ${slop.score.toFixed(4)})`,
    });
  }

  const severity: WatchdogEvent["severity"] =
    shatter >= DEFAULT_PROFILE.alarmThreshold ? "alarm"
    : shatter >= DEFAULT_PROFILE.watchThreshold ? "watch"
    : "clean";

  logEvent({
    timestamp: new Date().toISOString(),
    mode,
    channel,
    file:   channel === "A-filesystem" ? source : undefined,
    intent: channel === "B-execution"  ? source : undefined,
    shatter,
    severity,
    action: "logged",  // observer mode: always logged, never held
    detail: severity === "alarm"
      ? `shatter ${shatter.toFixed(4)} > alarm threshold ${DEFAULT_PROFILE.alarmThreshold} — threat intake would open in enforce mode`
      : severity === "watch"
      ? `shatter ${shatter.toFixed(4)} > watch threshold ${DEFAULT_PROFILE.watchThreshold}`
      : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────
// CHANNEL A — Filesystem Watch
// ─────────────────────────────────────────────────────────────────

function startFilesystemWatch(watchPath: string, domain: Domain, mode: WatchdogMode): void {
  if (!existsSync(watchPath)) {
    console.error(`[watchdog] Watch path does not exist: ${watchPath}`);
    return;
  }

  console.log(`[watchdog] Channel A — watching ${watchPath} (domain: ${domain})`);

  watch(watchPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (!WATCH_EXTENSIONS.has(extname(filename))) return;

    const fullPath = join(watchPath, filename);
    if (!existsSync(fullPath)) return;

    let source: string;
    try {
      source = readFileSync(fullPath, "utf-8");
    } catch {
      return;
    }
    if (source.trim().length < 10) return;

    const relPath = relative(watchPath, fullPath);
    assessGeometry(source, domain, mode, "A-filesystem", relPath).catch(console.error);
  });
}

// ─────────────────────────────────────────────────────────────────
// CHANNEL B — Agent Execution Intercept (HTTP listener)
//
// Agents POST intent payloads to this endpoint before executing tool calls.
// Payload: { tool: string, args: Record<string,unknown>, code_to_write?: string, domain?: Domain }
// Response (observer mode): { action: "proceed", shatter: number, severity: string }
// Response (enforce mode):  { action: "hold" | "proceed", shatter: number, severity: string }
//
// Wire point: agent/loop/agent-loop.ts — pre-tool-call hook.
// ─────────────────────────────────────────────────────────────────

const INTERCEPT_PORT = 7340;

function startExecutionIntercept(domain: Domain, mode: WatchdogMode): void {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/intercept") {
      res.writeHead(404); res.end(); return;
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      let payload: { tool?: string; args?: unknown; code_to_write?: string; domain?: Domain };
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: "invalid JSON" })); return;
      }

      // Embed the intent — prefer code_to_write, fall back to JSON stringification
      const intentText = payload.code_to_write
        ?? JSON.stringify({ tool: payload.tool, args: payload.args });
      const intentDomain = payload.domain ?? domain;

      const centroid = loadCentroid(intentDomain);
      if (!centroid) {
        res.writeHead(200);
        res.end(JSON.stringify({ action: "proceed", detail: `no centroid for ${intentDomain}` }));
        return;
      }

      let vec: number[];
      try { vec = await embed(intentText); }
      catch (err: any) {
        res.writeHead(200);
        res.end(JSON.stringify({ action: "proceed", detail: `embed failed: ${err.message}` }));
        return;
      }

      const shatter = computeShatter(vec, centroid);
      const severity: WatchdogEvent["severity"] =
        shatter >= DEFAULT_PROFILE.alarmThreshold ? "alarm"
        : shatter >= DEFAULT_PROFILE.watchThreshold ? "watch"
        : "clean";

      // Observer mode: always proceed, log the geometry
      const action = mode === "enforce" && severity === "alarm" ? "held" : "logged";

      logEvent({
        timestamp: new Date().toISOString(),
        mode,
        channel: "B-execution",
        intent: `${payload.tool ?? "unknown"} → ${intentDomain}`,
        shatter,
        severity,
        action,
        detail: severity === "alarm"
          ? `tool call would be held in enforce mode (shatter ${shatter.toFixed(4)})`
          : undefined,
      });

      res.writeHead(200);
      res.end(JSON.stringify({
        action:   action === "held" ? "hold" : "proceed",
        shatter,
        severity,
        mode,
      }));
    });
  });

  server.listen(INTERCEPT_PORT, () => {
    console.log(`[watchdog] Channel B — execution intercept listening on :${INTERCEPT_PORT}`);
  });
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const modeArg  = args[args.indexOf("--mode") + 1] as WatchdogMode ?? "observe";
  const watchArg = args.indexOf("--watch") !== -1 ? args[args.indexOf("--watch") + 1] : undefined;
  const domainIdx = args.indexOf("--domain");
  const domain   = (domainIdx !== -1 ? args[domainIdx + 1] : "source-audit") as Domain;

  if (modeArg !== "observe" && modeArg !== "enforce") {
    console.error(`[watchdog] Unknown mode: ${modeArg}. Use --mode observe or --mode enforce`);
    process.exit(1);
  }

  if (modeArg === "enforce") {
    console.warn(`[watchdog] ⚠️  ENFORCE MODE — geometric alarms will issue HOLD signals`);
    console.warn(`[watchdog] Only use enforce mode after centroid stability confirmed via npm run integrity`);
  } else {
    console.log(`[watchdog] Observer mode — logging all events, no enforcement actions`);
  }

  console.log(`[watchdog] Domain: ${domain} | Event log: ${EVENT_LOG}`);

  // Check Ollama is available
  const check = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!check?.ok) {
    console.error("[watchdog] Ollama not responding — cannot embed. Is it running?");
    process.exit(1);
  }

  // Start Channel B (always active — listens for agent tool call intercepts)
  startExecutionIntercept(domain, modeArg);

  // Start Channel A if a watch path was provided
  if (watchArg) {
    startFilesystemWatch(watchArg, domain, modeArg);
  } else {
    console.log(`[watchdog] Channel A — inactive (no --watch path provided)`);
  }

  console.log(`[watchdog] Running. Ctrl+C to stop.`);
}

main().catch(err => {
  console.error(`[watchdog] Fatal: ${err.message}`);
  process.exit(1);
});
