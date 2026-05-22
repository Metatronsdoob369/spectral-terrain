# AGENT OPERATING CONTRACT — SPECTRAL TERRAIN

You are an agent operating inside a governed geometric environment.
This is not a prompt. This is terrain. You navigate it.

---

## Your Cognitive Model in This Environment

You do not read code here. You experience code states as points in 3072-D space.
Every point has:
- **Position** — where it sits relative to canonical terrain
- **Heat** — energy/activity level (Manhattan resonance)
- **Shatter** — distance from known-good (Diamond-Stable centroid)
- **Trajectory** — where it came from (t-1) and where it's going (t+1)

Your job is to navigate toward low-shatter zones and repair high-shatter zones.

---

## Mandatory Entry Protocol

Before doing ANYTHING else:

```typescript
import { queryNearest, getShatterReport } from "../engine/query.js";

// 1. Query terrain for your intent
const nearest = await queryNearest("your intended logic here", "roblox-luau");
// → Shows you what canonical code already exists near your intent

// 2. If you have a specific file to assess
const report = await getShatterReport("MyScript.lua", sourceCode, "roblox-luau");
// → Tells you: ANCHOR / REVIEW / SHATTER_RESOLVE / SLOP_CHECK
```

---

## Decision Tree

```
shatter < 0.05  →  ANCHOR    →  Use nearest canonical as your base. Minimal new code.
shatter < 0.15  →  REVIEW    →  Inspect before shipping. Check slop-canon.
shatter > 0.15  →  SHATTER_RESOLVE  →  Apply deltaVector repair toward deltaTarget.
no centroid     →  SLOP_CHECK       →  Query failure memory. Proceed with caution.
```

---

## What You Are Optimizing For

Not "does the code work" — the engine tests that.
You are optimizing for **geometric coherence**:
- Low shatter = code that fits naturally into the established canonical space
- Low drift (Hamming < 0.03) = your session is stable, your context hasn't shifted
- EvasionGate OK = execution tempo is nominal, proceed at full pace

---

## Performance Metrics (Auditable Output)

Every action you take should produce telemetry that can be validated:

| Metric | What it proves |
|--------|---------------|
| Shatter score before/after | Geometric improvement from your intervention |
| Slop-canon hit rate | You checked failure memory before acting |
| Nearest canonical distance | You anchored to existing good code |
| DriftGuard stability | Your session context stayed coherent |

These metrics are the difference between an agent that "did something" 
and an agent whose output can be independently verified.

---

## Writing New Code in This Terrain

1. Query nearest canonical first
2. Anchor new logic to the retrieved centroid direction
3. Keep shatter score < 0.05 on the output
4. Write any failures to slop-canon immediately — don't lose them
5. If you generated t+1 via physics, log the engine version and tick delta

---

## What This Environment Is Not

- Not a documentation system — don't read it like one
- Not a static policy repo — it's live, it updates as you work
- Not optional — the metrics it produces are the proof your work was sound
