/**
 * Desync regression tests for remote-entity interpolation:
 * (c) hull angles must interpolate the SHORT way across the +-pi seam
 *     (179deg -> -179deg moves 2deg, never 358deg), and
 * (b) respawns/teleports/deaths are discontinuities: the buffer must SNAP,
 *     never slide the tank across the map, and discrete state (alive, lives,
 *     respawn/invuln timers) must come straight from the snapshots.
 * Plus buffer hygiene: monotonic ticks, bounded size, power-up/crate views.
 */
import { describe, expect, it } from 'vitest';
import type { BulletState, PowerupState, TankState } from './sim';
import { RemoteBuffer, SNAP_DISTANCE, angleDelta, lerpAngle, wrapAngle } from './interp';

const DEG = Math.PI / 180;

function tank(
	id: string,
	x: number,
	y: number,
	angle: number,
	over: Partial<TankState> = {}
): TankState {
	return {
		id,
		x,
		y,
		angle,
		moveDir: 0,
		lives: 2,
		kills: 0,
		deaths: 0,
		damage: 0,
		xp: 0,
		level: 1,
		reloadTimer: 0,
		respawnTimer: 0,
		invulnTimer: 0,
		alive: true,
		lastKeys: 0,
		shield: 0,
		triple: 0,
		rapidTimer: 0,
		speedTimer: 0,
		...over
	};
}

function bullet(id: number, x: number, y: number, vx: number, vy: number): BulletState {
	return { id, owner: 'p1', x, y, vx, vy, life: 80, bounces: 0 };
}

function powerup(id: number, kind: PowerupState['kind'], x: number, y: number): PowerupState {
	return { id, kind, x, y, born: 0 };
}

function push(
	buf: RemoteBuffer,
	tick: number,
	tanks: TankState[],
	extra: { bullets?: BulletState[]; powerups?: PowerupState[]; crates?: number[] } = {}
): void {
	buf.push({
		tick,
		tanks,
		bullets: extra.bullets ?? [],
		powerups: extra.powerups ?? [],
		crates: extra.crates ?? []
	});
}

describe('angle helpers', () => {
	it('wraps angles into (-pi, pi]', () => {
		expect(wrapAngle(0)).toBe(0);
		expect(wrapAngle(Math.PI)).toBe(Math.PI);
		expect(wrapAngle(-Math.PI)).toBe(Math.PI); // -pi maps onto +pi
		expect(wrapAngle(2 * Math.PI)).toBe(0);
		expect(wrapAngle(3 * Math.PI)).toBe(Math.PI);
		expect(wrapAngle(Math.PI + 0.25)).toBeCloseTo(-Math.PI + 0.25, 10);
		expect(wrapAngle(-Math.PI - 0.25)).toBeCloseTo(Math.PI - 0.25, 10);
		expect(wrapAngle(1000 * Math.PI + 0.5)).toBeCloseTo(0.5, 6);
	});

	it('takes the shortest path across the +-pi seam (179deg -> -179deg)', () => {
		const from = 179 * DEG;
		const to = -179 * DEG;
		// The delta is +2deg through +-180deg, not -358deg through 0.
		expect(angleDelta(from, to)).toBeCloseTo(2 * DEG, 10);
		expect(angleDelta(to, from)).toBeCloseTo(-2 * DEG, 10);

		const mid = lerpAngle(from, to, 0.5);
		// Midpoint sits at +-180deg...
		expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1 * DEG);
		// ...having travelled 1deg from each side (2deg total sweep).
		expect(Math.abs(angleDelta(from, mid))).toBeCloseTo(1 * DEG, 6);
		expect(Math.abs(angleDelta(to, mid))).toBeCloseTo(1 * DEG, 6);
		// The naive lerp (the old bug) would have parked mid at 0deg.
		expect(Math.abs(mid)).toBeGreaterThan(170 * DEG);
	});

	it('lerps ordinary angles without wrapping', () => {
		expect(lerpAngle(-0.2, 0.2, 0.5)).toBeCloseTo(0, 10);
		expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 10);
	});
});

