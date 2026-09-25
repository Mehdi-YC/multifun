/**
 * THE determinism test for Pixel Tanks: same seed + same recorded input stream
 * must reproduce identical sims — on every tick, across snapshot/restore and in
 * the final results. Plus the combat rules: lives, respawns, invulnerability,
 * crate destruction, wall bounces, collisions, level-ups and rankings.
 */
import { describe, expect, it } from 'vitest';
import type { GameConfig, InputFrame, PlayerId, SimPlayer } from '../types';
import { KEY } from '../types';
import {
	BULLET_LIFE,
	EFFECT_TICKS,
	INVULN_TICKS,
	POWERUP_GRACE_TICKS,
	POWERUP_KINDS,
	POWERUP_MAX_ALIVE,
	POWERUP_SPAWN_INTERVAL,
	RESPAWN_TICKS,
	SPEED_MULTIPLIER,
	TRIPLE_SHOTS,
	XP_PER_HIT,
	XP_PER_KILL,
	bulletSpeed,
	createTankSim,
	levelForXp,
	maxBounces,
	parseTankSnapshot,
	rapidReloadTicks,
	reloadTicks,
	speedScale,
	type PowerupKind,
	type PowerupState,
	type TankSim
} from './sim';
import { tileAtPx } from './arena';

const P1: SimPlayer = { id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 };
const P2: SimPlayer = { id: 'p2', name: 'Ben', color: '#57e389', slot: 1 };
const P3: SimPlayer = { id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 };
const PLAYERS = [P1, P2, P3];

const SEED = 1337;
const CONFIG: GameConfig = {
	tickRate: 60,
	durationTicks: 600,
	options: { arenaId: 'crossfire', countdownTicks: 0 }
};

type Stream = Map<PlayerId, InputFrame>[];

function inputMap(keys: Partial<Record<PlayerId, number>>): Map<PlayerId, InputFrame> {
	const map = new Map<PlayerId, InputFrame>();
	for (const [id, mask] of Object.entries(keys)) map.set(id, { keys: mask ?? 0 });
	return map;
}

function place(sim: TankSim, id: PlayerId, x: number, y: number, angle: number): void {
	const tank = sim.tanks.find((t) => t.id === id);
	if (!tank) throw new Error(`no tank ${id}`);
	tank.x = x;
	tank.y = y;
	tank.angle = angle;
}

/** Deterministic input script: purely a function of (tick, player index). */
function scriptKeys(tick: number, index: number): number {
	let keys = 0;
	if ((tick + index) % 3 === 0) keys |= KEY.RIGHT;
	if ((tick + index) % 5 === 0) keys |= KEY.DOWN;
	if ((tick + index) % 7 === 0) keys |= KEY.LEFT;
	if ((tick + index) % 11 === 0) keys |= KEY.UP;
	if ((tick + index) % 13 === 0) keys |= KEY.JUMP;
	if ((tick + index) % 17 === 0) keys |= KEY.DRIFT;
	return keys;
}

function makeStream(ticks: number): Stream {
	const stream: Stream = [];
	for (let t = 0; t < ticks; t++) {
		const frame = inputMap({});
		PLAYERS.forEach((p, i) => frame.set(p.id, { keys: scriptKeys(t, i) }));
		stream.push(frame);
	}
	return stream;
}

describe('tank sim determinism', () => {
	it('two sims with the same seed and input stream hash identically at every tick', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 720 };
		const a = createTankSim(SEED, config, PLAYERS);
		const b = createTankSim(SEED, config, PLAYERS);
		const stream = makeStream(config.durationTicks);

		const hashes = new Set<number>();
		for (const frame of stream) {
			a.tickOnce(frame);
			b.tickOnce(frame);
			expect(a.hash()).toBe(b.hash());
			expect(a.tick).toBe(b.tick);
			hashes.add(a.hash());
		}

		// The hash actually observes state changes along the way.
		expect(hashes.size).toBeGreaterThan(10);
		expect(a.finished).toBe(true);
		expect(a.results()).toEqual(b.results());
		expect(a.hash()).toBe(a.hash());
	});

	it('produces a stable unsigned 32-bit hash', () => {
		const sim = createTankSim(SEED, CONFIG, PLAYERS);
		const h = sim.hash();
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
	});
});

