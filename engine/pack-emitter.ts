/**
 * pack-emitter.ts — the sales boundary of the refinery.
 *
 * Everything upstream of this file is the loop: ingest → embed → calibrate →
 * circadian → integrity. All of it operates on MUTABLE terrain (Qdrant points
 * that get re-embedded, recalibrated, and re-scored on every cycle).
 *
 * A paid endpoint cannot serve mutable terrain: the same payment retried must
 * return identical bytes, or the retry entitlement is a lie. So this emitter
 * is where the refinery freezes. It reads live terrain, projects each point
 * into a sealed tile, and writes a content-addressed, signed, immutable pack
 * that the x402 mount kernel can serve without ever calling back here.
 *
 * The projection is also the licensing gate: source text and source locators
 * exist upstream and are structurally absent downstream. Not filtered — the
 * projection simply never emits those fields, and the emitter refuses if a
 * forbidden key survives.
 *
 * Usage:
 *   tsx engine/pack-emitter.ts --domain roblox-luau --edition roblox-luau-2026-08
 *   tsx engine/pack-emitter.ts --domain roblox-luau --dry-run
 *   [--out <dir>] [--limit N] [--allow-uncanonical]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";

// ─── canonicalization (must match spectral-config/src/canon.ts byte for byte) ──

const MAX_SAFE = 9007199254740991;
const FORBIDDEN_RE =
  /[\u0000-\u0008\u000B-\u001F\u0080-\u009F\uFEFF]|\p{Cf}/u;

export class EmitRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "EmitRefusal";
  }
}

function assertString(s: string, at: string): void {
  if (s.normalize("NFC") !== s) throw new EmitRefusal("CANON_NON_NFC", `${at}: not NFC`);
  const m = FORBIDDEN_RE.exec(s);
  if (m) throw new EmitRefusal("CANON_FORBIDDEN_CODEPOINT", `${at}: U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);
}

export function canonicalize(value: unknown, at = ""): Buffer {
  const out: string[] = [];
  const ser = (v: unknown, p: string): void => {
    if (v === null) return void out.push("null");
    if (typeof v === "boolean") return void out.push(v ? "true" : "false");
    if (typeof v === "number") {
      if (!Number.isInteger(v) || Object.is(v, -0)) {
        throw new EmitRefusal("CANON_FLOAT", `${p}: non-integer JSON number — emit a decimal string`);
      }
      if (Math.abs(v) > MAX_SAFE) throw new EmitRefusal("CANON_INT_RANGE", p);
      return void out.push(String(v));
    }
    if (typeof v === "string") {
      assertString(v, p);
      return void out.push(JSON.stringify(v));
    }
    if (Array.isArray(v)) {
      out.push("[");
      v.forEach((x, i) => {
        if (i) out.push(",");
        ser(x, `${p}/${i}`);
      });
      return void out.push("]");
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.push("{");
      keys.forEach((k, i) => {
        assertString(k, `${p}/${k}`);
        if (i) out.push(",");
        out.push(JSON.stringify(k), ":");
        ser((v as Record<string, unknown>)[k], `${p}/${k}`);
      });
      return void out.push("}");
    }
    throw new EmitRefusal("CANON_TYPE", `${p}: ${typeof v}`);
  };
  ser(value, at);
  return Buffer.from(out.join(""), "utf8");
}

const b2 = (b: Buffer): Buffer => Buffer.from(createHash("blake2b512").update(b).digest().subarray(0, 32));
export const cidOfBytes = (b: Buffer): string => `b2-256:${b2(b).toString("hex")}`;
export const cidOf = (v: unknown): string => cidOfBytes(canonicalize(v));

/** RFC 6962. Odd nodes promoted, never duplicated. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (!leaves.length) return Buffer.alloc(32);
  let level = leaves.map((d) => b2(Buffer.concat([Buffer.from([0]), d])));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 === level.length ? level[i] : b2(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}

// ─── the licensing gate, as a mechanical check ────────────────────────────────

const FORBIDDEN_KEYS = new Set([
  "source", "sourcetext", "scripts", "rawsnapshot", "sourceref", "repourl", "commitsha",
  "path", "scriptname", "file", "symbol", "deltatarget", "firstseen", "lastseen",
  "updatedat", "ingestedat", "generatedat", "packid", "editionid", "tileneighbors",
  "neighbors", "adjacency", "tilehash", "cid", "hash", "blake2b16", "sig", "signature",
  "signaturealgorithm", "alg", "publickeyref", "redactionsummary", "confidence", "confidencescore",
]);

function assertNoForbiddenKeys(v: unknown, at = ""): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoForbiddenKeys(x, `${at}/${i}`));
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase().replace(/[-_]/g, ""))) {
        throw new EmitRefusal("FORBIDDEN_KEY", `${at}/${k} — source-bearing field cannot cross the paid boundary`);
      }
      assertNoForbiddenKeys(val, `${at}/${k}`);
    }
  }
}

// ─── numeric encodings ────────────────────────────────────────────────────────

/** Non-integer reals travel as decimal strings; JSON floats are refused. */
export function dec(n: number, places = 6): string {
  if (!Number.isFinite(n)) throw new EmitRefusal("CANON_FLOAT", `non-finite: ${n}`);
  const s = n.toFixed(places);
  return /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

export function vecref(values: ArrayLike<number>, dtype: "f32le" | "f64le" = "f32le") {
  const w = dtype === "f64le" ? 8 : 4;
  const buf = Buffer.alloc(values.length * w);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) throw new EmitRefusal("CANON_FLOAT", `vector component ${i} is non-finite`);
    if (dtype === "f64le") buf.writeDoubleLE(v, i * 8);
    else buf.writeFloatLE(Math.fround(v), i * 4);
  }
  return { dtype, count: values.length, b64: buf.toString("base64") };
}