describe('RemoteBuffer angle interpolation', () => {
	it('blends hull angles the short way when a turn crosses the seam', () => {
		const buf = new RemoteBuffer();
		push(buf, 100, [tank('p2', 200, 100, 179 * DEG)]);
		push(buf, 103, [tank('p2', 200, 100, -179 * DEG)]);
		for (let tick = 100; tick <= 103; tick += 0.25) {
			const state = buf.tankAt('p2', tick);
			expect(state).not.toBeNull();
			// Never anywhere near 0deg: the old naive lerp swept through there.
			expect(Math.abs(state!.angle)).toBeGreaterThan(170 * DEG);
		}
	});
});

describe('RemoteBuffer discontinuities snap', () => {
	it('snaps across a respawn teleport instead of sliding across the map', () => {
		const buf = new RemoteBuffer();
		const deathX = 60;
		const deathY = 60;
		const spawnX = 420;
		const spawnY = 210;
		push(buf, 100, [tank('p2', deathX, deathY, 0, { alive: false, lives: 1, respawnTimer: 2 })]);
		push(buf, 103, [tank('p2', spawnX, spawnY, 0, { invulnTimer: 90 })]);

		for (let tick = 100; tick <= 103; tick += 0.1) {
			const state = buf.tankAt('p2', tick);
			expect(state).not.toBeNull();
			const nearDeath = Math.hypot(state!.x - deathX, state!.y - deathY) < 1;
			const nearSpawn = Math.hypot(state!.x - spawnX, state!.y - spawnY) < 1;
			// Strictly one anchor or the other: never in between (the slide).
			expect(nearDeath || nearSpawn).toBe(true);
		}
		// Before the midpoint the older sample stands; after it the newer one.
		expect(buf.tankAt('p2', 101.4)!.x).toBe(deathX);
		expect(buf.tankAt('p2', 101.6)!.x).toBe(spawnX);
	});

	it('snaps on deaths, eliminations and lives changes', () => {
		const buf = new RemoteBuffer();
		// Death at the same spot (state-space discontinuity).
		push(buf, 10, [tank('p2', 100, 100, 0, { respawnTimer: 120 })]);
		push(buf, 13, [tank('p2', 100, 100, 0, { alive: false, lives: 1, respawnTimer: 117 })]);
		for (let tick = 10; tick <= 13; tick += 0.25) {
			const state = buf.tankAt('p2', tick)!;
			expect(state.x).toBe(100);
			// Discrete state always comes from one sample or the other.
			expect([120, 117]).toContain(state.respawnTimer);
		}

		// Elimination (lives 2 -> 0 while alive) with a nudge of movement.
		const buf2 = new RemoteBuffer();
		push(buf2, 10, [tank('p2', 100, 100, 0, { lives: 2 })]);
		push(buf2, 13, [tank('p2', 103, 100, 0, { lives: 0, alive: false })]);
		const mid = buf2.tankAt('p2', 11.5)!;
		expect([100, 103]).toContain(mid.x); // snapped, not 101.5
	});

	it('snaps across big jumps and huge snapshot gaps', () => {
		const buf = new RemoteBuffer();
		push(buf, 100, [tank('p2', 100, 100, 0)]);
		push(buf, 103, [tank('p2', 100 + SNAP_DISTANCE + 40, 100, 0)]);
		const mid = buf.tankAt('p2', 101.5)!;
		expect([100, 100 + SNAP_DISTANCE + 40]).toContain(mid.x);

		const gapped = new RemoteBuffer();
		push(gapped, 100, [tank('p2', 100, 100, 0)]);
		push(gapped, 300, [tank('p2', 103, 100, 0)]); // 200-tick stall
		expect(gapped.tankAt('p2', 290)!.x).toBe(103); // nearer sample wins
		expect(gapped.tankAt('p2', 110)!.x).toBe(100);
	});

	it('lerps smoothly between continuous samples', () => {
		const buf = new RemoteBuffer();
		push(buf, 100, [tank('p2', 100, 100, 0)]);
		push(buf, 103, [tank('p2', 106, 100, 0)]);
		expect(buf.tankAt('p2', 101.5)!.x).toBeCloseTo(103, 10);
		expect(buf.tankAt('p2', 100)!.x).toBe(100);
		expect(buf.tankAt('p2', 103)!.x).toBe(106);
	});
});

