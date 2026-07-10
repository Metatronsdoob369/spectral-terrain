/**
 * SPECTRAL TERRAIN — INGEST ENGINE
 *
 * Run any codebase through this to populate the terrain.
 * Usage: npx tsx engine/ingest.ts --domain roblox-luau --path /path/to/repo
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, extname, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { buildPlaceholderVector, buildTemporalVector, buildSingleEmbed, computeHeat, computeShatter } from "./embed.js";
import { DOMAIN_GEOMETRY, TERRAIN_PAYLOAD_VERSION } from "../contracts/terrain.contract.js";
import type { Domain, TerrainPoint, TPlusonMethodSchema } from "../contracts/terrain.contract.js";
import type { z } from "zod";
import { loadCentroid } from "./calibrate.js";
import { tplus1FromState } from "../domains/roblox-luau-tplus1.js";
import type { GameState } from "../contracts/roblox-luau.domain.js";
import { validateLabel, printLabelAuditSummary } from "./label-validator.js";
import { runDriftSidecar } from "./drift-sidecar.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";         // temporal domains (dim * 3)
const HEATMAP_STATIC_COLLECTION = `spectral-heatmap-${process.env.EMBED_DIM || 1024}`; // static domains

const STATIC_DIM = parseInt(process.env.EMBED_DIM || "1024", 10);

const DOMAIN_EXTENSIONS: Record<Domain, string[]> = {
  "roblox-luau":    [".lua", ".luau"],
  "finance-crypto": [".ts", ".js", ".py", ".sol"],
  "source-audit":   [".ts", ".py", ".go", ".rs", ".java"],
  "general":        [".ts", ".js", ".py", ".lua", ".luau"],
  "memory":         [".md", ".txt"],
};

// ─────────────────────────────────────────────────────────────────
// ENSURE COLLECTION EXISTS
// ─────────────────────────────────────────────────────────────────

async function ensureCollection(domain: Domain) {
  const geometry = DOMAIN_GEOMETRY[domain];
  const dim = geometry.temporal ? STATIC_DIM * 3 : STATIC_DIM;
  const collection = geometry.temporal ? HEATMAP_COLLECTION : HEATMAP_STATIC_COLLECTION;

  const res = await fetch(`${QDRANT_URL}/collections/${collection}`, { method: "GET" });
  if (res.ok) return;

  await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: { size: dim, distance: "Cosine" },
    }),
  });
  console.log(`✅ Created Qdrant collection: ${collection} (dim=${dim})`);
}

// ─────────────────────────────────────────────────────────────────
// PRE-INGEST FILTER — sanitize source before it touches Ollama
// Prevents Bad Request errors from mxbai-embed-large rejecting non-ASCII:
// box-drawing chars (═ ─ ↔), em dashes, arrows, emoji, surrogates, null bytes.
// Preserves newlines and tabs so code structure is intact for the embedder.
// ─────────────────────────────────────────────────────────────────

function preIngestFilter(source: string): { text: string; stripped: number } {
  let text = source;
  const before = text.length;

  // Replace everything outside printable ASCII + whitespace (\n \r \t) with a space.
  // This covers: box-drawing (U+2500+), em dashes, arrows, 2/3/4-byte emoji,
  // lone surrogates, null bytes — anything the mxbai tokenizer rejects.
  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ");

  // Collapse horizontal whitespace runs left by stripping (keep line breaks)
  text = text.replace(/[ \t]{3,}/g, "  ");

  return { text: text.trim(), stripped: before - text.length };
}

// ─────────────────────────────────────────────────────────────────
// WALK REPO
// ─────────────────────────────────────────────────────────────────

function walkRepo(rootPath: string, extensions: string[]): string[] {
  const files: string[] = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", "venv", "plugins"]);

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.includes(extname(entry)) && !entry.endsWith('.d.ts') && !entry.endsWith('.js.map')) {
        files.push(full);
      }
    }
  }
  walk(rootPath);
  return files;
}

// ─────────────────────────────────────────────────────────────────
// UPSERT TO QDRANT
// ─────────────────────────────────────────────────────────────────

async function upsertPoint(point: TerrainPoint, vector: number[]) {
  const collection = DOMAIN_GEOMETRY[point.domain].temporal ? HEATMAP_COLLECTION : HEATMAP_STATIC_COLLECTION;
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{
        id:      point.id,
        vector,
        payload: point,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Qdrant upsert failed: ${res.statusText}`);
}

// ─────────────────────────────────────────────────────────────────
// MAIN INGEST
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// OLLAMA READINESS GATE — wait until embedder is free before starting
// Prevents silent hang when multiple ingests compete for the same Ollama instance
// ─────────────────────────────────────────────────────────────────

const LOCK_FILE = "/tmp/spectral-terrain-ingest.lock";
const OLLAMA_URL = "http://127.0.0.1:11434";

async function waitForOllama(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Ollama not responding after 60s — is it running?");
}

async function acquireLock(): Promise<void> {
  const { existsSync, readFileSync: rfs } = await import("fs");
  while (existsSync(LOCK_FILE)) {
    const pid = existsSync(LOCK_FILE) ? rfs(LOCK_FILE, "utf-8").trim() : "";
    // Check if the PID in the lock is actually alive — auto-clear stale locks
    try {
      process.kill(parseInt(pid), 0); // signal 0 = existence check, no kill
      console.log(`⏳ Another ingest is running (PID ${pid}) — waiting 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    } catch {
      // PID is dead — stale lock, clear it and proceed
      console.log(`⚠️  Stale lock detected (PID ${pid} is dead) — clearing and proceeding`);
      try { require("fs").unlinkSync(LOCK_FILE); } catch {}
      break;
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  // Release lock on exit
  const release = () => { try { require("fs").unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

// ─────────────────────────────────────────────────────────────────
// ROBLOX PHYSICS STATE EXTRACTOR
//
// Parses a synthetic GameState from Luau source text.
// Looks for Vector3.new(x,y,z) and CFrame.new(x,y,z) literals.
// Falls back to null if nothing parseable — caller degrades to placeholder.
// ─────────────────────────────────────────────────────────────────

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const SEP = "\\s*,\\s*";
const VEC3_RE  = new RegExp(`Vector3\\.new\\(\\s*${NUM}${SEP}${NUM}${SEP}${NUM}\\s*\\)`, "g");
const CFRAME_RE = new RegExp(`CFrame\\.new\\(\\s*${NUM}${SEP}${NUM}${SEP}${NUM}\\s*\\)`,  "g");

function extractGameState(source: string, fileName: string): GameState | null {
  const positions: [number, number, number][] = [];
  const velocities: [number, number, number][] = [];
  const identityRotation: [number,number,number,number,number,number,number,number,number] = [1,0,0,0,1,0,0,0,1];

  // Reset lastIndex before matchAll (regex is module-level with /g flag)
  VEC3_RE.lastIndex = 0;
  CFRAME_RE.lastIndex = 0;

  for (const m of source.matchAll(VEC3_RE)) {
    const v: [number, number, number] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
    if (positions.length === 0)       positions.push(v);
    else if (velocities.length === 0) velocities.push(v);
  }

  for (const m of source.matchAll(CFRAME_RE)) {
    if (positions.length === 0) {
      positions.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    }
  }

  if (positions.length === 0) return null;  // nothing parseable

  const scriptName = fileName.replace(/\.(lua|luau)$/, "");

  return {
    tick: 0,
    scripts: [{
      name:     scriptName,
      source,
      cframe:   { position: positions[0], rotation: identityRotation },
      velocity: velocities[0] ?? [0, 0, 0],
    }],
    constraints: [],
    memoryUsage: Math.ceil(source.length / 1024),
  };
}

export async function ingestRepo(repoPath: string, domain: Domain, markAsCanonical = false) {
  await waitForOllama();
  await acquireLock();
  await ensureCollection(domain);

  const extensions = DOMAIN_EXTENSIONS[domain];
  const files = walkRepo(repoPath, extensions);
  const centroid = loadCentroid(domain);

  console.log(`\n🌐 Ingesting ${files.length} files into spectral terrain`);
  console.log(`   Domain: ${domain} | Canonical: ${markAsCanonical} | Centroid: ${centroid ? "loaded" : "not yet calibrated"}\n`);

  const results: { file: string; shatter: number; heat: number; recommendation: string }[] = [];
  const labelAuditResults: Array<{ file: string; meta: import("../contracts/terrain.contract.js").LabelMeta }> = [];

  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8");
      if (raw.trim().length < 10) continue;

      const { text: source, stripped } = preIngestFilter(raw);
      if (stripped > 0) process.stderr.write(`   [filter] ${relative(repoPath, file)} — stripped ${stripped} chars\n`);
      if (source.trim().length < 10) continue;

      // ── GEOMETRY GATE (contract-enforced) ────────────────────────
      // Check DOMAIN_GEOMETRY contract before any embed call.
      // Temporal domains (roblox-luau, finance-crypto): 3072-D [v_t-1|v_t|v_t+1]
      // Static domains (source-audit, general, memory): 1024-D single embed — NO concatenation.
      // Violating this wastes 3× embed cost and degrades centroid geometry with fake [v|v|v].
      const geometry = DOMAIN_GEOMETRY[domain];
      let tv: { concat: number[] };
      let tMethod: "physics-deterministic" | "single-embed" | "placeholder" = "placeholder";

      if (!geometry.temporal) {
        // CONTRACT: static domain — single embed, no concatenation
        const vec = await buildSingleEmbed(source);
        tv = { concat: vec };
        tMethod = "single-embed";
      } else if (domain === "roblox-luau") {
        const baseName = relative(repoPath, file).split("/").pop() ?? file;
        const gameState = extractGameState(source, baseName);
        if (gameState) {
          const tPlus1Text = tplus1FromState(gameState);
          tv = await buildTemporalVector(source, source, tPlus1Text);
          tMethod = "physics-deterministic";
        } else {
          tv = await buildPlaceholderVector(source);
        }
      } else {
        // finance-crypto or other temporal domain without t+1 implementation yet
        tv = await buildPlaceholderVector(source);
      }
      // ─────────────────────────────────────────────────────────────

      const heat    = computeHeat(tv.concat);
      const shatter = centroid ? computeShatter(tv.concat, centroid) : -1;
      const provHash = createHash("sha512").update(source).digest("hex").slice(0, 64);

      const kind = markAsCanonical ? "canonical"
        : shatter < 0 ? "pending"
        : shatter < 0.05 ? "canonical"
        : "shattered";

      // Label validation — roblox-luau only (shadow vocabulary audit)
      const labelMeta = domain === "roblox-luau"
        ? validateLabel(relative(repoPath, file), source)
        : undefined;

      if (labelMeta) {
        labelAuditResults.push({ file: relative(repoPath, file), meta: labelMeta });
        if (labelMeta.risk_class !== "clean") {
          process.stderr.write(`   [label] ${labelMeta.module_name} → ${labelMeta.risk_class}${labelMeta.api_collision ? " (API collision)" : ""}${labelMeta.casing_violations.length ? ` casing: ${labelMeta.casing_violations.join(",")}` : ""}\n`);
        }
      }

      const point: TerrainPoint = {
        id:             randomUUID(),
        domain,
        file:           relative(repoPath, file),
        kind,
        t_method:       tMethod,
        heat,
        shatter,
        hamming_sig:    "0000000000000000", // populated by DriftGuard post-ingest
        deltaVector3d:  null,
        deltaTarget:    null,
        label_meta:     labelMeta,
        ingestedAt:     new Date().toISOString(),
        provenanceHash: provHash,
        unicode_drift_risk:     stripped > 0,  // flag for re-embed when spectral-terrain-768 is live
        source_resolvable:      true,          // always true at ingest — file was read from disk
        payload_schema_version: TERRAIN_PAYLOAD_VERSION,
      };

      await upsertPoint(point, tv.concat);

      const tag = kind === "canonical" ? "✅" : kind === "shattered" ? "⚠️ " : "⏳";
      const driftTag = stripped > 0 ? " [unicode-drift]" : "";
      console.log(`${tag} ${relative(repoPath, file)} | heat: ${heat.toFixed(4)} | shatter: ${shatter >= 0 ? shatter.toFixed(4) : "pending"}${driftTag}`);
      results.push({ file: relative(repoPath, file), shatter, heat, recommendation: kind });
    } catch (err: any) {
      console.error(`❌ ${file}: ${err.message}`);
    }
  }

  // Write run summary
  const summary = {
    domain,
    repoPath,
    totalFiles: files.length,
    ingested: results.length,
    canonical: results.filter(r => r.recommendation === "canonical").length,
    shattered: results.filter(r => r.recommendation === "shattered").length,
    pending: results.filter(r => r.recommendation === "pending").length,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(
    join(__dirname, `../telemetry/ingest-${Date.now()}.json`),
    JSON.stringify(summary, null, 2)
  );

  console.log(`\n📊 Ingest complete:`);
  console.log(`   ✅ Canonical: ${summary.canonical}`);
  console.log(`   ⚠️  Shattered: ${summary.shattered}`);
  console.log(`   ⏳ Pending:   ${summary.pending}`);

  if (labelAuditResults.length > 0) {
    printLabelAuditSummary(labelAuditResults);
  }

  // Auto-run drift sidecar — scores unicode_drift_magnitude on all flagged points
  if (summary.ingested > 0) {
    await runDriftSidecar(domain).catch(err =>
      console.warn(`[drift-sidecar] skipped: ${err.message}`)
    );
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────

if (process.argv[1]?.includes("ingest")) {
  const args = process.argv.slice(2);
  const domainArg = args[args.indexOf("--domain") + 1] as Domain ?? "general";
  const pathArg   = args[args.indexOf("--path") + 1] ?? process.cwd();
  const canonical = args.includes("--canonical");

  ingestRepo(pathArg, domainArg, canonical).catch(console.error);
}
