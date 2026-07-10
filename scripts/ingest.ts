/**
 * SPECTRAL TERRAIN — Source Ingest Entry Point
 *
 * Thin CLI wrapper around engine/ingest.ts for Hermes / operator use.
 * Defaults to source-audit domain over the local Hermes agent codebase.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts
 *   npx tsx scripts/ingest.ts --path /path/to/repo --domain source-audit
 *   npx tsx scripts/ingest.ts --path /Users/joewales/.hermes/hermes-agent --domain source-audit --canonical
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { ingestRepo, type Domain } from "../engine/ingest.js";

const args = process.argv.slice(2);

function arg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const DEFAULT_PATH = "/Users/joewales/.hermes/hermes-agent";
const DEFAULT_DOMAIN = "source-audit";

const pathArg = arg("--path", DEFAULT_PATH);
const domainArg = arg("--domain", DEFAULT_DOMAIN) as Domain;
const canonical = args.includes("--canonical");

console.log(`🛰  Spectral Terrain ingest starting...`);
console.log(`   path:   ${pathArg}`);
console.log(`   domain: ${domainArg}`);
console.log(`   canonical: ${canonical}\n`);

ingestRepo(pathArg, domainArg, canonical).catch((err) => {
  console.error("❌ Ingest failed:", err);
  process.exit(1);
});
