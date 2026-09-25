/**
 * Snapshot interpolation for Pixel Tanks remote entities.
 *
 * Two desync sources live here and are fixed structurally:
 *
 * 1. Angles are circular. Lerping `179deg -> -179deg` naively spins the long
 *    way (through 0) for half a second. All angle blending goes through
 *    `lerpAngle`, which wraps the delta to (-pi, pi] first (shortest path).
 *
 * 2. Discontinuities must snap, never slide. A respawn teleports a tank from
 *    its death spot to a spawn point; interpolating the pair slides the tank
 *    across the map (~100ms) which reads as "the respawn never happened".
 *    `RemoteBuffer.push` marks every sample that does NOT continue smoothly
 *    from the previous one (teleport distance, alive/lives transitions, or a
 *    snapshot gap), and interpolation across a discontinuity snaps to the
 *    nearest sample instead of blending.
 *
 * The buffer is the client's remote-entity clock as well: `renderTick` is
 * derived from the snapshot stream's own ticks (`render.ts`), so two browsers
 * with different frame rates, window sizes or dropped ticks render the same
 * world position for the same snapshot stream.
 */
import type { BulletState, PowerupState, TankState } from './sim';
import type { PlayerId } from '../types';

/** Two turns of the wheel. */
const TWO_PI = Math.PI * 2;

/** Wrap a radians angle into (-pi, pi]. */
export function wrapAngle(angle: number): number {
	let a = angle % TWO_PI;
	if (a > Math.PI) a -= TWO_PI;
	if (a <= -Math.PI) a += TWO_PI;
	return a;
}

/** Shortest-path signed difference `to - from`, wrapped to (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
	return wrapAngle(to - from);
}

/**
 * Shortest-path angular interpolation: walks from `from` toward `to` the
 * wrapped way, so 179deg -> -179deg moves 2deg through +-180deg, never the
 * 358deg way through 0.
 */
export function lerpAngle(from: number, to: number, t: number): number {
	return wrapAngle(from + angleDelta(from, to) * t);
}

/** Distance (px) between consecutive samples beyond which we snap, not lerp. */
export const SNAP_DISTANCE = 24;
/** Snapshot gap (ticks) above which interpolation snaps to the newer sample. */
export const SNAP_GAP = 12;
/** Bounded sample window (~1.6s at one snapshot per 3 ticks). */
export const MAX_SAMPLES = 32;

type Sample = {
	tick: number;
	tanks: Map<PlayerId, TankState>;
	bullets: Map<number, BulletState>;
	powerups: Map<number, PowerupState>;
	crates: number[];
	/**
	 * Per tank id: this sample continues smoothly from the previous one.
	 * Absent/false entries are discontinuities (respawn, death, teleport,
	 * lives change, huge gap) and interpolation snaps across them.
	 */
	continuous: Map<PlayerId, boolean>;
};

function tankContinuous(a: TankState, b: TankState, gap: number): boolean {
	if (gap > SNAP_GAP) return false;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) return false;
	// Death, respawn and elimination are teleports in state space.
	if (a.alive !== b.alive || a.lives !== b.lives) return false;
	return true;
}

function bulletContinuous(a: BulletState, b: BulletState, gap: number): boolean {
	if (gap > SNAP_GAP) return false;
	// A wall bounce redirects the shell mid-gap; snap instead of arcing it.
	if (a.bounces !== b.bounces) return false;
	const speed = Math.hypot(a.vx, a.vy);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return dx * dx + dy * dy <= (speed * gap + 2) * (speed * gap + 2);
}

/**
 * Bounded, monotonic buffer of authoritative snapshots. Interpolation is a
 * pure function of the buffered stream: feed two clients the same snapshots
 * and they place every remote tank, shell and pickup identically, no matter
 * what their local tick rate or window size is.
 */
export class RemoteBuffer {
	private samples: Sample[] = [];

	get length(): number {
		return this.samples.length;
	}

	/** Tick of the newest sample, or null when empty. */
	get latestTick(): number | null {
		const last = this.samples[this.samples.length - 1];
		return last ? last.tick : null;
	}

	/** Tick of the oldest sample, or null when empty. */
	get oldestTick(): number | null {
		const first = this.samples[0];
		return first ? first.tick : null;
	}