describe('RemoteBuffer snapshot-driven state', () => {
	it('takes alive/lives/respawnTimer/invulnTimer straight from the snapshots', () => {
		const buf = new RemoteBuffer();
		push(buf, 100, [
			tank('p2', 100, 100, 0, { alive: false, lives: 1, respawnTimer: 120, invulnTimer: 0 })
		]);
		push(buf, 103, [
			tank('p2', 100, 100, 0, { alive: false, lives: 1, respawnTimer: 117, invulnTimer: 0 })
		]);
		const mid = buf.tankAt('p2', 101.5)!;
		expect(mid.alive).toBe(false);
		expect(mid.lives).toBe(1);
		expect(mid.respawnTimer).toBe(120); // the older sample's discrete state
	});

	it('keeps samples monotonic and bounded, and exposes latest/oldest ticks', () => {
		const buf = new RemoteBuffer();
		for (let tick = 1; tick <= 100; tick++) push(buf, tick, [tank('p2', tick, 0, 0)]);
		expect(buf.length).toBeLessThanOrEqual(32);
		expect(buf.latestTick).toBe(100);
		expect(buf.oldestTick).toBe(69);
		// Out-of-order and duplicate snapshots are dropped, not rebased in.
		push(buf, 99, [tank('p2', -999, 0, 0)]);
		push(buf, 100, [tank('p2', -999, 0, 0)]);
		expect(buf.latestTick).toBe(100);
		expect(buf.tankAt('p2', 100)!.x).toBe(100);
		buf.clear();
		expect(buf.length).toBe(0);
		expect(buf.latestTick).toBeNull();
		expect(buf.tankAt('p2', 100)).toBeNull();
	});
});

describe('RemoteBuffer shells and power-ups', () => {
	it('interpolates shells but snaps them across bounces', () => {
		const buf = new RemoteBuffer();
		push(buf, 10, [], { bullets: [bullet(1, 100, 100, 6, 0)] });
		push(buf, 13, [], { bullets: [bullet(1, 118, 100, 6, 0)] });
		const mid = buf.bulletsAt(11.5).find((b) => b.id === 1)!;
		expect(mid.x).toBeCloseTo(109, 10);

		// Bounced shell: velocity flips, so no smooth path exists.
		const bounced = new RemoteBuffer();
		push(bounced, 10, [], { bullets: [{ ...bullet(1, 100, 100, 6, 0), bounces: 0 }] });
		push(bounced, 13, [], { bullets: [{ ...bullet(1, 106, 100, -6, 0), bounces: 1 }] });
		const snapped = bounced.bulletsAt(11.5).find((b) => b.id === 1)!;
		expect([100, 106]).toContain(snapped.x);
	});

	it('shows power-ups as of the render tick (they never move)', () => {
		const buf = new RemoteBuffer();
		push(buf, 10, [], { powerups: [powerup(1, 'shield', 200, 100)] });
		push(buf, 13, [], {
			powerups: [powerup(1, 'shield', 200, 100), powerup(2, 'rapid', 240, 100)]
		});
		expect(buf.powerupsAt(11).map((p) => p.id)).toEqual([1]);
		expect(buf.powerupsAt(13).map((p) => p.id)).toEqual([1, 2]);
	});
});
