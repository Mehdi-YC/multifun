/**
 * Snapshot interpolation for Turbo Kart remote entities.
 *
 * The three desync lessons from the tank build are baked in structurally:
 *
 * 1. Angles are circular. Lerping `179deg -> -179deg` naively spins the long
 *    way (through 0) for half a second. All angle blending goes through
 *    `lerpAngle`, which wraps the delta to (-pi, pi] first (shortest path).
 *
 * 2. Discontinuities must snap, never slide. Respawns teleport a kart back to
 *    its checkpoint anchor and reorient it along the racing line; spin-outs,
 *    lightning shocks and hard corrections rip velocity around. `RemoteBuffer`
 *    marks every sample that does NOT continue smoothly from the previous one
 *    (teleport distance, spin/shock/finish transitions, angle whips, sudden
 *    stops) and interpolation across a discontinuity snaps to the nearest
 *    sample instead of blending.
 *
 * 3. The buffer is the client's remote-entity clock: `renderTick` is derived
 *    from the snapshot stream's own ticks (`render.ts`), so two browsers with
 *    different frame rates, window sizes or dropped ticks render the same
 *    world position for the same snapshot stream.
 */
import type { PlayerId } from '../types';
import type { ItemBoxState, KartState, MissileState, SlickState } from './sim';

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
export const SNAP_DISTANCE = 26;
/** Snapshot gap (ticks) above which interpolation snaps to the newer sample. */
export const SNAP_GAP = 12;
/** Angle change (rad) between samples that reads as a whip, not a turn. */
export const SNAP_ANGLE = Math.PI / 2;
/** Bounded sample window (~1.6s at one snapshot per 3 ticks). */
export const MAX_SAMPLES = 32;

type Sample = {
	tick: number;
	karts: Map<PlayerId, KartState>;
	missiles: Map<number, MissileState>;
	slicks: Map<number, SlickState>;
	boxes: ItemBoxState[];
	breakableHp: number[];
	/**
	 * Per kart id: this sample continues smoothly from the previous one.
	 * Absent/false entries are discontinuities (respawn, spin-out start, shock,
	 * finish, teleport, huge gap) and interpolation snaps across them.
	 */
	continuous: Map<PlayerId, boolean>;
};

function kartContinuous(a: KartState, b: KartState, gap: number): boolean {
	if (gap > SNAP_GAP) return false;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) return false;
	// Spin-outs, lightning shocks and finishes are discontinuities in state.
	if (a.spinTimer > 0 !== b.spinTimer > 0) return false;
	if (a.shrinkTimer > 0 !== b.shrinkTimer > 0) return false;
	if (a.finished !== b.finished) return false;
	// A respawn reorients the kart along the racing line in one step.
	if (Math.abs(angleDelta(a.angle, b.angle)) > SNAP_ANGLE) return false;
	// A respawn-boost stops the kart dead first (boost pads do not).
	if (a.speed > 1 && Math.abs(b.speed) < 0.1) return false;
	return true;
}

function missileContinuous(a: MissileState, b: MissileState, gap: number): boolean {
	if (gap > SNAP_GAP) return false;
	const speed = 6;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	// Homing turns up to MISSILE_TURN per tick; anything faster is a redirect.
	if (Math.abs(angleDelta(a.angle, b.angle)) > 0.2 * gap + 0.1) return false;
	return dx * dx + dy * dy <= (speed * gap + 2) * (speed * gap + 2);
}

