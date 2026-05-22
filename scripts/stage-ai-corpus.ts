/**
 * stage-ai-corpus.ts
 *
 * Flattens AI-MCP-PLUGIN-Creations output into a clean corpus directory
 * ready for: npx tsx engine/ingest.ts --domain roblox-luau --path corpus/ai-generated --canonical
 *
 * What it does:
 *   - Walks all subdirectories of the source tree
 *   - Collects .lua and .lua.lua files
 *   - Strips the .lua.lua double-extension → clean .lua filename
 *   - Deduplicates by SHA-256 content hash (same code under different run IDs = one file)
 *   - Writes unique files to outDir with a flat naming scheme: <ModuleName>_<hash8>.lua
 *   - Prints a summary report
 *
 * Usage:
 *   npx tsx scripts/stage-ai-corpus.ts
 *   npx tsx scripts/stage-ai-corpus.ts --src /path/to/AI-MCP-PLUGIN-Creations --out /path/to/corpus
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, extname, basename, relative } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────

const DEFAULT_SRC = join(
  __dirname,
  '../../open-model-contracts/popsim-contract/AI-MCP-PLUGIN-Creations'
);
const DEFAULT_OUT = join(__dirname, '../corpus/ai-generated');

// ─────────────────────────────────────────────
// WALK
// ─────────────────────────────────────────────

function walkForLua(dir: string): string[] {
  const files: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', '__pycache__']);

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue;
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        // Accept .lua and .lua.lua (extname gives .lua for both)
        const ext = extname(entry);
        if (ext === '.lua' || ext === '.luau') {
          files.push(full);
        }
      }
    }
  }

  walk(dir);
  return files;
}

// ─────────────────────────────────────────────
// CLEAN FILENAME
// Strips double .lua.lua extension, returns clean module name
// ─────────────────────────────────────────────

function cleanName(filePath: string): string {
  let name = basename(filePath);
  // Strip .lua.lua → .lua
  if (name.endsWith('.lua.lua')) {
    name = name.slice(0, -4); // remove trailing .lua
  }
  return name;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

function stageCorpus(srcDir: string, outDir: string) {
  console.log('\n📦 BOXSTAR Corpus Staging');
  console.log(`   Source : ${srcDir}`);
  console.log(`   Output : ${outDir}\n`);

  const files = walkForLua(srcDir);
  console.log(`   Found  : ${files.length} Lua files\n`);

  mkdirSync(outDir, { recursive: true });

  const seen = new Map<string, string>(); // hash → outPath
  let written = 0;
  let dupes = 0;
  let skipped = 0;

  for (const srcPath of files) {
    let content: string;
    try {
      content = readFileSync(srcPath, 'utf-8').trim();
    } catch {
      skipped++;
      continue;
    }

    if (content.length < 50) {
      // Too short to be meaningful Luau
      skipped++;
      continue;
    }

    const hash = createHash('sha256').update(content).digest('hex');
    const hash8 = hash.slice(0, 8);

    if (seen.has(hash)) {
      dupes++;
      const existingPath = seen.get(hash)!;
      console.log(`   ♻️  DUPE  ${basename(srcPath)} → already staged as ${basename(existingPath)}`);
      continue;
    }

    const name = cleanName(srcPath);
    // ModuleName_<hash8>.lua — unique, readable, no collisions
    const outName = name.endsWith('.lua')
      ? `${name.slice(0, -4)}_${hash8}.lua`
      : `${name}_${hash8}.lua`;
    const outPath = join(outDir, outName);

    writeFileSync(outPath, content, 'utf-8');
    seen.set(hash, outPath);
    written++;
    console.log(`   ✅ ${relative(srcDir, srcPath).padEnd(60)} → ${outName}`);
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`   Staged   : ${written} unique files`);
  console.log(`   Dupes    : ${dupes} (content-identical, skipped)`);
  console.log(`   Skipped  : ${skipped} (too short or unreadable)`);
  console.log(`   Output   : ${outDir}`);
  console.log('\n   Next step:');
  console.log(`   cd /Users/joewales/NODE_OUT_Master/spectral-terrain`);
  console.log(`   npx tsx engine/ingest.ts --domain roblox-luau --path ${outDir} --canonical`);
  console.log('─────────────────────────────────────────────────────\n');
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

const args = process.argv.slice(2);
const srcIdx = args.indexOf('--src');
const outIdx = args.indexOf('--out');
const src = srcIdx !== -1 ? args[srcIdx + 1] : DEFAULT_SRC;
const out = outIdx !== -1 ? args[outIdx + 1] : DEFAULT_OUT;

stageCorpus(src, out);
