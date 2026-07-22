// File: js/physics.js
'use strict';
// Single source of truth for ball physics.
//
// ARCHITECTURE: stepBallState() advances ONE ball-like state by ONE fixed
// step. It is the only place ball movement/collision rules exist:
//   - The live simulation calls it via update() on real Ball objects.
//   - The prediction path calls it via simulateTrajectory() on a throwaway
//     copy of the launch state.
// Prediction therefore matches reality BY CONSTRUCTION - the two can no
// longer drift apart, because there is nothing to keep in sync.
//
// ENERGY MODEL (all losses explicit and named in CONFIG.PHYSICS):
//   - Walls: velocity.x scaled by -WALL_RESTITUTION on contact.
//   - Pegs:  immovable (infinite mass); normal component of velocity
//            reflected and scaled by PEG_RESTITUTION.
//   - Floor: no bounce - crossing it ends the shot (state transition for the
//            real ball, path termination for the prediction).
// Previously peg damping happened implicitly through a mass-5 elastic
// collision formula; PEG_RESTITUTION = 0.667 reproduces that exact factor.

function PhysicsEngine(game) {
    this.game = game; // Store reference to the game instance
    dbg("PhysicsEngine created.");
}

/**
 * Advances all dynamic balls by one fixed simulation step and applies
 * game-level consequences (floor crossing ends the shot).
 * Called once per fixed step from Game.stepSimulation().
 * @param {number} deltaSteps - Steps to advance (always 1; kept for future use).
 * @param {Array<Ball>} dynamicObjects - Balls subject to physics.
 */
PhysicsEngine.prototype.update = function(deltaSteps, dynamicObjects) {
    dynamicObjects.forEach(ball => {
        if (ball.isStatic) return;

        // Ball objects conform to the state shape stepBallState expects
        // ({pixelX, pixelY, velocity, radius}), so we step them directly.
        const result = this.stepBallState(ball);

        // Route impact DATA to the game for feedback (haptics now; sound and
        // visual effects will hook the same seam). Live simulation only -
        // simulateTrajectory never reaches this code.
        if (result.wallImpact > 0 || result.pegImpact > 0) {
            this.game.onBallImpact(result);
        }

        // Game-level consequence of floor contact: the shot is over.
        // The ball is deliberately NOT stopped or clamped - it continues
        // falling out of the world during RESETTING (intentional aesthetic).
        if (result.hitFloor && this.game.currentState === GameStates.SHOT_TAKEN) {
            dbg('PhysicsEngine: Ball crossed floor during SHOT_TAKEN, transitioning to RESETTING.');
            this.game.transitionTo(GameStates.RESETTING);
        }
    });
};

/**
 * THE core physics routine: advances a single ball-like state by exactly one
 * fixed step. Pure with respect to the game - reads board geometry and nodes,
 * mutates only the passed state.
 *
 * Step order (load-bearing - changing it changes trajectories):
 *   gravity -> move -> walls -> floor check -> peg collisions (skipped once
 *   at/below floor; nothing to hit down there).
 *
 * @param {{pixelX:number, pixelY:number, velocity:{x:number,y:number}, radius:number}} state
 * @returns {{hitFloor: boolean, wallImpact: number, pegImpact: number}}
 *          Pure event DATA (impact values are contact speeds in px/step,
 *          0 = no contact). stepBallState itself never triggers feedback -
 *          the live simulation routes these to the Game, while
 *          simulateTrajectory ignores them (predictions must never buzz,
 *          flash, or sound).
 */
PhysicsEngine.prototype.stepBallState = function(state) {
    const game = this.game;
    const r = state.radius || 0;
    let wallImpact = 0; // Contact speed against a wall this step (px/step)
    let pegImpact = 0;  // Strongest peg contact speed this step (px/step)

    // --- Gravity, then move ---
    state.velocity.y += game.gravity;
    state.pixelX += state.velocity.x;
    state.pixelY += state.velocity.y;

    // --- Wall bounces (explicit restitution) ---
    const rightWall = game.COLUMNS * game.cellRes;
    const wallE = CONFIG.PHYSICS.WALL_RESTITUTION;
    if (state.pixelX + r > rightWall) {
        state.pixelX = rightWall - r;
        wallImpact = Math.abs(state.velocity.x); // Speed INTO the wall
        state.velocity.x = -state.velocity.x * wallE;
    } else if (state.pixelX - r < 0) {
        state.pixelX = r;
        wallImpact = Math.abs(state.velocity.x); // Speed INTO the wall
        state.velocity.x = -state.velocity.x * wallE;
    }

    // --- Floor detection (no response here - callers decide) ---
    const floorY = game.ROWS * game.cellRes;
    const hitFloor = state.pixelY + r >= floorY;

    // --- Peg collisions: immovable pegs, explicit restitution ---
    if (!hitFloor) {
        const pegE = CONFIG.PHYSICS.PEG_RESTITUTION;
        const nodes = game.nodes;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const dist = distance(state.pixelX, state.pixelY, node.pixelX, node.pixelY);
            const totalRadius = r + node.radius;

            if (dist < totalRadius && dist > 0) {
                // Unit normal from peg centre to ball centre.
                const nx = (state.pixelX - node.pixelX) / dist;
                const ny = (state.pixelY - node.pixelY) / dist;

                // Reflect the normal velocity component only if approaching
                // (vDotN < 0). Tangential component is untouched.
                const vDotN = state.velocity.x * nx + state.velocity.y * ny;
                if (vDotN < 0) {
                    pegImpact = Math.max(pegImpact, -vDotN); // Approach speed
                    state.velocity.x -= (1 + pegE) * vDotN * nx;
                    state.velocity.y -= (1 + pegE) * vDotN * ny;
                }

                // Positional correction: push the ball out along the normal
                // so it never renders overlapping (or tunnels on re-check).
                const overlap = totalRadius - dist;
                state.pixelX += nx * (overlap + 0.1);
                state.pixelY += ny * (overlap + 0.1);
            }
        }
    }

    return { hitFloor: hitFloor, wallImpact: wallImpact, pegImpact: pegImpact };
};

/**
 * Simulates a full trajectory from a launch state WITHOUT touching the live
 * game. Used by the renderer for the aiming prediction path and the
 * persisted after-shot path. Because each step is stepBallState(), the
 * returned points are exactly where the real ball will be, step for step.
 *
 * @param {{pixelX:number, pixelY:number, velocity:{x:number,y:number}, radius:number}} start
 *        Launch state (copied - the original is not mutated).
 * @param {number} maxSteps - Maximum steps to simulate.
 * @returns {Array<{x:number, y:number}>} One point per simulated step; the
 *          final point rests on the floor if the floor was reached.
 */
PhysicsEngine.prototype.simulateTrajectory = function(start, maxSteps) {
    // Private working copy - never mutate the caller's state.
    const state = {
        pixelX: start.pixelX,
        pixelY: start.pixelY,
        velocity: { x: start.velocity.x, y: start.velocity.y },
        radius: start.radius
    };

    const points = [];
    const floorY = this.game.ROWS * this.game.cellRes;

    for (let i = 0; i < maxSteps; i++) {
        const result = this.stepBallState(state);
        if (result.hitFloor) {
            // Rest the final drawn point on the floor - the prediction shows
            // where the shot ENDS, not the ball's decorative exit afterwards.
            points.push({ x: state.pixelX, y: floorY - state.radius });
            break;
        }
        points.push({ x: state.pixelX, y: state.pixelY });
    }
    return points;
};