/**
 * Bounded, monotonic buffer of authoritative snapshots. Interpolation is a
 * pure function of the buffered stream: feed two clients the same snapshots
 * and they place every remote kart, missile and slick identically, no matter
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
	 * dropped (a network reorder must not rewind the world).
	 */
	push(snapshot: {
		tick: number;
		karts: KartState[];
		missiles: MissileState[];
		slicks: SlickState[];
		boxes: ItemBoxState[];
		breakableHp: number[];
	}): void {
		const last = this.samples[this.samples.length - 1];
		if (last && snapshot.tick <= last.tick) return;
		const karts = new Map<PlayerId, KartState>();
		const continuous = new Map<PlayerId, boolean>();
		const gap = last ? snapshot.tick - last.tick : 0;
		for (const kart of snapshot.karts) {
			const before = last?.karts.get(kart.id);
			continuous.set(kart.id, before !== undefined && kartContinuous(before, kart, gap));
			karts.set(kart.id, kart);
		}
		const missiles = new Map<number, MissileState>();
		for (const missile of snapshot.missiles) missiles.set(missile.id, missile);
		const slicks = new Map<number, SlickState>();
		for (const slick of snapshot.slicks) slicks.set(slick.id, slick);
		this.samples.push({
			tick: snapshot.tick,
			karts,
			missiles,
			slicks,
			boxes: snapshot.boxes.map((b) => ({ ...b })),
			breakableHp: snapshot.breakableHp.slice(),
			continuous
		});
		while (this.samples.length > MAX_SAMPLES) this.samples.shift();
	}

	/** Drop every sample (used when authoritative state is rebased elsewhere). */
	clear(): void {
		this.samples = [];
	}

	/** Newest known state of a kart (HUD, event VFX anchors). */
	latestKart(id: PlayerId): KartState | null {
		for (let i = this.samples.length - 1; i >= 0; i--) {
			const kart = this.samples[i].karts.get(id);
			if (kart) return kart;
		}
		return null;
	}

	/**
	 * Interpolated kart at `atTick` in snapshot-tick time. Position and angle
	 * (shortest path) blend between samples only while the pair is continuous;
	 * across a discontinuity the nearer sample wins outright (snap). Discrete
	 * fields (spin/boost/shield timers, lap, item...) always come from the
	 * samples, so snapshot state fully drives remote rendering.
	 */
	kartAt(id: PlayerId, atTick: number): KartState | null {
		const { prev, next } = this.pair(atTick);
		const a = prev?.karts.get(id) ?? null;
		const b = next?.karts.get(id) ?? null;
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
			z: a.z + (b.z - a.z) * t,
			angle: lerpAngle(a.angle, b.angle, t)
		};
	}

	/** Interpolated missiles at `atTick`; redirected/unmatched ones snap too. */
	missilesAt(atTick: number): MissileState[] {
		const { prev, next } = this.pair(atTick);
		if (!prev) return next ? [...next.missiles.values()] : [];
		if (!next) return [...prev.missiles.values()];
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		const out: MissileState[] = [];
		for (const [id, a] of prev.missiles) {
			const b = next.missiles.get(id);
			if (!b) {
				out.push(a);
				continue;
			}
			if (t <= 0 || !missileContinuous(a, b, span)) {
				out.push(t < 0.5 ? a : b);
				continue;
			}
			out.push({
				...a,
				x: a.x + (b.x - a.x) * t,
				y: a.y + (b.y - a.y) * t,
				angle: lerpAngle(a.angle, b.angle, t)
			});
		}
		for (const [id, b] of next.missiles) {
			if (!prev.missiles.has(id)) out.push(b);
		}
		return out;
	}

	/** Oil slicks as of `atTick` (they never move, so no lerp). */
	slicksAt(atTick: number): SlickState[] {
		const { prev, next } = this.pair(atTick);
		const use = prev ?? next;
		return use ? [...use.slicks.values()] : [];
	}

	/** Item box respawn timers as of `atTick`. */
	boxesAt(atTick: number): ItemBoxState[] | null {
		const { prev, next } = this.pair(atTick);
		const use = prev ?? next;
		return use ? use.boxes.map((b) => ({ ...b })) : null;
	}

	/** Breakable wall hit points as of `atTick`. */
	breakableHpAt(atTick: number): number[] | null {
		const { prev, next } = this.pair(atTick);
		const use = prev ?? next;
		return use ? use.breakableHp.slice() : null;
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
