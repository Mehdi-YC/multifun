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
	/** Insertion-ordered mirror of `tanks` for allocation-free iteration. */
	tankList: TankState[];
	bullets: Map<number, BulletState>;
	/** Insertion-ordered mirror of `bullets` for allocation-free iteration. */
	bulletList: BulletState[];
	powerups: Map<number, PowerupState>;
	/** Insertion-ordered mirror of `powerups` for allocation-free iteration. */
	powerupList: PowerupState[];
	crates: number[];
	/**
	 * Per tank id: this sample continues smoothly from the previous one.
	 * Absent/false entries are discontinuities (respawn, death, teleport,
	 * lives change, huge gap) and interpolation snaps across them.
	 */
	continuous: Map<PlayerId, boolean>;
};

/** Copy every field of `src` into the caller-owned `dst` (zero allocation). */
function copyTank(dst: TankState, src: TankState): TankState {
	dst.id = src.id;
	dst.x = src.x;
	dst.y = src.y;
	dst.angle = src.angle;
	dst.moveDir = src.moveDir;
	dst.lives = src.lives;
	dst.kills = src.kills;
	dst.deaths = src.deaths;
	dst.damage = src.damage;
	dst.xp = src.xp;
	dst.level = src.level;
	dst.reloadTimer = src.reloadTimer;
	dst.respawnTimer = src.respawnTimer;
	dst.invulnTimer = src.invulnTimer;
	dst.alive = src.alive;
	dst.lastKeys = src.lastKeys;
	dst.shield = src.shield;
	dst.triple = src.triple;
	dst.rapidTimer = src.rapidTimer;
	dst.speedTimer = src.speedTimer;
	return dst;
}

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
	/** Cursor set by `seek()`: the sample pair bracketing a render tick. */
	private seekPrev: Sample | null = null;
	private seekNext: Sample | null = null;

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
			tankList: snapshot.tanks,
			bullets,
			bulletList: snapshot.bullets,
			powerups,
			powerupList: snapshot.powerups,
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

	/** Newest known crate hit points (a copy — safe to mutate). */
	latestCrates(): number[] | null {
		const last = this.samples[this.samples.length - 1];
		return last ? last.crates.slice() : null;
	}

	/**
	 * Newest known crate hit points, borrowed read-only. Callers that need a
	 * mutable copy should copy in place into a reused array (see
	 * `render.syncCrates`) — never mutate the returned reference.
	 */
	latestCratesRef(): readonly number[] | null {
		const last = this.samples[this.samples.length - 1];
		return last ? last.crates : null;
	}

	/**
	 * Interpolated tank at `atTick` in snapshot-tick time. Position and angle
	 * (shortest path) blend between samples only while the pair is continuous;
	 * across a discontinuity the nearer sample wins outright (snap). Discrete
	 * fields (alive, lives, respawn/invuln timers...) always come from the
	 * samples, so snapshot state fully drives remote rendering.
	 */
	tankAt(id: PlayerId, atTick: number): TankState | null {
		return this.tankAtInto(id, atTick, {} as TankState);
	}

	/**
	 * Allocation-free `tankAt`: writes the resolved state into the
	 * caller-owned `out` and returns it (or null when the tank is unknown).
	 * `out` must not be shared between in-flight lookups.
	 */
	tankAtInto(id: PlayerId, atTick: number, out: TankState): TankState | null {
		this.seek(atTick);
		const prev = this.seekPrev;
		const next = this.seekNext;
		const a = prev?.tanks.get(id) ?? null;
		const b = next?.tanks.get(id) ?? null;
		// (!a implies !prev) and (!b implies !next): the guards narrow for TS.
		if (!a || !prev) return b ? copyTank(out, b) : null;
		if (!b || !next) return copyTank(out, a);
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		if (t <= 0) return copyTank(out, a);
		if (t >= 1) return copyTank(out, b);
		if (!(next.continuous.get(id) ?? false)) return copyTank(out, t < 0.5 ? a : b);
		copyTank(out, a);
		out.x = a.x + (b.x - a.x) * t;
		out.y = a.y + (b.y - a.y) * t;
		out.angle = lerpAngle(a.angle, b.angle, t);
		return out;
	}

	/** Interpolated shells at `atTick`; bouncing/unmatched shells snap too. */
	bulletsAt(atTick: number): BulletState[] {
		const out: BulletState[] = [];
		this.bulletsAtInto(atTick, out);
		return out;
	}

	/**
	 * Allocation-free `bulletsAt`: writes resolved shells into `out` (slots
	 * are reused across calls and fully overwritten) and returns the count.
	 */
	bulletsAtInto(atTick: number, out: BulletState[]): number {
		this.seek(atTick);
		const prev = this.seekPrev;
		const next = this.seekNext;
		let n = 0;
		if (!prev) {
			if (!next) return 0;
			const list = next.bulletList;
			for (let i = 0; i < list.length; i++) n = this.writeBullet(out, n, list[i], list[i], 0);
			return n;
		}
		const span = next ? next.tick - prev.tick : 0;
		const t = next ? (span > 0 ? (atTick - prev.tick) / span : 1) : 1;
		const prevList = prev.bulletList;
		for (let i = 0; i < prevList.length; i++) {
			const a = prevList[i];
			const b = next ? next.bullets.get(a.id) : undefined;
			if (!b) {
				n = this.writeBullet(out, n, a, a, 0);
				continue;
			}
			if (t <= 0 || !bulletContinuous(a, b, span)) {
				n = this.writeBullet(out, n, t < 0.5 ? a : b, a, 0);
				continue;
			}
			n = this.writeBullet(out, n, a, a, 1, b, t);
		}
		if (next) {
			const nextList = next.bulletList;
			for (let i = 0; i < nextList.length; i++) {
				const b = nextList[i];
				if (!prev.bullets.has(b.id)) n = this.writeBullet(out, n, b, b, 0);
			}
		}
		return n;
	}

	/** Copy one shell into `out[n]` (blending `a` toward `b` when `blend` is 1). */
	private writeBullet(
		out: BulletState[],
		n: number,
		src: BulletState,
		a: BulletState,
		blend: 0 | 1,
		b?: BulletState,
		t = 0
	): number {
		const slot = out[n] ?? (out[n] = { ...src });
		slot.id = src.id;
		slot.owner = src.owner;
		slot.x = blend && b ? a.x + (b.x - a.x) * t : src.x;
		slot.y = blend && b ? a.y + (b.y - a.y) * t : src.y;
		slot.vx = src.vx;
		slot.vy = src.vy;
		slot.life = src.life;
		slot.bounces = src.bounces;
		return n + 1;
	}

	/** Power-ups on the map as of `atTick` (they never move, so no lerp). */
	powerupsAt(atTick: number): PowerupState[] {
		const out: PowerupState[] = [];
		this.powerupsAtInto(atTick, out);
		return out;
	}

	/**
	 * Allocation-free `powerupsAt`: writes the pickups visible at `atTick`
	 * into `out` (slots reused across calls) and returns the count.
	 */
	powerupsAtInto(atTick: number, out: PowerupState[]): number {
		this.seek(atTick);
		const use = this.seekPrev ?? this.seekNext;
		if (!use) return 0;
		const list = use.powerupList;
		for (let i = 0; i < list.length; i++) {
			const src = list[i];
			const slot = out[i] ?? (out[i] = { ...src });
			slot.id = src.id;
			slot.kind = src.kind;
			slot.x = src.x;
			slot.y = src.y;
			slot.born = src.born;
		}
		return list.length;
	}

	/** Crate hit points as of `atTick` (a copy — safe to mutate). */
	cratesAt(atTick: number): number[] | null {
		this.seek(atTick);
		const use = this.seekPrev ?? this.seekNext;
		return use ? use.crates.slice() : null;
	}

	/** Position the `seekPrev`/`seekNext` cursor on the pair bracketing `atTick`. */
	private seek(atTick: number): void {
		let prev: Sample | null = null;
		let next: Sample | null = null;
		const samples = this.samples;
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];
			if (sample.tick <= atTick) prev = sample;
			else {
				next = sample;
				break;
			}
		}
		this.seekPrev = prev;
		this.seekNext = next;
	}
}