describe('tank sim snapshot/restore', () => {
	it('resumed sim matches an uninterrupted run tick for tick', () => {
		const cut = 300;
		const config: GameConfig = { ...CONFIG, durationTicks: 720 };
		const stream = makeStream(config.durationTicks);

		const a = createTankSim(SEED, config, PLAYERS);
		let snap: ReturnType<TankSim['snapshot']> | null = null;
		let hashAtCut = 0;
		const hashesAfterCut: number[] = [];
		stream.forEach((frame, i) => {
			a.tickOnce(frame);
			if (i === cut - 1) {
				snap = a.snapshot();
				hashAtCut = a.hash();
			}
			if (i >= cut) hashesAfterCut.push(a.hash());
		});
		const endHash = a.hash();
		expect(snap).not.toBeNull();

		const b = createTankSim(SEED, config, PLAYERS);
		for (let i = 0; i < cut; i++) b.tickOnce(stream[i]);
		b.restore(snap!);
		expect(b.hash()).toBe(hashAtCut);
		expect(b.tick).toBe(cut);

		stream.slice(cut).forEach((frame, i) => {
			b.tickOnce(frame);
			expect(b.hash()).toBe(hashesAfterCut[i]);
		});
		expect(b.hash()).toBe(endHash);
		expect(b.results()).toEqual(a.results());
	});

	it('restore works into a fresh sim (different seed) and preserves results', () => {
		const cut = 200;
		const config: GameConfig = { ...CONFIG, durationTicks: 600 };
		const stream = makeStream(config.durationTicks);
		const a = createTankSim(SEED, config, PLAYERS);
		for (let i = 0; i < cut; i++) a.tickOnce(stream[i]);
		const snap = a.snapshot();

		// Different seed => different spawn scatter; restore must erase it.
		const b = createTankSim(SEED + 999, config, PLAYERS);
		b.restore(snap);
		expect(b.hash()).toBe(a.hash());
		expect(b.tick).toBe(cut);

		for (let i = cut; i < stream.length; i++) {
			a.tickOnce(stream[i]);
			b.tickOnce(stream[i]);
		}
		expect(b.hash()).toBe(a.hash());
		expect(b.results()).toEqual(a.results());
	});

	it('snapshot parsing accepts round trips and rejects garbage', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		for (let i = 0; i < 50; i++) sim.tickOnce(inputMap({ p1: KEY.UP | KEY.JUMP }));
		const parsed = parseTankSnapshot(sim.snapshot());
		expect(parsed).not.toBeNull();
		expect(parsed!.tick).toBe(50);
		expect(parsed!.tanks).toHaveLength(2);
		expect(parseTankSnapshot({})).toBeNull();
		expect(parseTankSnapshot({ tick: 1, tanks: [], bullets: [], crates: ['x'] })).toBeNull();
		expect(parseTankSnapshot({ tick: 1, tanks: [{}], bullets: [], crates: [] })).toBeNull();
	});
});

