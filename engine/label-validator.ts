/**
 * LABEL VALIDATOR — Shadow Vocabulary Audit Layer
 *
 * Analyzes Roblox Luau source files for naming violations:
 *   - API collisions (module/folder named same as Roblox service or member)
 *   - Casing violations (lowercase service aliases)
 *   - Dot-access unsafe labels (spaces/hyphens in instance names)
 *   - Suffix class detection (Manager, Controller, Service, etc.)
 *
 * Attaches results as `label_meta` on TerrainPoint before Qdrant upsert.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import type { LabelMeta, SuffixClass, LabelRiskClass } from "../contracts/terrain.contract.js";
import { basename, extname } from "path";

// ─────────────────────────────────────────────────────────────────
// ROBLOX API COLLISION TERMS
// Layer 0: Luau globals
// Layer 1: Engine services (game:GetService)
// Layer 2: Common API members every Instance has
// ─────────────────────────────────────────────────────────────────

const LUAU_GLOBALS = new Set([
  "game", "workspace", "script", "plugin", "Enum",
  "math", "table", "string", "os", "task", "coroutine", "bit32", "utf8", "buffer",
  "print", "warn", "error", "assert", "pcall", "xpcall", "rawget", "rawset", "rawequal", "rawlen",
  "pairs", "ipairs", "next", "select", "unpack", "pack",
  "type", "typeof", "tostring", "tonumber", "setmetatable", "getmetatable",
  "require", "loadstring", "newproxy",
]);

const ROBLOX_SERVICES = new Set([
  "Players", "Workspace", "Lighting", "ReplicatedStorage", "ReplicatedFirst",
  "ServerStorage", "ServerScriptService", "StarterGui", "StarterPack",
  "StarterPlayer", "StarterCharacterScripts", "StarterPlayerScripts",
  "SoundService", "RunService", "TweenService", "CollectionService",
  "DataStoreService", "UserInputService", "ContextActionService",
  "PhysicsService", "MarketplaceService", "BadgeService", "GroupService",
  "TextService", "HttpService", "InsertService", "AssetService",
  "PathfindingService", "MaterialService", "LocalizationService",
  "AnalyticsService", "VoiceChatService", "AvatarEditorService",
  "CoreGui", "CorePackages",
]);

const ROBLOX_INSTANCE_MEMBERS = new Set([
  "Parent", "Name", "ClassName", "Children",
  "Destroy", "Clone", "Remove",
  "FindFirstChild", "FindFirstChildOfClass", "FindFirstChildWhichIsA", "FindFirstAncestor",
  "FindFirstAncestorOfClass", "FindFirstAncestorWhichIsA", "FindFirstDescendant",
  "WaitForChild", "GetChildren", "GetDescendants", "GetAncestors",
  "IsA", "IsDescendantOf", "IsAncestorOf",
  "GetPropertyChangedSignal", "GetAttribute", "SetAttribute", "GetAttributes",
  "GetTags", "HasTag", "AddTag", "RemoveTag",
  "Connect", "Once", "Wait", "Disconnect",
  "Instance", "Model", "Part", "BasePart", "Script", "LocalScript", "ModuleScript",
  "Humanoid", "Player", "Character", "Tool", "Folder", "Configuration",
  "RemoteEvent", "RemoteFunction", "BindableEvent", "BindableFunction",
  "Frame", "ScreenGui", "BillboardGui", "SurfaceGui",
  "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton",
]);

const ROBLOX_COMMON_TYPES = new Set([
  "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2", "Rect",
  "Ray", "RaycastParams", "RaycastResult", "TweenInfo", "NumberSequence",
  "ColorSequence", "NumberRange", "Region3", "Axes", "BrickColor",
  "PhysicalProperties", "Random", "DateTime",
]);

const ALL_API_TERMS = new Set([
  ...LUAU_GLOBALS, ...ROBLOX_SERVICES, ...ROBLOX_INSTANCE_MEMBERS, ...ROBLOX_COMMON_TYPES,
]);

// ─────────────────────────────────────────────────────────────────
// SUFFIX DETECTION
// ─────────────────────────────────────────────────────────────────

const SUFFIXES: SuffixClass[] = [
  "Manager", "Controller", "Service", "Handler", "System",
  "Bridge", "Generator", "Interface", "Core", "Library",
  "Client", "Server", "Module",
];

function detectSuffix(name: string): SuffixClass {
  for (const s of SUFFIXES) {
    if (name.endsWith(s)) return s;
  }
  return "none";
}

// ─────────────────────────────────────────────────────────────────
// REGEX PATTERNS
// ─────────────────────────────────────────────────────────────────

const WAITFORCHILD_RE  = /:(?:WaitForChild|FindFirstChild|FindFirstChildOfClass)\s*\(\s*["']([^"']+)["']/g;
const GETSERVICE_ALIAS_RE = /local\s+([a-z][A-Za-z0-9_]*)\s*=\s*game:GetService\s*\(\s*["'][^"']+["']\s*\)/g;
const PASCAL_RE        = /^[A-Z][a-zA-Z0-9]*$/;

// ─────────────────────────────────────────────────────────────────
// MAIN VALIDATOR
// ─────────────────────────────────────────────────────────────────

export function validateLabel(filePath: string, source: string): LabelMeta {
  // Strip all .lua/.luau extensions (handles .lua.lua double-extension artefacts)
  const raw = basename(filePath).replace(/(\.(lua|luau))+$/i, "");
  // Strip run-id prefix if present (e.g. "2eddd744-AtmosphereManager" → "AtmosphereManager")
  const moduleName = /^[0-9a-f]{8}-/.test(raw) ? raw.slice(9) : raw;

  const suffixClass      = detectSuffix(moduleName);
  const casingValid      = PASCAL_RE.test(moduleName);
  const moduleApiCollision = ALL_API_TERMS.has(moduleName);

  // Shadow terms: WaitForChild/FindFirstChild args that hit the API list
  const shadowTerms: string[] = [];
  let m: RegExpExecArray | null;

  WAITFORCHILD_RE.lastIndex = 0;
  while ((m = WAITFORCHILD_RE.exec(source)) !== null) {
    if (ALL_API_TERMS.has(m[1])) shadowTerms.push(m[1]);
  }

  // Casing violations: lowercase service aliases (local players = game:GetService...)
  const casingViolations: string[] = [];
  GETSERVICE_ALIAS_RE.lastIndex = 0;
  while ((m = GETSERVICE_ALIAS_RE.exec(source)) !== null) {
    casingViolations.push(m[1]);
  }

  // Dot-access safety: WaitForChild arg with space or hyphen
  let dotAccessSafe = true;
  WAITFORCHILD_RE.lastIndex = 0;
  while ((m = WAITFORCHILD_RE.exec(source)) !== null) {
    if (/[\s-]/.test(m[1])) { dotAccessSafe = false; break; }
  }

  // Worst risk class (precedence: invalid > dot_unsafe > api_collision > convention > clean)
  let riskClass: LabelRiskClass = "clean";
  if (/[\s-]/.test(moduleName) && !PASCAL_RE.test(moduleName)) {
    riskClass = "invalid_identifier";
  } else if (!dotAccessSafe) {
    riskClass = "dot_access_unsafe";
  } else if (moduleApiCollision) {
    riskClass = "api_collision";
  } else if (
    /^(thing|stuff|test|script\d*|module\d*|new|old|final|temp|tmp|misc|util\d*|helper\d*|manager\d+|handler\d+)/i.test(moduleName)
  ) {
    riskClass = "team_convention_reject";
  }

  return {
    module_name:        moduleName,
    suffix_class:       suffixClass,
    risk_class:         riskClass,
    api_collision:      moduleApiCollision,
    casing_valid:       casingValid,
    dot_access_safe:    dotAccessSafe,
    shadow_terms:       [...new Set(shadowTerms)],
    casing_violations:  casingViolations,
  };
}

// ─────────────────────────────────────────────────────────────────
// SUMMARY PRINTER (used by ingest.ts at end of run)
// ─────────────────────────────────────────────────────────────────

export function printLabelAuditSummary(results: Array<{ file: string; meta: LabelMeta }>) {
  const collisions  = results.filter(r => r.meta.api_collision);
  const casingViols = results.filter(r => r.meta.casing_violations.length > 0);
  const dotUnsafe   = results.filter(r => !r.meta.dot_access_safe);
  const shadowHits  = results.filter(r => r.meta.shadow_terms.length > 0);

  const suffixMap: Record<string, number> = {};
  for (const r of results) {
    suffixMap[r.meta.suffix_class] = (suffixMap[r.meta.suffix_class] ?? 0) + 1;
  }

  console.log("\n📋 LABEL AUDIT SUMMARY");
  console.log(`   Total files:                  ${results.length}`);
  console.log(`   API collisions (module name): ${collisions.length}${collisions.length ? " — " + collisions.map(r => r.meta.module_name).join(", ") : ""}`);
  console.log(`   Shadow terms in source:       ${shadowHits.length} files`);
  console.log(`   Casing violations:            ${casingViols.length} files`);
  console.log(`   Dot-access unsafe:            ${dotUnsafe.length} files`);
  console.log(`\n   Suffix distribution:`);
  for (const [s, count] of Object.entries(suffixMap).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${s.padEnd(14)} ${count}`);
  }
}