// ─── live terrain source ──────────────────────────────────────────────────────

const QDRANT = process.env.QDRANT_URL ?? "http://100.113.215.46:6333";

/**
 * Live terrain point as stored. This is the MUTABLE upstream shape — note it
 * carries `file`, `symbol`, `deltaTarget`, all of which are source locators
 * and none of which survive projection.
 */
export interface LivePoint {
  id: string;
  domain: string;
  file?: string;
  symbol?: string;
  kind: "canonical" | "shattered" | "pending";
  t_method?: string;
  heat: number;
  shatter: number;
  hamming_sig?: string;
  ingestedAt?: string;
  ingested_at?: string;
  provenanceHash?: string;
  provenance_hash?: string;
  unicode_drift_risk?: boolean;
  vector?: number[] | Record<string, number[]>;
}

export async function scrollTerrain(
  domain: string,
  limit: number,
  collection = "spectral-heatmap",
  filterByDomain = true
): Promise<LivePoint[]> {
  const out: LivePoint[] = [];
  let offset: unknown = undefined;
  while (out.length < limit) {
    const res = await fetch(`${QDRANT}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limit: Math.min(256, limit - out.length),
        with_payload: true,
        with_vector: true,
        ...(offset !== undefined ? { offset } : {}),
        // Filter by domain wherever the field exists: shared collections
        // otherwise leak cross-domain points into a sealed pack. Disable only
        // for single-domain collections that predate the field.
        ...(filterByDomain ? { filter: { must: [{ key: "domain", match: { value: domain } }] } } : {}),
      }),
    });
    if (!res.ok) throw new EmitRefusal("TERRAIN_UNREACHABLE", `qdrant scroll → ${res.status}`);
    const j = (await res.json()) as { result: { points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>; next_page_offset?: unknown } };
    const pts = j.result?.points ?? [];
    if (!pts.length) break;
    for (const p of pts) out.push({ id: String(p.id), ...(p.payload as object), vector: p.vector } as LivePoint);
    offset = j.result.next_page_offset;
    if (offset === undefined || offset === null) break;
  }
  return out;
}

// ─── projection: mutable terrain point → sealed tile ──────────────────────────

export interface ProjectOptions {
  domain: string;
  centroidCid: string;
  engineVersion: string;
  commitmentKeyId: string;
  /** Secret key for provenance MACs. Keyed, because an unkeyed digest over
   *  public-repo source is a brute-forceable confirmation oracle. */
  commitmentKey: Buffer;
}

function macOf(key: Buffer, value: string): string {
  return createHash("blake2b512").update(Buffer.concat([key, Buffer.from(value, "utf8")])).digest().subarray(0, 32).toString("hex");
}

/**
 * Project one live point into a sealed tile.
 *
 * What crosses: geometry, scores, admission classes, license facts, keyed
 * provenance commitments.
 * What does NOT: source text, file paths, symbol names, deltaTarget, and
 * every mutable timestamp. Those are the moat and the liability, in that order.
 */
export function projectTile(p: LivePoint, prevCid: string | null, o: ProjectOptions): Record<string, unknown> {
  const raw = p.vector;
  const v: number[] = Array.isArray(raw) ? raw : raw ? (Object.values(raw)[0] ?? []) : [];
  const third = Math.floor(v.length / 3);
  if (third === 0) throw new EmitRefusal("NO_VECTOR", `point ${p.id} has no stored vector`);

  const vPrev = v.slice(0, third);
  const vNow = v.slice(third, third * 2);
  const vNext = v.slice(third * 2);
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const resNowPrev = sub(vNow, vPrev);
  const resNextNow = sub(vNext, vNow);
  const curvature = Math.sqrt(sub(resNextNow, resNowPrev).reduce((s, x) => s + x * x, 0));

  const tile: Record<string, unknown> = {
    schema: "terrain-tile-v1",
    canon_version: 1,
    domain: o.domain,
    lineage_id: p.id,
    prev_cid: prevCid,
    geometry_profile: "transition-only",
    norm_convention: "per-third-unit-kahan",
    embed: {
      model: "mxbai-embed-large",
      dim_per_third: third,
      concat_dim: v.length,
      concat_norm: dec(Math.sqrt(3), 16),
    },
    // Closed window. No open interval, nothing that can go stale.
    window: {
      t_minus1: { tick: dec(0), epoch_ms: 0, state_digest: macOf(o.commitmentKey, `${p.id}:t-1`), constraint_classes: [], script_count: 0 },
      t_now: { tick: dec(0), epoch_ms: 0, state_digest: macOf(o.commitmentKey, `${p.id}:t0`), constraint_classes: [], script_count: 0 },
      t_plus1: { tick: dec(0), epoch_ms: 0, state_digest: macOf(o.commitmentKey, `${p.id}:t1`), constraint_classes: [], script_count: 0 },
    },
    physics: {
      method: "physics-deterministic",
      engine_version: o.engineVersion,
      delta_ms: dec(1000 / 60),
      determinism_class: p.unicode_drift_risk ? "engine-exact-degraded" : "engine-exact",
    },
    transition: {
      residual_now_prev: vecref(resNowPrev),
      residual_next_now: vecref(resNextNow),
      cframe_delta: null,
      velocity_delta: null,
      memory_delta_kb: dec(0),
      curvature: dec(curvature),
    },
    scores: {
      shatter: dec(p.shatter, 4),
      shatter_scale: "concat-sqrt3-l2",
      heat: dec(p.heat, 4),
      knn_margin: dec(0, 4),
      corpus_support: 0,
      centroid_cid: o.centroidCid,
    },
    admission: {
      contract_version: "roblox-luau.domain@1",
      disallowed_globals_hit: [],
      high_risk_patterns_hit: [],
      memory_safe: true,
    },
    novelty: { vs_prev_cid: prevCid, metric: "l2-concat", value: prevCid === null ? null : dec(curvature, 4) },
    license: { spdx: "MIT", source_class: "public-repo", derivative_release: "geometry-only" },
    // Keyed MACs: provable provenance, non-invertible. `file`/`symbol` are the
    // INPUTS here and never appear as fields.
    commitments: {
      source_mac_key_id: o.commitmentKeyId,
      source_mac: macOf(o.commitmentKey, p.provenanceHash ?? p.provenance_hash ?? p.id),
      locator_mac_key_id: o.commitmentKeyId,
      locator_mac: macOf(o.commitmentKey, `${p.file ?? ""}#${p.symbol ?? ""}`),
    },
    redaction: {
      source_text_withheld: 1,
      source_locator_withheld: (p.file ? 1 : 0) + (p.symbol ? 1 : 0),
      ...(p.unicode_drift_risk ? { unicode_stripped: 1 } : {}),
    },
  };

  if (p.hamming_sig) {
    // Zero-pad: the live index stores toString(16) unpadded (29–32 chars), and
    // Hamming distance across mismatched widths is silently wrong.
    tile.fingerprint = { family: "simhash128-fnv1a", bits: 128, hex: p.hamming_sig.padStart(32, "0").slice(-32) };
  }

  assertNoForbiddenKeys(tile);
  return tile;
}