describe('tank sim combat', () => {
	it('one hit costs a life, then a 120-tick respawn with 90 ticks of invulnerability', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 200, 24, 0);
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));

		const victim = sim.tanks[1];
		const shooter = sim.tanks[0];
		for (let i = 0; i < 30 && victim.lives === 2; i++) sim.tickOnce(new Map());
		expect(victim.lives).toBe(1);
		expect(victim.deaths).toBe(1);
		expect(victim.alive).toBe(false);
		expect(victim.respawnTimer).toBe(RESPAWN_TICKS);
		expect(shooter.damage).toBe(1);
		expect(shooter.xp).toBe(XP_PER_HIT);
		expect(shooter.kills).toBe(0);
		const hitEvents = sim.drainEvents();
		expect(hitEvents.filter((e) => e.kind === 'hit')).toHaveLength(1);
		expect(hitEvents.filter((e) => e.kind === 'death')).toHaveLength(1);

		// Respawn lands exactly RESPAWN_TICKS after the hit, shielded.
		let respawnedAt = -1;
		for (let i = 0; i < RESPAWN_TICKS + 5 && respawnedAt < 0; i++) {
			sim.tickOnce(new Map());
			if (victim.alive) respawnedAt = i;
		}
		expect(respawnedAt).toBe(RESPAWN_TICKS - 1);
		expect(victim.invulnTimer).toBe(INVULN_TICKS);
		expect(victim.respawnTimer).toBe(0);
		const respawnEvents = sim.drainEvents();
		expect(respawnEvents.filter((e) => e.kind === 'spawn' && e.player === 'p2')).toHaveLength(1);
	});

	it('self-hits count: your own shell costs you a life', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 120, 40, -Math.PI / 2);
		place(sim, 'p2', 300, 24, 0);
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));

		const self = sim.tanks[0];
		for (let i = 0; i < 30 && self.lives === 2; i++) sim.tickOnce(new Map());
		expect(self.lives).toBe(1);
		expect(self.deaths).toBe(1);
		expect(self.damage).toBe(1); // the shooter is credited even when it is you
		expect(self.xp).toBe(XP_PER_HIT);
		expect(sim.tanks[1].lives).toBe(2);
	});

	it('elimination pays kills + xp, emits hit/death/finish and ranks the survivor first', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 200, 24, 0);
		sim.tanks[1].lives = 1;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 30 && sim.tanks[1].lives > 0; i++) sim.tickOnce(new Map());

		expect(sim.tanks[1].lives).toBe(0);
		expect(sim.tanks[1].alive).toBe(false);
		expect(sim.tanks[0].kills).toBe(1);
		expect(sim.tanks[0].xp).toBe(XP_PER_HIT + XP_PER_KILL);
		expect(sim.finished).toBe(true); // only one tank keeps lives

		const events = sim.drainEvents();
		expect(events.filter((e) => e.kind === 'hit')).toHaveLength(1);
		expect(events.filter((e) => e.kind === 'death')).toHaveLength(1);
		expect(events.filter((e) => e.kind === 'finish')).toHaveLength(1);
		expect(events.filter((e) => e.kind === 'match-end')).toHaveLength(1);

		const results = sim.results();
		expect(results.map((r) => r.player)).toEqual(['p1', 'p2']);
		expect(results[0].placement).toBe(1);
		expect(results[0].score).toBe(1 * 100 + 1 * 10 + 1 * 50 + 2 * 25);
		expect(results[1].stats).toEqual({ kills: 0, deaths: 1, damage: 0, level: 1, lives: 0 });
	});

	it('respawn invulnerability lets shells pass straight through', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 200, 24, 0);
		sim.tanks[1].invulnTimer = 1000;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 16; i++) sim.tickOnce(new Map());

		const victim = sim.tanks[1];
		expect(victim.lives).toBe(2);
		expect(victim.deaths).toBe(0);
		expect(sim.bullets).toHaveLength(1); // the shell flew through the shield
		expect(sim.bullets[0].x).toBeGreaterThan(200);

		// Same shot, shield down: it kills.
		victim.invulnTimer = 0;
		for (let i = 0; i < 40; i++) sim.tickOnce(new Map());
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 20 && victim.lives === 2; i++) sim.tickOnce(new Map());
		expect(victim.lives).toBe(1);
		expect(victim.deaths).toBe(1);
	});

	it('shells crack crates in two hits, then the tile goes clear', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		// Crossfire crate at tile (4, 2); x = 72 is a clear firing lane below it.
		const crateIndex = 2 * 30 + 4;
		expect(sim.crateHp[crateIndex]).toBe(2);
		place(sim, 'p1', 72, 100, -Math.PI / 2);
		place(sim, 'p2', 300, 24, 0);

		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 15; i++) sim.tickOnce(new Map());
		expect(sim.crateHp[crateIndex]).toBe(1);
		expect(sim.bullets).toHaveLength(0);
		expect(sim.drainEvents().filter((e) => e.kind === 'collect')).toHaveLength(0);

		for (let i = 0; i < 45; i++) sim.tickOnce(new Map()); // ride out the reload
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 15; i++) sim.tickOnce(new Map());
		expect(sim.crateHp[crateIndex]).toBe(0);
		expect(sim.bullets).toHaveLength(0);
		const events = sim.drainEvents();
		expect(events.filter((e) => e.kind === 'collect' && e.item === 'crate')).toHaveLength(1);
	});

	it('shells bounce off steel exactly once and die on the next impact', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 240, 40, -Math.PI / 2);
		place(sim, 'p2', 300, 24, 0);
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		sim.tanks[0].x = 252; // step aside so the returning shell misses

		let observed = 0;
		let vanishedAt = -1;
		let lifeWhenLastSeen = 0;
		for (let i = 1; i < 80; i++) {
			sim.tickOnce(new Map());
			if (sim.bullets.length > 0) {
				observed = Math.max(observed, sim.bullets[0].bounces);
				lifeWhenLastSeen = sim.bullets[0].life;
			} else if (vanishedAt < 0) {
				vanishedAt = i;
			}
		}
		expect(observed).toBe(1);
		expect(vanishedAt).toBeGreaterThan(0);
		expect(vanishedAt).toBeLessThan(70); // died on wall impact, not on expiry
		expect(lifeWhenLastSeen).toBeGreaterThan(0);
		expect(BULLET_LIFE).toBe(90);
	});

	it('level 5 shells survive two wall bounces', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 240, 40, -Math.PI / 2);
		place(sim, 'p2', 300, 24, 0);
		sim.tanks[0].xp = 280;
		sim.tanks[0].level = 5;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		sim.tanks[0].x = 252;

		let observed = 0;
		for (let i = 1; i < 88; i++) {
			sim.tickOnce(new Map());
			if (sim.bullets.length > 0) observed = Math.max(observed, sim.bullets[0].bounces);
		}
		expect(observed).toBe(2);
	});
});

