# Use Case: Autonomous Blue Team / Self-Writing Defense Systems

**Date:** 2026-05-21
**Status:** Idea — not yet built
**Origin:** Recursive self-ingest of WhiteGlove source code into spectral terrain

---

## The Core Insight

Every existing blue team system is rules-based — signatures, regex, known-bad hashes, YARA rules.
One byte change = signature miss. Defense is always a list. Offense is always creative.

The terrain doesn't store rules. It stores **what stable looks like as geometry.**

The inversion: instead of "does this match a known bad pattern," you ask "does this belong to
the geometry of what we know is good." Unknown attacks still shatter. Zero-days still shatter.

---

## What It Unlocks

### 1. Signature-Free Anomaly Detection
Embed any incoming artifact — code, payload, log line, new file on disk.
Query the terrain. High shatter + no near canonical neighbor = geometric alarm.
No signature needed. No prior knowledge of the attack required.

### 2. Baseline Calibrated to YOUR Stack
Commercial EDRs are calibrated against generic enterprise populations.
This terrain is calibrated against your specific canonical code.
A file normal to Crowdstrike's dataset but foreign to your geometry still gets flagged.
A standard enterprise pattern that's never appeared in your stack registers as anomalous.

### 3. Agent Watches Its Own Execution Surface
Agent embeds its own runtime state before executing — tools being called, args, intended writes.
Checks against canonical geometry before acting.
Not a permission check. A topological sanity check.
"Does what I'm about to do look like what I've been trained to do, or has something pushed me off canonical path?"
Already partially wired: DriftGuard hammingRatio > 0.03 = re-anchor.

### 4. Reads Geometric Intent of a Threat
When a new threat appears: embed it, find nearest canonical file it resembles,
compute delta vector between threat and canonical anchor.
The delta describes structurally what the threat is trying to become.
From that delta the agent can write:
- A targeted monitor watching for that geometric trajectory
- A hardening patch for the canonical file being targeted
- A slop-canon entry so the pattern is permanently remembered

### 5. Defenses Written from Proven Geometry, Not Templates
Agent writes defenses anchored to its own canonical baseline.
Cannot hallucinate a defense that doesn't fit the stack — terrain won't allow geometric drift.
Structurally consistent with what's already been proven stable.

---

## Why Recursive Self-Ingest Is the Unlock

The WhiteGlove source code ingested into its own terrain means:

- Agent can pre-flight its own tools before calling them (shatter check before execute)
- Failure propagates structurally — bad patterns hit slop-canon before you see the problem
- Agent ranks its own files by geometric stability, picks most canonical implementation
- Self-modification is auditable — new code checked against terrain before commit
- Circadian loop closes — approved runs shift the centroid, agent recalibrates overnight

**You stop being the nervous system. The terrain carries it.**

---

## What This Is Not

- Not a SIEM replacement (no log aggregation, no alerting pipeline)
- Not a network monitor (no packet inspection)
- Not a pentest tool

It's a **geometric immune system** — knows self from non-self at the vector level.
Operates at the code and agent behavior layer, not the network layer.

---

## Architecture: How the System Is Actually Built

### Layer 0 — The Canonical Baseline (Already Exists)
The terrain already has this. Every canonical file in the husk has a heat score and a shatter
score relative to the Diamond-Stable centroid. This is the immune system's definition of "self."
Nothing gets built without this being solid first. Complete the source-audit calibration pass
after WhiteGlove + popsim ingests finish. That centroid IS the immune identity.

### Layer 1 — The Watchdog (New: `engine/watchdog.ts`)
A persistent process that runs alongside the agent. Three input channels:

**Channel A — Filesystem Watch**
Chokidar watches the entire allowlist (same boundary as Cartographer Option B).
On any file create/modify: embed the new content → shatter check against source-audit centroid.
If shatter > 0.15: geometric alarm. File did not come from canonical ground.
This catches: injected files, modified source, unexpected new scripts appearing in the stack.

**Channel B — Agent Execution Intercept**
Before every tool call the agent makes, the watchdog receives the intent payload:
`{ tool, args, file_target, code_to_write }`.
Embeds the intent. Queries terrain. If the intended action sits geometrically far from
canonical agent behavior patterns → HOLD. Agent re-anchors before proceeding.
This is DriftGuard extended from data-checking to behavior-checking.
Wire point: `AgentDirectives.DRIFT_BREACH` in `terrain.contract.ts` already defines the contract.

**Channel C — Slop-Canon Continuous Query**
Every embed that comes through the watchdog also gets checked against slop-canon (1024-D).
If cosine similarity to a known failure pattern > 0.85 → immediate HOLD + correction injection.
The agent doesn't repeat known mistakes because the geometry of the mistake is already stored.

---

### Layer 2 — The Threat Intake Pipeline (New: `engine/threat-intake.ts`)
Triggered when the watchdog raises a geometric alarm. Takes the anomalous artifact and runs
a structured 4-step analysis. This is where the system goes from detecting to understanding.

