/**
 * SPECTRAL TERRAIN — QUERY SERVER
 *
 * HTTP API wrapping the three core query functions + SSE telemetry stream.
 * Runs on :7341 (watchdog intercept is :7340).
 *
 * Routes:
 *   GET  /health              → Qdrant + Ollama liveness
 *   GET  /centroid/:domain    → centroid metadata (dim, corpusSize, computedAt)
 *   GET  /events/stream       → SSE stream of watchdog-events.jsonl
 *   POST /query               → queryNearest(text, domain, topK)
 *   POST /shatter             → getShatterReport(file, text, domain)
 *   POST /slop                → querySlop(pattern, topK)
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync, statSync, watch } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { queryNearest, getShatterReport, querySlop } from "./query.js";
import type { Domain } from "../contracts/terrain.contract.js";
import { DOMAIN_GEOMETRY } from "../contracts/terrain.contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT           = 7341;
const QDRANT_URL     = "http://127.0.0.1:6340";
const OLLAMA_URL     = "http://127.0.0.1:11434";
const EVENT_LOG      = join(__dirname, "../telemetry/watchdog-events.jsonl");
const CALIBRATION    = join(__dirname, "../calibration");

const VALID_DOMAINS = new Set<Domain>(Object.keys(DOMAIN_GEOMETRY) as Domain[]);

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":  "application/json",
    "Access-Control-Allow-Origin": "*",
    "Connection":    "close",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end",  () => resolve(body));
    req.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────

async function handleHealth(res: ServerResponse): Promise<void> {
  const [qdrant, ollama] = await Promise.all([
    fetch(`${QDRANT_URL}/healthz`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
    fetch(`${OLLAMA_URL}/api/tags`,  { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
  ]);
  json(res, 200, { status: qdrant && ollama ? "ok" : "degraded", qdrant, ollama });
}

// ─────────────────────────────────────────────────────────────────
// CENTROID METADATA
// ─────────────────────────────────────────────────────────────────

function handleCentroid(res: ServerResponse, domain: string): void {
  if (!VALID_DOMAINS.has(domain as Domain)) {
    json(res, 400, { error: `Unknown domain: ${domain}` }); return;
  }
  const p = join(CALIBRATION, `${domain}-centroid.json`);
  if (!existsSync(p)) {
    json(res, 404, { error: `No centroid for domain: ${domain}` }); return;
  }
  const raw = JSON.parse(readFileSync(p, "utf-8")) as {
    domain: string; computedAt: string; corpusSize: number; stability: number; label: string; vector: number[];
  };
  json(res, 200, {
    domain:      raw.domain,
    dim:         raw.vector.length,
    corpusSize:  raw.corpusSize,
    stability:   raw.stability,
    label:       raw.label,
    computedAt:  raw.computedAt,
  });
}

// ─────────────────────────────────────────────────────────────────
// SSE — watchdog-events.jsonl tail
// ─────────────────────────────────────────────────────────────────

function handleEventsStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type":                "text/event-stream",
    "Cache-Control":               "no-cache",
    "Connection":                  "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 3000\n\n");

  // Heartbeat every 15s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);

  // Track file size so we only send new lines
  let lastSize = existsSync(EVENT_LOG) ? statSync(EVENT_LOG).size : 0;

  const watcher = watch(EVENT_LOG, () => {
    if (!existsSync(EVENT_LOG)) return;
    const currentSize = statSync(EVENT_LOG).size;
    if (currentSize <= lastSize) return;

    const fd = readFileSync(EVENT_LOG, "utf-8");
    const newContent = fd.slice(lastSize);
    lastSize = currentSize;

    for (const line of newContent.split("\n")) {
      if (!line.trim()) continue;
      res.write(`data: ${line}\n\n`);
    }
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    watcher.close();
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /query
// ─────────────────────────────────────────────────────────────────

async function handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { text?: string; domain?: string; topK?: number };
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: "invalid JSON" }); return; }

  const { text, domain, topK = 5 } = body;
  if (!text || typeof text !== "string") { json(res, 400, { error: "text required" }); return; }
  if (!domain || !VALID_DOMAINS.has(domain as Domain)) {
    json(res, 400, { error: `domain required, one of: ${[...VALID_DOMAINS].join(", ")}` }); return;
  }

  try {
    const results = await queryNearest(text, domain as Domain, topK);
    json(res, 200, { domain, topK, results });
  } catch (err: unknown) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /shatter
// ─────────────────────────────────────────────────────────────────

async function handleShatter(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { file?: string; text?: string; domain?: string };
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: "invalid JSON" }); return; }

  const { file = "unknown", text, domain } = body;
  if (!text || typeof text !== "string") { json(res, 400, { error: "text required" }); return; }
  if (!domain || !VALID_DOMAINS.has(domain as Domain)) {
    json(res, 400, { error: `domain required, one of: ${[...VALID_DOMAINS].join(", ")}` }); return;
  }

  try {
    const report = await getShatterReport(file, text, domain as Domain);
    json(res, 200, report);
  } catch (err: unknown) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /slop
// ─────────────────────────────────────────────────────────────────

async function handleSlop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { pattern?: string; topK?: number };
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: "invalid JSON" }); return; }

  const { pattern, topK = 3 } = body;
  if (!pattern || typeof pattern !== "string") { json(res, 400, { error: "pattern required" }); return; }

  try {
    const results = await querySlop(pattern, topK);
    json(res, 200, { results });
  } catch (err: unknown) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url    = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  if (method === "GET" && url === "/health") { await handleHealth(res); return; }
  if (method === "GET" && url === "/events/stream") { handleEventsStream(req, res); return; }

  const centroidMatch = url.match(/^\/centroid\/(.+)$/);
  if (method === "GET" && centroidMatch) { handleCentroid(res, centroidMatch[1]); return; }

  if (method === "POST" && url === "/query")   { await handleQuery(req, res);   return; }
  if (method === "POST" && url === "/shatter") { await handleShatter(req, res); return; }
  if (method === "POST" && url === "/slop")    { await handleSlop(req, res);    return; }

  json(res, 404, { error: "not found" });
});

server.keepAliveTimeout = 30_000;
server.headersTimeout   = 35_000;

server.listen(PORT, () => {
  console.log(`[query-server] Spectral-Terrain Query API listening on :${PORT}`);
  console.log(`[query-server] Routes: GET /health /events/stream /centroid/:domain | POST /query /shatter /slop`);
});