describe('tank sim movement', () => {
	it('tanks stop at water and walls and never tunnel at full speed', () => {
		const config: GameConfig = {
			...CONFIG,
			options: { arenaId: 'islands', countdownTicks: 0 }
		};
		const sim = createTankSim(SEED, config, [P1, P2]);
		place(sim, 'p1', 140, 64, Math.PI); // facing west into the island pool
		place(sim, 'p2', 350, 24, 0);
		for (let i = 0; i < 200; i++) sim.tickOnce(inputMap({ p1: KEY.UP }));
		const t = sim.tanks[0];
		// Water at tile cols 2..6 (x up to 112) on this row: the 12px hull stops at 118.
		expect(t.x).toBeGreaterThanOrEqual(118 - 0.001);
		expect(t.x).toBeLessThan(140);

		// Now drive north into the border wall at top speed.
		place(sim, 'p1', 200, 100, -Math.PI / 2);
		for (let i = 0; i < 100; i++) sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(t.y).toBeGreaterThanOrEqual(16 + 6 - 0.001);
		expect(t.y).toBeLessThan(100);
	});

	it('tanks push each other apart and never overlap', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 110, 24, Math.PI);
		for (let i = 0; i < 120; i++) {
			sim.tickOnce(inputMap({ p1: KEY.UP, p2: KEY.UP }));
			const [a, b] = sim.tanks;
			const overlapX = 12 - Math.abs(a.x - b.x);
			const overlapY = 12 - Math.abs(a.y - b.y);
			expect(overlapX <= 0 || overlapY <= 0).toBe(true);
		}
	});

	it('disconnected players keep driving with their last input', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		place(sim, 'p1', 200, 140, -Math.PI / 2);
		place(sim, 'p2', 350, 24, 0);
		for (let i = 0; i < 20; i++) sim.tickOnce(inputMap({ p1: KEY.UP }));
		const y = sim.tanks[0].y;
		expect(y).toBeCloseTo(140 - 20 * 2.2, 5);
		for (let i = 0; i < 20; i++) sim.tickOnce(new Map()); // p1 drops off the stream
		expect(sim.tanks[0].y).toBeCloseTo(140 - 40 * 2.2, 5);
		expect(sim.tanks[0].moveDir).toBe(1);
	});
});

describe('tank sim progression', () => {
	it('levels come from xp thresholds and scale speed, reload and shells', () => {
		expect(levelForXp(0)).toBe(1);
		expect(levelForXp(39)).toBe(1);
		expect(levelForXp(40)).toBe(2);
		expect(levelForXp(100)).toBe(3);
		expect(levelForXp(180)).toBe(4);
		expect(levelForXp(280)).toBe(5);
		expect(reloadTicks(1)).toBe(45);
		expect(reloadTicks(5)).toBe(27);
		expect(speedScale(5)).toBeCloseTo(1.32, 5);
		expect(bulletSpeed(5)).toBeCloseTo(6 * 1.48, 5);
		expect(maxBounces(4)).toBe(1);
		expect(maxBounces(5)).toBe(2);

		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		sim.tanks[0].xp = 40;
		sim.tickOnce(new Map());
		expect(sim.tanks[0].level).toBe(2);
		sim.tanks[0].xp = 280;
		sim.tickOnce(new Map());
		expect(sim.tanks[0].level).toBe(5);
		expect(sim.drainEvents().filter((e) => e.kind === 'collect')).toHaveLength(2);

		// Level 5: faster drive (2.2 * 1.32), reload 27, shells at 6 * 1.48.
		place(sim, 'p1', 200, 24, 0);
		const before = sim.tanks[0].x;
		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(sim.tanks[0].x - before).toBeCloseTo(2.2 * 1.32, 5);
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		expect(sim.tanks[0].reloadTimer).toBe(27);
		expect(sim.bullets[sim.bullets.length - 1].vx).toBeCloseTo(6 * 1.48, 5);
	});

	it('holds fire behind the reload timer', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 240, 40, -Math.PI / 2);
		place(sim, 'p2', 350, 24, 0);
		sim.tanks[0].invulnTimer = 100000; // ignore own returning shells

		let fires = 0;
		let lastId = 0;
		for (let i = 0; i < 200; i++) {
			sim.tickOnce(inputMap({ p1: KEY.JUMP }));
			for (const b of sim.bullets) {
				if (b.id > lastId) {
					lastId = b.id;
					fires++;
				}
			}
		}
		expect(fires).toBe(5); // ticks 0, 45, 90, 135, 180
		expect(sim.tanks[0].reloadTimer).toBeGreaterThan(0);
	});
});

