/**
 * ROBLOX-LUAU DOMAIN CONTRACT
 *
 * v_t+1 method: PHYSICS-DETERMINISTIC
 * The Roblox engine IS the prediction function.
 * One physics tick forward = exact t+1. No ML required.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────
// ROBLOX GAME STATE (What gets embedded as v_t)
// ─────────────────────────────────────────────────────────────────

export const CFrameSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
});

export const GameStateSchema = z.object({
  tick:         z.number(),          // Roblox tick()
  scripts:      z.array(z.object({
    name:       z.string(),
    source:     z.string(),          // Luau source — what gets embedded
    cframe:     CFrameSchema.optional(),
    velocity:   z.tuple([z.number(), z.number(), z.number()]).optional(),
  })),
  constraints:  z.array(z.string()), // active WeldConstraints, etc.
  memoryUsage:  z.number(),          // KB
});

export type GameState = z.infer<typeof GameStateSchema>;

// ─────────────────────────────────────────────────────────────────
// PHYSICS-DETERMINISTIC t+1 PREDICTION
//
// For Luau/Roblox, v_t+1 is not learned — it is computed.
// Run one physics tick forward from current state.
// The engine guarantees the exact next state.
// ─────────────────────────────────────────────────────────────────

export const PhysicsPredictionSchema = z.object({
  t_state:      GameStateSchema,     // current state
  t_plus1:      GameStateSchema,     // one tick forward (engine-computed)
  deltaMs:      z.number(),          // tick duration in ms
  method:       z.literal("physics-deterministic"),
  engineVersion: z.string(),         // Roblox engine version
});

export type PhysicsPrediction = z.infer<typeof PhysicsPredictionSchema>;

// ─────────────────────────────────────────────────────────────────
// LUAU SAFETY RULES (from Eve_v2 admission contract)
// ─────────────────────────────────────────────────────────────────

export const LuauAdmissionContract = {
  disallowGlobals: ["require", "loadstring", "pcall", "xpcall"],
  enforceMemorySafety: true,
  maxCFrameIterations: 1000,
  spatialAnchors: ["Workspace", "ServerScriptService", "ReplicatedStorage"],

  // Shatter thresholds for Luau specifically
  shatterThresholds: {
    canonical:  0.03,  // tighter than general — game code must be precise
    review:     0.08,
    critical:   0.15,
  },

  // Known slop patterns in Roblox — always check slop-canon for these
  highRiskPatterns: [
    "WeldConstraint",
    "RunService.Heartbeat",
    "Instance.new",
    "workspace:FindPartOnRay",
  ],
} as const;

// ─────────────────────────────────────────────────────────────────
// DOMAIN CENTROID REFERENCE
// ─────────────────────────────────────────────────────────────────

export const RobloxCentroidMeta = {
  label: "Diamond-Stable-roblox-luau",
  path: "../calibration/roblox-luau-centroid.json",
  minCorpusSize: 20,   // minimum canonical scripts to compute stable centroid
  stabilityTarget: 0.008, // centroid drift threshold between calibration runs
} as const;
