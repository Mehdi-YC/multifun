/**
 * Fixed-timestep math. All integrators use explicit operation ordering so two
 * runs of the same sim evaluate bit-identical expressions in the same order.
 */

/** Wall-clock source in milliseconds. Injected everywhere for testability. */
export type NowFn = () => number;

function defaultNow(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

let nowSource: NowFn = defaultNow;

/** Current time in milliseconds (respects `setNowSource`). */
export function nowMs(): number {
	return nowSource();
}

/** Override the clock (tests). Pass `null` to restore the default clock. */
export function setNowSource(fn: NowFn | null): void {
	nowSource = fn ?? defaultNow;
}

/** Duration of one simulation tick in milliseconds. */
export function TICK_MS(tickRate: number): number {
	return 1000 / tickRate;
}

/** Linear interpolation. `t` outside [0, 1] extrapolates. */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Clamp `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/** Move `current` toward `target` by at most `maxDelta` (never overshoots). */
export function approach(current: number, target: number, maxDelta: number): number {
	if (current < target) return Math.min(current + maxDelta, target);
	return Math.max(current - maxDelta, target);
}

/**
 * Deterministic float-safe velocity integrator: one position step with an
 * explicit `vel * dt` product first, then the add. `integrate(0, v, dt)`
 * returns exactly the step delta.
 */
export function integrate(pos: number, vel: number, dt: number): number {
	const delta = vel * dt;
	return pos + delta;
}

/** Same explicit ordering for velocity updates: `vel + accel * dt`. */
export function stepVelocity(vel: number, accel: number, dt: number): number {
	const delta = accel * dt;
	return vel + delta;
}