describe('tank sim match flow', () => {
	it('emits one spawn per player at construction', () => {
		const sim = createTankSim(SEED, CONFIG, PLAYERS);
		const events = sim.drainEvents();
		expect(events.map((e) => e.kind)).toEqual(['spawn', 'spawn', 'spawn']);
		expect(sim.results()).toHaveLength(3);
	});

	it('freezes everyone for the 3/2/1/GO countdown', () => {
		const config: GameConfig = {
			tickRate: 60,
			durationTicks: 600,
			options: { arenaId: 'crossfire' }
		};
		const sim = createTankSim(SEED, config, [P1, P2]);
		sim.drainEvents();
		const start = { x: sim.tanks[0].x, y: sim.tanks[0].y };
		const values: number[] = [];
		for (let i = 0; i < 121; i++) {
			sim.tickOnce(inputMap({ p1: KEY.UP | KEY.RIGHT }));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'countdown') values.push(ev.value);
			}
			if (i < 120) {
				expect(sim.tanks[0].x).toBe(start.x);
				expect(sim.tanks[0].y).toBe(start.y);
			}
		}
		expect(values).toEqual([3, 2, 1, 0]); // tick 120 emits GO and unfreezes
		expect(sim.tanks[0].x).toBeGreaterThan(start.x);
		expect(sim.tanks[0].y).toBeGreaterThan(start.y);
	});

	it('ranks survivors by lives, then kills, damage, xp and finally id', () => {
		const players = ['pa', 'pb', 'pc', 'pd', 'pe'].map((id, i): SimPlayer => ({
			id,
			name: id.toUpperCase(),
			color: '#ffffff',
			slot: i
		}));
		const sim = createTankSim(SEED, CONFIG, players);
		const byId = new Map(sim.tanks.map((t) => [t.id, t]));
		byId.get('pa')!.lives = 2;
		byId.get('pb')!.kills = 3;
		byId.get('pc')!.lives = 1;
		byId.get('pc')!.kills = 9;
		byId.get('pd')!.lives = 0;
		byId.get('pd')!.damage = 5;
		byId.get('pe')!.lives = 0;

		const results = sim.results();
		expect(results.map((r) => r.player)).toEqual(['pb', 'pa', 'pc', 'pd', 'pe']);
		expect(results.map((r) => r.placement)).toEqual([1, 2, 3, 4, 5]);
		expect(results[0].score).toBe(3 * 100 + 0 * 10 + 1 * 50 + 2 * 25);

		// Identical stats fall back to player id order.
		const tie = createTankSim(SEED, CONFIG, [P1, P2]);
		expect(tie.results().map((r) => r.player)).toEqual(['p1', 'p2']);
	});

	it('the clock ends the match and ticks after the end are ignored', () => {
		const config: GameConfig = {
			tickRate: 60,
			durationTicks: 200,
			options: { arenaId: 'crossfire', countdownTicks: 0 }
		};
		const sim = createTankSim(SEED, config, PLAYERS);
		sim.drainEvents();
		sim.tanks[0].damage = 7;
		sim.tanks[1].kills = 1;
		sim.tanks[2].lives = 1;

		for (let i = 0; i < 199; i++) sim.tickOnce(new Map());
		expect(sim.finished).toBe(false);
		sim.tickOnce(new Map());
		expect(sim.finished).toBe(true);
		expect(sim.tick).toBe(200);
		const events = sim.drainEvents();
		expect(events.filter((e) => e.kind === 'match-end')).toHaveLength(1);

		// p2 (lives 2 + kills) > p1 (lives 2 + damage) > p3 (lives 1).
		expect(sim.results().map((r) => r.player)).toEqual(['p2', 'p1', 'p3']);

		const endHash = sim.hash();
		sim.tickOnce(new Map());
		expect(sim.hash()).toBe(endHash);
		expect(sim.drainEvents()).toHaveLength(0);
	});
});

