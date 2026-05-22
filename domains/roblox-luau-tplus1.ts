/**
 * ROBLOX-LUAU — Physics-Deterministic t+1 Predictor
 *
 * The Roblox engine runs at 60 Hz. One physics tick = 1/60 s.
 * t+1 is not predicted — it is computed. The engine IS the function.
 *
 * Method: Symplectic Euler integration on position + velocity.
 * Gravity: Roblox default = -196.2 studs/s² (196.2 = 9.81 × 20, Roblox stud scale).
 *
 * Called by buildTemporalVector() before embedding — produces the v_t+1 text
 * that gets embedded as the third 1024-D slot.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import type { GameState } from "../contracts/roblox-luau.domain.js";

// ─────────────────────────────────────────────────────────────────
// ROBLOX PHYSICS CONSTANTS
// ─────────────────────────────────────────────────────────────────

/** Roblox physics tick rate — fixed at 60 Hz */
const ROBLOX_TICK_HZ = 60;

/** deltaT for one engine tick in seconds */
const DELTA_T = 1 / ROBLOX_TICK_HZ;  // 0.01666...s

/**
 * Roblox gravity in studs/s².
 * 1 stud ≈ 0.28m, Roblox gravity = 196.2 studs/s² ≈ 9.81 m/s² × 20.
 * Applied only to the Y axis, downward.
 */
const GRAVITY_Y = -196.2;

// ─────────────────────────────────────────────────────────────────
// CORE PREDICTOR
// ─────────────────────────────────────────────────────────────────

/**
 * Advance a Roblox GameState by exactly one physics tick.
 *
 * For each script that has both a CFrame position and a velocity:
 *   vel_t+1  = vel_t + [0, GRAVITY_Y, 0] × deltaT    (gravity applied)
 *   pos_t+1  = pos_t + vel_t+1 × deltaT               (symplectic Euler)
 *
 * Scripts without velocity are treated as anchored (BasePart.Anchored = true)
 * and their position is carried forward unchanged.
 *
 * Rotation is carried forward unchanged — Roblox rotation from torque/angular
 * velocity would require angular momentum state we don't track.
 *
 * @param state  Current game state (v_t)
 * @returns      Predicted game state one tick forward (v_t+1)
 */
export function predictNextTick(state: GameState): GameState {
  const scripts = state.scripts.map(script => {
    // No velocity → anchored, position unchanged
    if (!script.velocity || !script.cframe) {
      return { ...script };
    }

    const [vx, vy, vz] = script.velocity;
    const [px, py, pz] = script.cframe.position;

    // Gravity integration (Y axis only, symplectic Euler)
    const vy1 = vy + GRAVITY_Y * DELTA_T;

    // Position advance using updated velocity (symplectic — more stable than explicit Euler)
    const px1 = px + vx  * DELTA_T;
    const py1 = py + vy1 * DELTA_T;
    const pz1 = pz + vz  * DELTA_T;

    return {
      ...script,
      velocity: [vx, vy1, vz] as [number, number, number],
      cframe: {
        // Rotation carries forward — no angular state tracked
        rotation: script.cframe.rotation,
        position: [px1, py1, pz1] as [number, number, number],
      },
    };
  });

  return {
    tick:        state.tick + 1,
    scripts,
    constraints: state.constraints,
    memoryUsage: state.memoryUsage,
  };
}

// ─────────────────────────────────────────────────────────────────
// TEXT SERIALIZER
// ─────────────────────────────────────────────────────────────────

/**
 * Serialize a GameState to the text that gets embedded as a 1024-D vector.
 *
 * Format is terse and deterministic — the same state always produces the
 * same string, so the same embedding, so the same terrain point.
 *
 * Called by the ingest pipeline to produce the tPlus1 string for
 * buildTemporalVector(tMinus1Text, tNowText, serializeState(predictNextTick(state))).
 */
export function serializeState(state: GameState): string {
  const parts: string[] = [`tick=${state.tick} mem=${state.memoryUsage}kb`];

  for (const script of state.scripts) {
    const pos = script.cframe
      ? `pos=[${script.cframe.position.map(v => v.toFixed(3)).join(",")}]`
      : "pos=anchored";
    const vel = script.velocity
      ? `vel=[${script.velocity.map(v => v.toFixed(3)).join(",")}]`
      : "vel=static";
    parts.push(`${script.name}: ${pos} ${vel}`);
  }

  if (state.constraints.length > 0) {
    parts.push(`constraints=[${state.constraints.join(",")}]`);
  }

  return parts.join(" | ");
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE ENTRY POINT
// ─────────────────────────────────────────────────────────────────

/**
 * Produce the t+1 text string ready to embed as the v_t+1 slot.
 *
 * Usage in ingest pipeline:
 *
 *   const tPlus1Text = tplus1FromState(currentState);
 *   const vec = await buildTemporalVector(prevSourceText, nowSourceText, tPlus1Text);
 *
 * @param currentState  The v_t game state read from Roblox
 * @returns             Serialized v_t+1 state string for embedding
 */
export function tplus1FromState(currentState: GameState): string {
  return serializeState(predictNextTick(currentState));
}