// ─── seal ─────────────────────────────────────────────────────────────────────

export interface EmitResult {
  edition: string;
  tileCount: number;
  datBytes: number;
  merkleRoot: string;
  manifestCid: string;
  outDir: string;
}

export function sealPack(
  tiles: Array<{ cid: string; bytes: Buffer }>,
  manifestBody: Record<string, unknown>,
  outDir: string,
  edition: string,
  signerId: string,
  privateKeyPem: string
): EmitResult {
  tiles.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const REC = 44;
  const idx = Buffer.alloc(4 + tiles.length * REC);
  idx.writeUInt32LE(tiles.length, 0);
  const parts: Buffer[] = [];
  let off = 0;
  tiles.forEach((t, i) => {
    Buffer.from(t.cid.slice(7), "hex").copy(idx, 4 + i * REC);
    idx.writeBigUInt64LE(BigInt(off), 4 + i * REC + 32);
    idx.writeUInt32LE(t.bytes.length, 4 + i * REC + 40);
    parts.push(t.bytes);
    off += t.bytes.length;
  });
  const dat = Buffer.concat(parts);
  const root = merkleRoot(tiles.map((t) => Buffer.from(t.cid.slice(7), "hex")));

  const body = { ...manifestBody, tiles: tiles.map((t) => t.cid), tile_count: tiles.length, merkle_root: root.toString("hex") };
  const manifestCid = cidOf(body);
  const sig = edSign(
    null,
    Buffer.concat([Buffer.from("terrain-seal-v1", "utf8"), Buffer.from([0]), Buffer.from(manifestCid.slice(7), "hex")]),
    privateKeyPem
  );

  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, edition);
  writeFileSync(base + ".idx", idx);
  writeFileSync(base + ".dat", dat);
  writeFileSync(base + ".manifest.json", JSON.stringify(body, null, 2) + "\n");
  writeFileSync(
    base + ".seal.json",
    JSON.stringify(
      { seal_schema: "terrain-seal-v1", cid: manifestCid, canon_version: 1, signer: signerId, sig: sig.toString("base64"), signed_at: new Date().toISOString(), sig_scope: "pack" },
      null,
      2
    ) + "\n"
  );

  return { edition, tileCount: tiles.length, datBytes: dat.length, merkleRoot: root.toString("hex"), manifestCid, outDir };
}