describe('tank sim power-ups', () => {
	const LONG: GameConfig = {
		tickRate: 60,
		durationTicks: 1600,
		options: { arenaId: 'crossfire', countdownTicks: 0 }
	};

	/** Drive straight into the crate at tile (4, 2) until it is destroyed. */
	function destroyFirstCrate(sim: TankSim): void {
		place(sim, 'p1', 72, 100, -Math.PI / 2);
		place(sim, 'p2', 300, 24, 0);
		sim.tanks[0].invulnTimer = 10000; // own returning shells must not kill
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 15; i++) sim.tickOnce(new Map());
		sim.tanks[0].reloadTimer = 0;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 15; i++) sim.tickOnce(new Map());
		expect(sim.crateHp[2 * 30 + 4]).toBe(0);
	}

	it('same seed spawns the identical power-up sequence (seeded rng only)', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 1200 };
		const a = createTankSim(SEED, config, PLAYERS);
		const b = createTankSim(SEED, config, PLAYERS);
		const stream = makeStream(config.durationTicks);
		const spawnsA: string[] = [];
		for (const frame of stream) {
			a.tickOnce(frame);
			b.tickOnce(frame);
			expect(a.hash()).toBe(b.hash());
			expect(a.powerups).toEqual(b.powerups);
			for (const p of a.powerups) {
				const key = `${p.id}:${p.kind}@${p.x},${p.y},${p.born}`;
				if (!spawnsA.includes(key)) spawnsA.push(key);
			}
		}
		// The stream is long enough to exercise the cadence and crate drops.
		expect(spawnsA.length).toBeGreaterThanOrEqual(2);
	});

	it('spawns one every 300 ticks on free floor tiles, capped at 4 alive', () => {
		const sim = createTankSim(SEED, LONG, [P1, P2]);
		sim.drainEvents();
		for (let i = 0; i < POWERUP_SPAWN_INTERVAL; i++) sim.tickOnce(new Map());
		expect(sim.powerups).toHaveLength(0); // nothing before tick 300 completes
		sim.tickOnce(new Map());
		expect(sim.powerups).toHaveLength(1);

		const first = sim.powerups[0];
		expect(POWERUP_KINDS as readonly string[]).toContain(first.kind);
		expect(first.born).toBe(POWERUP_SPAWN_INTERVAL);
		// Free floor tile — never inside walls/water/crates/tanks/bullets.
		expect(tileAtPx(sim.arena, first.x, first.y)).toBe('floor');
		for (const t of sim.tanks) {
			expect(Math.hypot(t.x - first.x, t.y - first.y)).toBeGreaterThan(24 - 0.001);
		}

		for (let i = 0; i < POWERUP_SPAWN_INTERVAL * 4; i++) sim.tickOnce(new Map());
		expect(sim.powerups).toHaveLength(POWERUP_MAX_ALIVE);
		expect(sim.powerups.map((p) => p.born)).toEqual([300, 600, 900, 1200]);
		// The 1500 spawn is skipped while the map is at the cap.
		expect(sim.powerups).toHaveLength(POWERUP_MAX_ALIVE);
	});

	it.each(['shield', 'triple', 'rapid', 'speed'] as const)(
		'collecting %s after its 1s grace applies the effect and emits collect',
		(kind: PowerupKind) => {
			const sim = createTankSim(SEED, LONG, [P1, P2]);
			sim.drainEvents();
			for (let i = 0; i <= POWERUP_SPAWN_INTERVAL; i++) sim.tickOnce(new Map());
			expect(sim.powerups).toHaveLength(1);
			const pickup = sim.powerups[0] as PowerupState;
			pickup.kind = kind; // deterministic override so every kind is covered

			// Park p2 on the pickup: the grace must hold it safe first.
			const t2 = sim.tanks[1];
			t2.x = pickup.x;
			t2.y = pickup.y;
			for (let i = 0; i < POWERUP_GRACE_TICKS - 1; i++) sim.tickOnce(new Map());
			expect(sim.powerups).toHaveLength(1); // visible < 1s: untouchable
			expect(sim.drainEvents().filter((e) => e.kind === 'collect')).toHaveLength(0);

			sim.tickOnce(new Map()); // exactly 1s old now: grabbable
			expect(sim.powerups).toHaveLength(0);
			const events = sim.drainEvents();
			expect(
				events.filter((e) => e.kind === 'collect' && e.item === `powerup:${kind}`)
			).toHaveLength(1);
			expect(t2.shield).toBe(kind === 'shield' ? 1 : 0);
			expect(t2.triple).toBe(kind === 'triple' ? TRIPLE_SHOTS : 0);
			expect(t2.rapidTimer).toBe(kind === 'rapid' ? EFFECT_TICKS : 0);
			expect(t2.speedTimer).toBe(kind === 'speed' ? EFFECT_TICKS : 0);
		}
	);

	it('shield absorbs exactly one shell (hit force 0, no life lost) and is gone', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 200, 24, 0);
		sim.tanks[1].shield = 1;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 30 && sim.tanks[1].shield > 0; i++) sim.tickOnce(new Map());

		expect(sim.tanks[1].shield).toBe(0);
		expect(sim.tanks[1].lives).toBe(2);
		expect(sim.tanks[1].deaths).toBe(0);
		expect(sim.tanks[1].alive).toBe(true);
		const events = sim.drainEvents();
		const hits = events.filter((e) => e.kind === 'hit');
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ player: 'p2', by: 'p1', force: 0 });
		expect(events.filter((e) => e.kind === 'death')).toHaveLength(0);

		// Second shell: the bubble is spent, this one kills.
		sim.tanks[0].reloadTimer = 0;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 30 && sim.tanks[1].lives === 2; i++) sim.tickOnce(new Map());
		expect(sim.tanks[1].lives).toBe(1);
		const second = sim.drainEvents();
		expect(second.filter((e) => e.kind === 'hit' && e.force === 1)).toHaveLength(1);
		expect(second.filter((e) => e.kind === 'death')).toHaveLength(1);
	});

	it('triple fires a 3-way spread for exactly 5 shots, then single shells', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		// Row-1 lane (y=28): clear floor, and the spread misses the top wall.
		place(sim, 'p1', 100, 28, 0);
		place(sim, 'p2', 350, 28, 0);
		sim.tanks[0].triple = TRIPLE_SHOTS;

		const volleys: number[] = [];
		for (let shot = 0; shot < 6; shot++) {
			sim.tanks[0].reloadTimer = 0;
			const before = sim.bullets.length;
			sim.tickOnce(inputMap({ p1: KEY.JUMP }));
			volleys.push(sim.bullets.length - before);
		}
		expect(volleys).toEqual([3, 3, 3, 3, 3, 1]);
		expect(sim.tanks[0].triple).toBe(0);
		expect(sim.tanks[0].reloadTimer).toBe(reloadTicks(1));

		// The spread fans out symmetrically around the hull angle.
		const [left, straight, right] = sim.bullets;
		expect(left.vy).toBeLessThan(0);
		expect(straight.vy).toBe(0);
		expect(right.vy).toBeGreaterThan(0);
		expect(straight.vx).toBeCloseTo(bulletSpeed(1), 10);
	});

	it('rapid divides the reload by three for 8s, then lapses (no expiry events)', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		// Row-1 lane (y=28): open floor all the way to the border wall.
		place(sim, 'p1', 100, 28, 0);
		place(sim, 'p2', 350, 28, 0);
		sim.tanks[0].invulnTimer = 100000; // own returning shells must not kill
		sim.tanks[1].invulnTimer = 100000; // shells pass through: match must run on
		sim.tanks[0].rapidTimer = EFFECT_TICKS;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		expect(sim.tanks[0].reloadTimer).toBe(rapidReloadTicks(1)); // 45 / 3 = 15

		for (let i = 0; i < 14; i++) sim.tickOnce(inputMap({ p1: 0 }));
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		expect(sim.bullets.length).toBe(2); // second shot only 15 ticks later

		sim.tanks[0].reloadTimer = 0;
		for (let i = 0; i < EFFECT_TICKS - 20; i++) sim.tickOnce(inputMap({ p1: 0 }));
		expect(sim.tanks[0].rapidTimer).toBeGreaterThan(0);
		for (let i = 0; i < 20; i++) sim.tickOnce(inputMap({ p1: 0 }));
		expect(sim.tanks[0].rapidTimer).toBe(0);
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		expect(sim.tanks[0].reloadTimer).toBe(reloadTicks(1)); // back to 45
		expect(sim.drainEvents().filter((e) => e.kind === 'collect')).toHaveLength(0);
	});

	it('speed adds 40% drive for 8s, then lapses', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 200, 100, 0);
		place(sim, 'p2', 350, 24, 0);
		sim.tanks[0].speedTimer = EFFECT_TICKS;

		const start = sim.tanks[0].x;
		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(sim.tanks[0].x - start).toBeCloseTo(2.2 * SPEED_MULTIPLIER, 5);
		expect(sim.tanks[0].speedTimer).toBe(EFFECT_TICKS - 1);

		// Explicit idle input (an empty map would keep the last keys driving).
		for (let i = 0; i < EFFECT_TICKS; i++) sim.tickOnce(inputMap({ p1: 0 }));
		expect(sim.tanks[0].speedTimer).toBe(0);
		const before = sim.tanks[0].x;
		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(sim.tanks[0].x - before).toBeCloseTo(2.2, 5);
	});

	it('destroyed crates drop power-ups ~half the time (seeded, replay-stable)', () => {
		const dropCount = (): number => {
			let drops = 0;
			for (let seedIndex = 0; seedIndex < 30; seedIndex++) {
				const sim = createTankSim(SEED + seedIndex * 101, CONFIG, [P1, P2]);
				sim.drainEvents();
				destroyFirstCrate(sim);
				expect(
					sim.drainEvents().filter((e) => e.kind === 'collect' && e.item === 'crate')
				).toHaveLength(1);
				if (sim.powerups.length > 0) {
					drops++;
					const drop = sim.powerups[0];
					expect(POWERUP_KINDS as readonly string[]).toContain(drop.kind);
					expect(Math.abs(drop.x - (4 * 16 + 8))).toBeLessThan(0.001); // crate tile
				}
			}
			return drops;
		};
		const drops = dropCount();
		expect(drops).toBeGreaterThanOrEqual(8);
		expect(drops).toBeLessThanOrEqual(22);
		expect(dropCount()).toBe(drops); // identical on replay
	});

	it('effects and map power-ups ride snapshot/restore/hash; restore erases divergence', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 1200 };
		const a = createTankSim(SEED, config, PLAYERS);
		for (let i = 0; i <= POWERUP_SPAWN_INTERVAL; i++) a.tickOnce(new Map());
		expect(a.powerups.length).toBeGreaterThan(0);
		a.tanks[0].shield = 1;
		a.tanks[0].triple = 3;
		a.tanks[0].rapidTimer = 200;
		a.tanks[0].speedTimer = 100;
		const snap = a.snapshot();
		const hashAtSnap = a.hash();

		const b = createTankSim(SEED + 7, config, PLAYERS); // different seed scatter
		b.restore(snap);
		expect(b.hash()).toBe(hashAtSnap);
		expect(b.powerups).toEqual(a.powerups);
		expect(b.tanks[0]).toMatchObject({ shield: 1, triple: 3, rapidTimer: 200, speedTimer: 100 });

		// Diverge b's effects and pickups: the hash must notice...
		b.tanks[0].shield = 0;
		b.tanks[0].rapidTimer = 0;
		b.powerups[0].born += 1;
		expect(b.hash()).not.toBe(hashAtSnap);
		// ...and a restore erases every trace of the divergence.
		b.restore(snap);
		expect(b.hash()).toBe(hashAtSnap);
		expect(b.powerups).toEqual(a.powerups);
		expect(b.tanks[0]).toMatchObject({ shield: 1, triple: 3, rapidTimer: 200, speedTimer: 100 });
	});

	it('dying drops every transient effect (the wreck keeps nothing)', () => {
		const sim = createTankSim(SEED, CONFIG, [P1, P2]);
		sim.drainEvents();
		place(sim, 'p1', 100, 24, 0);
		place(sim, 'p2', 200, 24, 0);
		const victim = sim.tanks[1];
		victim.shield = 1;
		victim.triple = 2;
		victim.rapidTimer = 100;
		victim.speedTimer = 100;

		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 30 && victim.shield > 0; i++) sim.tickOnce(new Map());
		expect(victim.shield).toBe(0); // absorbed: alive, effects intact
		expect(victim.alive).toBe(true);
		expect(victim.triple).toBe(2);

		sim.tanks[0].reloadTimer = 0;
		sim.tickOnce(inputMap({ p1: KEY.JUMP }));
		for (let i = 0; i < 30 && victim.alive; i++) sim.tickOnce(new Map());
		expect(victim.alive).toBe(false);
		expect(victim.triple).toBe(0);
		expect(victim.rapidTimer).toBe(0);
		expect(victim.speedTimer).toBe(0);
		expect(victim.shield).toBe(0);
	});
});