```
ARTIFACT IN
    │
    ▼
[EMBED] — sanitize + embed the artifact (1024-D via mxbai)
    │
    ▼
[SHATTER CHECK] — query spectral-heatmap, get nearest canonical neighbor + distance
    │
    ├── shatter < 0.05  → FALSE ALARM — log and release
    ├── shatter 0.05–0.15 → WATCH — flag for human review, continue monitoring
    └── shatter > 0.15  → THREAT — proceed to delta analysis
    │
    ▼
[DELTA COMPUTE] — vector arithmetic: delta = artifact_vec - nearest_canonical_vec
    │             This delta IS the geometric description of what the artifact
    │             is trying to become relative to your canonical code.
    │             It's not a diff. It's a direction in 1024-D space.
    │
    ▼
[DEFENSE WRITE] — agent receives: artifact, nearest_canonical_file, delta, shatter_score
                  Writes three outputs (see Layer 3)
```

The key insight in delta compute: the delta vector tells you which dimensions of the
canonical file are being targeted. High-magnitude delta dimensions correspond to the
semantic features of the canonical file being distorted. The agent can read that and
write a defense that's specifically hardened at those dimensions — not a generic patch.

---

### Layer 3 — Autonomous Defense Generation (New: `engine/defense-writer.ts`)
The agent receives the threat intake output and writes three artifacts into `defense/`:

**Artifact 1: Targeted Monitor** (`defense/monitors/[threat-id].monitor.ts`)
A chokidar watcher scoped specifically to the canonical file being targeted.
Embeds any change to that file on write. Triggers alarm if the new version's shatter
against the current canonical vector exceeds a tightened threshold (0.08 instead of 0.15).
The monitor is geometrically tuned — not watching for a specific string pattern,
watching for drift in the direction the threat was moving.

**Artifact 2: Hardening Patch** (`defense/patches/[canonical-file].hardened.ts`)
The agent reads the canonical file + the delta vector.
Adds runtime assertions at the entry points that correspond to high-magnitude delta dimensions.
Example: if the delta shows the threat was distorting the embedding sanitization layer,
the patch adds an invariant check at `sanitizeForEmbed()` that validates output shape
before it reaches Ollama. The assertion is derived from the geometry, not hand-written.

**Artifact 3: Slop-Canon Entry** (auto-written to Qdrant `slop-canon` collection)
The threat gets permanently encoded as a 1024-D failure memory entry with:
- `errorType`: geometric classification (shatter band + delta magnitude)
- `badPattern`: the raw artifact text
- `correction`: the hardening patch summary
- `embedding`: the threat vector itself
Future similar threats hit slop-canon query in Channel C before they even reach threat intake.
The immune system builds antibodies.

---

### Layer 4 — Circadian Hardening Loop (Extends existing `circadian/pulse.ts`)
Every night the pulse runs. Currently it recomputes weights. With this system added:

1. Pull all defense monitors written in the last 24h
2. Re-embed the canonical files they're watching (confirm they haven't drifted)
3. If any canonical file has drifted positively (legitimate update) → re-calibrate its
   monitor threshold to match the new canonical vector
4. Recompute source-audit centroid from all approved canonical points
5. Write updated centroid → all monitors, watchdog, and threat intake auto-reload it

The centroid shifts overnight to reflect approved changes. Defenses tighten around the
new canonical geometry automatically. No manual update required.

---

### Workflow: What Happens When a Threat Appears

```
1. New file appears in stack / agent writes anomalous code / known failure pattern detected
        │
2. Watchdog fires (< 50ms — chokidar + single embed call)
        │
3. Shatter check: > 0.15 → threat intake opens
        │
4. Delta computed — 1024-D direction vector describing the threat's geometric intent
        │
5. Defense writer spins up — agent receives full context:
   artifact + nearest canonical + delta + shatter score
        │
6. Three artifacts written to defense/ in < 2 minutes:
   targeted monitor + hardening patch + slop-canon entry
        │
7. Monitor activates immediately — watching the targeted canonical file
        │
8. Midnight: circadian pulse recomputes centroid, updates all monitor thresholds
        │
9. Next similar threat hits slop-canon query in Channel C before intake even opens
```

You are notified once — at step 6 — with a structured defense report.
Not asked to diagnose. Not asked to patch. Handed the output.

---

### What Gets Built and Where

```
engine/
  watchdog.ts          ← Layer 1 — persistent monitor, three input channels
  threat-intake.ts     ← Layer 2 — embed → shatter → delta → route to writer
  defense-writer.ts    ← Layer 3 — generates monitor + patch + slop entry

defense/
  monitors/            ← Auto-generated targeted file watchers
  patches/             ← Auto-generated hardening patches
  reports/             ← Structured threat reports (JSON + human-readable)

circadian/
  pulse.ts             ← Extended with Layer 4 centroid recompute + monitor recalibration
```