	/**
	 * Append one authoritative snapshot. Out-of-order or duplicate ticks are
	 * dropped (a network reorder must not rewind the world); every push with a
	 * regressed tick would otherwise need a full rebase.
	 */
	push(snapshot: {
		tick: number;
		tanks: TankState[];
		bullets: BulletState[];
		powerups: PowerupState[];
		crates: number[];
	}): void {
		const last = this.samples[this.samples.length - 1];
		if (last && snapshot.tick <= last.tick) return;
		const tanks = new Map<PlayerId, TankState>();
		const continuous = new Map<PlayerId, boolean>();
		const gap = last ? snapshot.tick - last.tick : 0;
		for (const tank of snapshot.tanks) {
			const before = last?.tanks.get(tank.id);
			continuous.set(tank.id, before !== undefined && tankContinuous(before, tank, gap));
			tanks.set(tank.id, tank);
		}
		const bullets = new Map<number, BulletState>();
		for (const bullet of snapshot.bullets) bullets.set(bullet.id, bullet);
		const powerups = new Map<number, PowerupState>();
		for (const powerup of snapshot.powerups) powerups.set(powerup.id, powerup);
		this.samples.push({
			tick: snapshot.tick,
			tanks,
			bullets,
			powerups,
			crates: snapshot.crates.slice(),
			continuous
		});
		while (this.samples.length > MAX_SAMPLES) this.samples.shift();
	}

	/** Drop every sample (used when authoritative state is rebased elsewhere). */
	clear(): void {
		this.samples = [];
	}

	/** Newest known state of a tank (HUD, event VFX anchors). */
	latestTank(id: PlayerId): TankState | null {
		for (let i = this.samples.length - 1; i >= 0; i--) {
			const tank = this.samples[i].tanks.get(id);
			if (tank) return tank;
		}
		return null;
	}

	/** Newest known crate hit points. */
	latestCrates(): number[] | null {
		const last = this.samples[this.samples.length - 1];
		return last ? last.crates.slice() : null;
	}

	/**
	 * Interpolated tank at `atTick` in snapshot-tick time. Position and angle
	 * (shortest path) blend between samples only while the pair is continuous;
	 * across a discontinuity the nearer sample wins outright (snap). Discrete
	 * fields (alive, lives, respawn/invuln timers...) always come from the
	 * samples, so snapshot state fully drives remote rendering.
	 */
	tankAt(id: PlayerId, atTick: number): TankState | null {
		const { prev, next } = this.pair(atTick);
		const a = prev?.tanks.get(id) ?? null;
		const b = next?.tanks.get(id) ?? null;
		// (!a implies !prev) and (!b implies !next): the guards narrow for TS.
		if (!a || !prev) return b;
		if (!b || !next) return a;
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		if (t <= 0) return a;
		if (t >= 1) return b;
		if (!(next.continuous.get(id) ?? false)) return t < 0.5 ? a : b;
		return {
			...a,
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
			angle: lerpAngle(a.angle, b.angle, t)
		};
	}

	/** Interpolated shells at `atTick`; bouncing/unmatched shells snap too. */
	bulletsAt(atTick: number): BulletState[] {
		const { prev, next } = this.pair(atTick);
		if (!prev) return next ? [...next.bullets.values()] : [];
		if (!next) return [...prev.bullets.values()];
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		const out: BulletState[] = [];
		for (const [id, a] of prev.bullets) {
			const b = next.bullets.get(id);
			if (!b) {
				out.push(a);
				continue;
			}
			if (t <= 0 || !bulletContinuous(a, b, span)) {
				out.push(t < 0.5 ? a : b);
				continue;
			}
			out.push({ ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
		}
		for (const [id, b] of next.bullets) {
			if (!prev.bullets.has(id)) out.push(b);
		}
		return out;
	}

	/** Power-ups on the map as of `atTick` (they never move, so no lerp). */
	powerupsAt(atTick: number): PowerupState[] {
		const { prev, next } = this.pair(atTick);
		const use = prev ?? next;
		return use ? [...use.powerups.values()] : [];
	}

	/** Crate hit points as of `atTick`. */
	cratesAt(atTick: number): number[] | null {
		const { prev, next } = this.pair(atTick);
		const use = prev ?? next;
		return use ? use.crates.slice() : null;
	}

	private pair(atTick: number): { prev: Sample | null; next: Sample | null } {
		let prev: Sample | null = null;
		let next: Sample | null = null;
		for (const sample of this.samples) {
			if (sample.tick <= atTick) prev = sample;
			else {
				next = sample;
				break;
			}
		}
		return { prev, next };
	}
}