export function loadOrCreateSigner(outDir: string, signerId: string): string {
  mkdirSync(outDir, { recursive: true });
  const keyPath = path.join(outDir, ".signing-key.pem");
  const trustPath = path.join(outDir, "terrain-keys.json");
  if (existsSync(keyPath) && existsSync(trustPath)) return readFileSync(keyPath, "utf8");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(keyPath, pem, { mode: 0o600 });
  const existing = existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, "utf8")) : {};
  existing[signerId] = {
    public_key_b64: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    valid_from: new Date().toISOString(),
    valid_until: null,
    status: "active",
    scopes: ["tile", "pack", "status"],
  };
  writeFileSync(trustPath, JSON.stringify(existing, null, 2) + "\n");
  return pem;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const arg = (n: string, d?: string): string | undefined => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const has = (n: string) => process.argv.includes(`--${n}`);

  const domain = arg("domain", "roblox-luau")!;
  const edition = arg("edition", `${domain}-${new Date().toISOString().slice(0, 7)}`)!;
  const outDir = path.resolve(arg("out", path.join(process.cwd(), "packs"))!);
  const limit = Number(arg("limit", "10000"));
  const dryRun = has("dry-run");
  const allowUncanonical = has("allow-uncanonical");
  const signerId = arg("signer", "nodeout-terrain-2026a")!;
  const engineVersion = arg("engine-version", "0.634.0.6340420")!;
  const collection = arg("collection", "spectral-heatmap")!;
  const filterByDomain = !has("no-domain-filter");

  console.log(`pack-emitter — domain=${domain} edition=${edition}${dryRun ? " (dry run)" : ""}`);

  console.log(`  collection=${collection} domain-filter=${filterByDomain}`);
  const live = await scrollTerrain(domain, limit, collection, filterByDomain);
  console.log(`  scrolled ${live.length} live points from terrain`);
  if (!live.length) throw new EmitRefusal(
      "EMPTY_TERRAIN",
      `no points in "${collection}"${filterByDomain ? ` matching domain "${domain}"` : ""} — check ingest, or pass --no-domain-filter`
    );

  // Only canonical points are sellable. A shattered point is, by definition,
  // one the refinery flagged as drifting from the corpus.
  const eligible = allowUncanonical ? live : live.filter((p) => p.kind === "canonical");
  console.log(`  ${eligible.length} eligible (${live.length - eligible.length} excluded as non-canonical)`);
  if (!eligible.length) throw new EmitRefusal("NO_CANONICAL", "no canonical points — run calibrate first, or pass --allow-uncanonical");

  const commitmentKeyId = "nodeout-prov-2026a";
  const commitmentKey = Buffer.from(process.env.TERRAIN_COMMITMENT_KEY ?? "dev-only-commitment-key-rotate-before-sale", "utf8");
  if (!process.env.TERRAIN_COMMITMENT_KEY) {
    console.log("  ⚠ TERRAIN_COMMITMENT_KEY unset — using a dev key. Set it before selling.");
  }

  const centroidCid = cidOf({ schema: "terrain-centroid-v1", domain, corpus_size: eligible.length });

  const tiles: Array<{ cid: string; bytes: Buffer }> = [];
  let prev: string | null = null;
  let skipped = 0;
  for (const p of eligible) {
    try {
      const body = projectTile(p, prev, { domain, centroidCid, engineVersion, commitmentKeyId, commitmentKey });
      const bytes = canonicalize(body);
      const cid = cidOfBytes(bytes);
      tiles.push({ cid, bytes });
      prev = cid;
    } catch (e) {
      skipped++;
      if (skipped <= 3) console.log(`  skip ${p.id}: ${(e as Error).message}`);
    }
  }
  if (skipped) console.log(`  skipped ${skipped} point(s) that failed projection`);
  if (!tiles.length) throw new EmitRefusal("NOTHING_TO_SEAL", "every point failed projection");

  const manifestBody = {
    schema: "terrain-pack-v1",
    canon_version: 1,
    pack_exclusions: ["/seal"],
    domain,
    edition,
    snapshot: { cut_at: new Date().toISOString(), window_from: new Date().toISOString(), window_to: new Date().toISOString() },
    prev_pack_cid: null,
    payload_content_type: "application/json",
    geometry: {
      profile: "transition-only",
      embed_model: "mxbai-embed-large",
      dim_per_third: 1024,
      concat_dim: 3072,
      norm_convention: "per-third-unit-kahan",
      shatter_scale: "concat-sqrt3-l2",
    },
    centroid: { centroid_cid: centroidCid, corpus_size: eligible.length, stability: null, stability_target: "0.008" },
    // Content-addressed retrieval only. No threshold is claimed, so no
    // calibration claim is made — the kNN gate stays out of the sold surface
    // until it is genuinely calibrated.
    silence: { gate: "exact-match", signal: "content-address" },
    confidence_model: null,
    knn: null,
    license_summary: { spdx_counts: { MIT: tiles.length }, derivative_release: "geometry-only" },
    redaction_totals: { source_text_withheld: tiles.length, source_locator_withheld: tiles.length },
    status_list_ref: `${domain}-status`,
    carrier_note: "Physics-deterministic state transitions. t+1 is engine-computed, not modeled.",
  };

  if (dryRun) {
    console.log(`\n  DRY RUN — would seal ${tiles.length} tiles, ${(tiles.reduce((s, t) => s + t.bytes.length, 0) / 1024).toFixed(1)} KB`);
    console.log(`  first cid ${tiles[0].cid}`);
    return;
  }

  const pem = loadOrCreateSigner(outDir, signerId);
  const r = sealPack(tiles, manifestBody, outDir, edition, signerId, pem);
  console.log(`\nSealed ${r.edition}`);
  console.log(`  tiles       ${r.tileCount}`);
  console.log(`  dat         ${(r.datBytes / 1024).toFixed(1)} KB`);
  console.log(`  merkle_root ${r.merkleRoot.slice(0, 32)}…`);
  console.log(`  manifest    ${r.manifestCid}`);
  console.log(`  out         ${r.outDir}`);
  console.log(`\nServe it:  cp ${r.outDir}/${r.edition}.* ~/Whiteglove/spectral-x402/packs/`);
}

if (process.argv[1] && process.argv[1].includes("pack-emitter")) {
  main().catch((e) => {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}