No new infrastructure. Qdrant already running. Ollama already running. Chokidar already
in the dependency tree (Cartographer uses it). The watchdog is a new process, everything
else is the terrain doing what it already does — just pointed at itself.

---

### The Key Architectural Constraint

**The defense writer must anchor every output to the terrain before writing.**

Before `defense-writer.ts` writes a monitor or patch, it embeds its own output and
runs a shatter check. If the generated defense itself is geometrically far from canonical
ground — the agent hallucinated something that doesn't fit the stack — it discards and
retries with a tighter prompt anchored to the nearest canonical file.

The terrain validates the defense before the defense activates.
This is the recursive loop that makes it self-correcting rather than self-sabotaging.

---

## Architecture Tightening (Before Implementation)

Four policy gaps to close before any layer goes to production:

### 1. Profile-Based Thresholds, Not Fixed Literals
The 0.05 / 0.15 / 0.85 constants baked into the watchdog and threat intake are not domain-portable.
`roblox-luau` code is geometrically noisier than `source-audit` code — the same delta magnitude means
different things across domains. Thresholds must come from a `DomainProfile` config (stored alongside
the centroid in `calibration/`) so each domain tunes deterministically against its own geometry.

```typescript
interface DomainProfile {
  watchThreshold:   number;  // shatter below = false alarm
  alarmThreshold:   number;  // shatter above = threat intake opens
  slopQueryCutoff:  number;  // cosine above = slop-canon hold
}
```

Load these from `calibration/{domain}-profile.json` at watchdog startup. Never hardcode in source.

### 2. Observer Mode / Enforce Mode Separation
The watchdog must boot in **observer mode** — it logs, scores, and records, but never holds or blocks.
Promote to **enforce mode** explicitly after a full circadian cycle confirms the centroid is stable.
Running enforce mode during initial calibration creates accidental workflow deadlocks where legitimate
changes trip the threshold before the centroid has converged. Mode is a runtime flag, not a config file.

```
watchdog --mode observe   ← calibrating, first deployment
watchdog --mode enforce   ← after centroid stability confirmed
```

### 3. Missing-Source as a First-Class State
The `[miss]` condition is not log noise — it's a signal that a terrain point references a file that
doesn't exist on disk. This has two distinct causes:
- **Synthetic/popsim**: generated content ingested with a path that was never on disk (now fixed via
  `source_resolvable` field + ingest gate)
- **Deleted canonical**: a file that existed at ingest time has been removed — this IS a security event

The watchdog should distinguish these. Maintain a `missing_source_queue` — any point where
`source_resolvable: true` but the file is now gone gets a DELETE alarm, not a silent miss.
Roblox synthetic paths (`source_resolvable: false`) are ignored entirely.

### 4. Pre-KNN Policy Gates in Query Path
Vector ranking must never be the first gate. Before any KNN query in the threat intake pipeline,
run hard policy checks:
- **Trust tier**: is the candidate domain in scope for this query?
- **Language**: does the artifact's detected language match the domain?
- **Size**: is the artifact within embed chunking bounds (avoids poisoned oversized inputs)?
- **Source resolvability**: does the candidate have a resolvable source? If not, skip entirely.

These gates are O(1) payload lookups — they cost nothing and prevent the vector ranking from
being manipulated by crafting inputs that happen to be geometrically close to canonical code.
Implement as `preKNNGate(artifact, candidatePoint): boolean` called before the Qdrant query.

---

## Build Path (When Ready)

1. Complete WhiteGlove + popsim ingest → calibrate source-audit centroid (prerequisite — in progress)
2. Define `DomainProfile` interface + write `calibration/{domain}-profile.json` for each domain
3. Build `engine/watchdog.ts` — observer mode first, three input channels, domain-profile thresholds
4. Build `engine/threat-intake.ts` — preKNNGate → embed → shatter → delta pipeline
5. Build `engine/defense-writer.ts` — monitor + patch + slop entry generation (shatter-check own output)
6. Extend `circadian/pulse.ts` — centroid recompute + monitor recalibration + missing-source queue
7. Wire agent execution intercept into agent loop (`agent/loop/agent-loop.ts`)
8. Promote watchdog to enforce mode after one full circadian cycle
9. First live test: inject a known-bad pattern, confirm slop-canon entry writes, monitor activates

---

## Related

- `contracts/terrain.contract.ts` — AgentDirectives.DRIFT_BREACH, AgentDirectives.SLOP_CHECK
- `engine/drift-sidecar.ts` — unicode drift magnitude (prototype of the watchdog pattern)
- `slop-canon/` — failure memory (the immune system's antibody store)
- `circadian/pulse.ts` — the loop that Layer 4 extends
- `agent/loop/agent-loop.ts` — wire point for execution intercept
- Cartographer MCP — `evaluate_redundancy` is the Cartographer-side version of threat intake
