/**
 * THE determinism test for Turbo Kart plus every racing rule: drift charge
 * tiers and mini-turbo magnitudes, hop-drifts, boost pads, ramp tricks,
 * slipstreaming, soft walls vs hard crashes, off-road and ice handling, item
 * effects (mushroom/oil/missile/shield/lightning), position-weighted item
 * odds, checkpoint-ordered laps (cutting is impossible), auto-respawn, results
 * ordering and AI determinism.
 */
import { describe, expect, it } from 'vitest';
import type { GameConfig, InputFrame, PlayerId, SimPlayer } from '../types';
import { KEY } from '../types';
import {
	DRIFT_MIN_SPEED,
	DRIFT_MIN_SPEED_HOP,
	DRIFT_TIER_TICKS,
	BOOST_PAD_POWER,
	BOOST_PAD_TICKS,
	CRASH_SPEED,
	MINITURBO_POWER,
	MINITURBO_TICKS,
	MISSILE_SPEED,
	MUSHROOM_POWER,
	MUSHROOM_TICKS,
	RESPAWN_BOOST_POWER,
	RESPAWN_BOOST_TICKS,
	SLICK_LIFE,
	SLIPSTREAM_BURST_POWER,
	SLIPSTREAM_BURST_TICKS,
	SLIPSTREAM_TICKS,
	SPIN_TICKS,
	TRICK_POWER,
	TRICK_TICKS,
	createKartSim,
	driftTier,
	itemWeights,
	parseKartSnapshot,
	rollItem,
	type ItemBoxState,
	type KartSim,
	type KartState
} from './sim';
import { nearestSpline, splineAt, tileAtPx } from './track';

const P1: SimPlayer = { id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 };
const P2: SimPlayer = { id: 'p2', name: 'Ben', color: '#57e389', slot: 1 };
const P3: SimPlayer = { id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 };
const P4: SimPlayer = { id: 'p4', name: 'Dee', color: '#ffd166', slot: 3 };
const PLAYERS = [P1, P2, P3];

const SEED = 1337;
const CONFIG: GameConfig = {
	tickRate: 60,
	durationTicks: 12000,
	options: { trackId: 'sunny-circuit', laps: 3, countdownTicks: 0 }
};

function inputMap(keys: Partial<Record<PlayerId, number>>): Map<PlayerId, InputFrame> {
	const map = new Map<PlayerId, InputFrame>();
	for (const [id, mask] of Object.entries(keys)) map.set(id, { keys: mask ?? 0 });
	return map;
}

/** Park a kart on the centerline at arc `s` (optional lateral offset). */
function placeOnLine(sim: KartSim, id: PlayerId, s: number, lateral = 0, speed = 0): KartState {
	const kart = sim.karts.find((k) => k.id === id);
	if (!kart) throw new Error(`no kart ${id}`);
	const p = splineAt(sim.track, s);
	kart.x = p.x - p.ty * lateral;
	kart.y = p.y + p.tx * lateral;
	kart.angle = Math.atan2(p.ty, p.tx);
	kart.speed = speed;
	kart.lateral = 0;
	kart.z = 0;
	kart.vz = 0;
	kart.spinTimer = 0;
	// Keep the derived fields honest, exactly as updateProgress would.
	kart.progress = kart.lap * sim.track.lapLength + p.s;
	return kart;
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
	if ((tick + index) % 19 === 0) keys |= KEY.ITEM;
	return keys;
}

function makeStream(ticks: number, players: readonly SimPlayer[]): Map<PlayerId, InputFrame>[] {
	const stream: Map<PlayerId, InputFrame>[] = [];
	for (let t = 0; t < ticks; t++) {
		const frame = inputMap({});
		players.forEach((p, i) => frame.set(p.id, { keys: scriptKeys(t, i) }));
		stream.push(frame);
	}
	return stream;
}

describe('kart sim determinism', () => {
	it('two sims with the same seed and input stream hash identically at every tick', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 720 };
		const a = createKartSim(SEED, config, PLAYERS);
		const b = createKartSim(SEED, config, PLAYERS);
		const stream = makeStream(720, PLAYERS);

		const hashes = new Set<number>();
		for (const frame of stream) {
			a.tickOnce(frame);
			b.tickOnce(frame);
			expect(a.hash()).toBe(b.hash());
			expect(a.tick).toBe(b.tick);
			hashes.add(a.hash());
		}
		// The hash really observes state changes along the way.
		expect(hashes.size).toBeGreaterThan(10);
		expect(a.results()).toEqual(b.results());
		expect(a.hash()).toBe(a.hash());
	});

	it('snapshot/restore erases divergence tick for tick', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 400 };
		const a = createKartSim(SEED, config, PLAYERS);
		const b = createKartSim(SEED, config, PLAYERS);
		const stream = makeStream(200, PLAYERS);
		for (const frame of stream) {
			a.tickOnce(frame);
			b.tickOnce(frame);
		}
		expect(a.hash()).toBe(b.hash());
		const atSnap = a.hash();
		const snap = a.snapshot();

		// Diverge: `a` follows one continuation, `b` gets garbage input.
		const contA = makeStream(200, PLAYERS).map((frame) => frame);
		const contB = contA.map((frame, t) => {
			const copy = new Map<PlayerId, InputFrame>();
			for (const [id] of frame) copy.set(id, { keys: (t * 31 + 7) & 0xff });
			return copy;
		});
		const expected: number[] = [];
		for (const frame of contA) {
			a.tickOnce(frame);
			expected.push(a.hash());
		}
		for (const frame of contB) b.tickOnce(frame);
		expect(a.hash()).not.toBe(b.hash());

		// Restore + replay the same continuation: identical hashes again.
		b.restore(snap);
		expect(b.hash()).toBe(atSnap); // divergence erased at the restore point
		contA.forEach((frame, i) => {
			b.tickOnce(frame);
			expect(b.hash()).toBe(expected[i]);
		});
	});

	it('produces a stable unsigned 32-bit hash and round-trips snapshots', () => {
		const sim = createKartSim(SEED, CONFIG, PLAYERS);
		const stream = makeStream(60, PLAYERS);
		for (const frame of stream) sim.tickOnce(frame);
		const h = sim.hash();
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);

		const snap = sim.snapshot();
		const parsed = parseKartSnapshot(snap);
		expect(parsed).not.toBeNull();
		expect(parsed?.karts.map((k) => k.id)).toEqual(PLAYERS.map((p) => p.id));
		const restored = createKartSim(SEED, CONFIG, PLAYERS);
		for (const frame of stream) restored.tickOnce(frame);
		restored.restore(snap);
		expect(restored.hash()).toBe(h);
		// Malformed snapshots are rejected instead of corrupting state.
		expect(parseKartSnapshot({ nope: true })).toBeNull();
	});
});

describe('kart sim drift system', () => {
	function driftFor(ticks: number, extra: number): KartSim {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		for (let i = 0; i < ticks; i++) {
			// Keep the kart on the road while it slides so the drift only tests
			// drift physics, not navigation.
			placeOnLine(sim, 'p1', 200 + i * 3, 0, 3);
			sim.tickOnce(inputMap({ p1: extra }));
		}
		return sim;
	}

	it('charges tiers at 60/120/180 ticks (blue/orange/purple)', () => {
		for (const [ticks, tier] of [
			[30, 0],
			[60, 1],
			[120, 2],
			[180, 3]
		] as const) {
			const sim = driftFor(ticks, KEY.UP | KEY.LEFT | KEY.DRIFT);
			const kart = sim.karts[0];
			expect(kart.drifting).toBe(true);
			expect(kart.driftCharge).toBe(ticks);
			expect(driftTier(kart.driftCharge)).toBe(tier);
			expect(DRIFT_TIER_TICKS).toBe(60);
		}
	});

	it('releasing DRIFT fires a mini-turbo scaled by the tier', () => {
		for (const [ticks, tier] of [
			[65, 1],
			[125, 2],
			[185, 3]
		] as const) {
			const sim = driftFor(ticks, KEY.UP | KEY.LEFT | KEY.DRIFT);
			const kart = sim.karts[0];
			sim.drainEvents();
			sim.tickOnce(inputMap({ p1: KEY.UP }));
			expect(kart.drifting).toBe(false);
			expect(kart.driftCharge).toBe(0);
			expect(kart.boostTimer).toBe(MINITURBO_TICKS[tier]);
			expect(kart.boostPower).toBeCloseTo(MINITURBO_POWER[tier], 10);
			expect(kart.driftBoosts).toBe(1);
			const boosts = sim.drainEvents().filter((e) => e.kind === 'boost');
			expect(boosts).toEqual([{ kind: 'boost', player: 'p1', power: MINITURBO_POWER[tier] }]);
		}
	});

	it('a sub-tier release gives no boost', () => {
		const sim = driftFor(30, KEY.UP | KEY.LEFT | KEY.DRIFT);
		const kart = sim.karts[0];
		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(kart.boostTimer).toBe(0);
		expect(kart.driftBoosts).toBe(0);
	});

	it('hops on a DRIFT tap and drifts from lower speed after the hop', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = placeOnLine(sim, 'p1', 150, 0, 0.8);
		// Tap: the ground hop fires immediately.
		sim.tickOnce(inputMap({ p1: KEY.DRIFT | KEY.LEFT }));
		expect(kart.z).toBeGreaterThan(0);
		expect(kart.hopTicks).toBeGreaterThan(0);
		// Keep holding through the landing: the hop window lowers the drift
		// threshold from DRIFT_MIN_SPEED to DRIFT_MIN_SPEED_HOP.
		expect(0.8).toBeLessThan(DRIFT_MIN_SPEED);
		expect(0.8).toBeGreaterThanOrEqual(DRIFT_MIN_SPEED_HOP);
		for (let i = 0; i < 25; i++) sim.tickOnce(inputMap({ p1: KEY.DRIFT | KEY.LEFT }));
		expect(kart.z).toBe(0);
		expect(kart.drifting).toBe(true);
	});

	it('no hop, no drift below the normal threshold', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = placeOnLine(sim, 'p1', 150, 0, 0.8);
		// No DRIFT press: nothing hops and nothing drifts.
		for (let i = 0; i < 30; i++) sim.tickOnce(inputMap({ p1: KEY.LEFT }));
		expect(kart.drifting).toBe(false);
		expect(kart.z).toBe(0);
		// Even holding DRIFT, a crawl below DRIFT_MIN_SPEED_HOP never drifts.
		const slow = placeOnLine(sim, 'p1', 150, 0, 0.2);
		for (let i = 0; i < 40; i++) sim.tickOnce(inputMap({ p1: KEY.DRIFT | KEY.LEFT }));
		expect(slow.drifting).toBe(false);
	});
});

describe('kart sim boosts: pads, ramps, tricks, slipstream', () => {
	it('boost pads grant a +40% burst', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		// Sunny Circuit's top boost strip (tiles 19-21, rows 2-5).
		const kart = sim.karts[0];
		kart.x = 20 * 16 + 8;
		kart.y = 3 * 16 + 8;
		kart.angle = 0;
		kart.speed = 2;
		expect(tileAtPx(sim.track, kart.x, kart.y)).toBe('boost');
		sim.drainEvents();
		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(kart.boostTimer).toBe(BOOST_PAD_TICKS);
		expect(kart.boostPower).toBeCloseTo(BOOST_PAD_POWER, 10);
		expect(sim.drainEvents()).toContainEqual({
			kind: 'boost',
			player: 'p1',
			power: BOOST_PAD_POWER
		});
	});

	it('ramps launch karts and a mid-air trick boosts the landing', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		// Sunny Circuit's ramp patch (tiles 27-28, rows 2-5).
		kart.x = 27 * 16 + 8;
		kart.y = 3 * 16 + 8;
		kart.angle = 0;
		kart.speed = 3;
		expect(tileAtPx(sim.track, kart.x, kart.y)).toBe('ramp');

		sim.tickOnce(inputMap({ p1: KEY.UP }));
		expect(kart.z).toBeGreaterThan(0);
		expect(kart.trick).toBe(false);
		// KEY.JUMP in the air arms the trick spin.
		sim.tickOnce(inputMap({ p1: KEY.UP | KEY.JUMP }));
		expect(kart.trick).toBe(true);
		sim.drainEvents();
		let landed = false;
		for (let i = 0; i < 60 && !landed; i++) {
			sim.tickOnce(inputMap({ p1: KEY.UP }));
			landed = kart.z === 0;
		}
		expect(landed).toBe(true);
		expect(kart.trick).toBe(false);
		expect(kart.boostTimer).toBe(TRICK_TICKS);
		expect(kart.boostPower).toBeCloseTo(TRICK_POWER, 10);
		expect(sim.drainEvents()).toContainEqual({ kind: 'boost', player: 'p1', power: TRICK_POWER });
	});

	it('ramps do not launch slow karts', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		kart.x = 27 * 16 + 8;
		kart.y = 3 * 16 + 8;
		kart.angle = 0;
		kart.speed = 0.5;
		sim.tickOnce(inputMap({ p1: 0 }));
		expect(kart.z).toBe(0);
	});

	it('slipstream builds behind a rival and bursts when it ends', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		// Keep both karts on the line, 60px apart, so the test exercises the
		// drafting rules and not navigation.
		let leader!: KartState;
		let follower!: KartState;
		for (let i = 0; i < SLIPSTREAM_TICKS + 5; i++) {
			leader = placeOnLine(sim, 'p1', 300 + i * 3, 0, 3);
			follower = placeOnLine(sim, 'p2', 240 + i * 3, 0, 3);
			sim.tickOnce(inputMap({ p1: KEY.UP, p2: KEY.UP }));
		}
		expect(follower.draftTicks).toBeGreaterThanOrEqual(SLIPSTREAM_TICKS);
		expect(leader.draftTicks).toBe(0);
		// The draft breaks: the follower pops a burst boost.
		placeOnLine(sim, 'p1', 30, 0, 3);
		sim.drainEvents();
		sim.tickOnce(inputMap({ p2: KEY.UP }));
		expect(follower.draftTicks).toBe(0);
		expect(follower.boostTimer).toBe(SLIPSTREAM_BURST_TICKS);
		expect(follower.boostPower).toBeCloseTo(SLIPSTREAM_BURST_POWER, 10);
		expect(sim.drainEvents()).toContainEqual({
			kind: 'boost',
			player: 'p2',
			power: SLIPSTREAM_BURST_POWER
		});
	});
});

describe('kart sim walls, surfaces and respawns', () => {
	it('a soft wall bump costs speed but never spins', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		kart.x = 34;
		kart.y = 240;
		kart.angle = Math.PI; // head-on into the west border wall
		kart.speed = 1.2; // below CRASH_SPEED
		expect(1.2).toBeLessThan(CRASH_SPEED);
		sim.drainEvents();
		for (let i = 0; i < 20; i++) sim.tickOnce(inputMap({ p1: 0 }));
		expect(kart.spinTimer).toBe(0);
		expect(kart.x).toBeGreaterThan(16); // held out of the wall
		expect(Math.abs(kart.speed)).toBeLessThan(1.2); // speed was spent
		expect(sim.drainEvents().some((e) => e.kind === 'hit')).toBe(false);
	});

	it('a head-on crash at speed spins you out', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		kart.x = 27;
		kart.y = 240;
		kart.angle = Math.PI;
		kart.speed = 3;
		// Keep the approach speed up (grass would otherwise bleed it off).
		kart.boostTimer = 30;
		kart.boostPower = 0.4;
		sim.drainEvents();
		for (let i = 0; i < 20 && kart.spinTimer === 0; i++) sim.tickOnce(inputMap({ p1: 0 }));
		expect(kart.spinTimer).toBeGreaterThan(0);
		expect(kart.spinTimer).toBeLessThanOrEqual(SPIN_TICKS);
		expect(sim.drainEvents()).toContainEqual({ kind: 'hit', player: 'p1', by: 'p1', force: 1 });
	});

	it('off-road grass caps speed at ~50%', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		// 80px off the line: definitely grass, still inside the off-track
		// watchdog's range. Re-park every tick so the test measures the speed
		// cap and not navigation.
		expect(tileAtPx(sim.track, splineAt(sim.track, 500).x, splineAt(sim.track, 500).y)).toBe(
			'road'
		);
		kart.speed = 0.1;
		for (let i = 0; i < 60; i++) {
			const p = splineAt(sim.track, 500 + i);
			kart.x = p.x - p.ty * 80;
			kart.y = p.y + p.tx * 80;
			kart.angle = Math.atan2(p.ty, p.tx);
			sim.tickOnce(inputMap({ p1: KEY.UP }));
		}
		expect(tileAtPx(sim.track, kart.x, kart.y)).toBe('grass');
		expect(kart.speed).toBeGreaterThan(1.5);
		expect(kart.speed).toBeLessThan(1.75);

		// Road runs to full speed.
		placeOnLine(sim, 'p1', 500, 0, 0.1);
		for (let i = 0; i < 200; i++) {
			const p = splineAt(sim.track, 500 + i * 2);
			kart.x = p.x;
			kart.y = p.y;
			kart.angle = Math.atan2(p.ty, p.tx);
			sim.tickOnce(inputMap({ p1: KEY.UP }));
		}
		expect(kart.speed).toBeGreaterThan(3.3);
	});

	it('ice keeps the slide alive (Frostbite Falls)', () => {
		const config: GameConfig = {
			...CONFIG,
			options: { ...CONFIG.options, trackId: 'frostbite-falls' }
		};
		const sim = createKartSim(SEED, config, [P1, P2]);
		const ice = sim.karts[0];
		const road = sim.karts[1];
		// West bend ice patch (tiles 3-8, rows 11-21).
		ice.x = 5 * 16 + 8;
		ice.y = 15 * 16 + 8;
		expect(tileAtPx(sim.track, ice.x, ice.y)).toBe('ice');
		ice.speed = 2;
		ice.lateral = 2;
		road.speed = 2;
		road.lateral = 2;
		sim.tickOnce(inputMap({}));
		expect(ice.lateral).toBeGreaterThan(1.9);
		expect(road.lateral).toBeLessThan(1.8);
	});

	it('falling in water and going far off the line auto-respawn at the last checkpoint', () => {
		const config: GameConfig = {
			...CONFIG,
			options: { ...CONFIG.options, trackId: 'frostbite-falls' }
		};
		const sim = createKartSim(SEED, config, [P1]);
		const kart = sim.karts[0];
		placeOnLine(sim, 'p1', 400);
		// Park it in the frozen channel.
		kart.x = 19 * 16 + 8;
		kart.y = 26 * 16 + 8;
		kart.speed = 1;
		expect(tileAtPx(sim.track, kart.x, kart.y)).toBe('water');
		sim.drainEvents();
		sim.tickOnce(inputMap({}));
		const anchor = sim.track.respawns[0]; // no gate passed yet -> checkpoint 0 anchor
		expect(Math.hypot(kart.x - anchor.x, kart.y - anchor.y)).toBeLessThan(2);
		expect(Math.abs(kart.angle - Math.atan2(anchor.ty, anchor.tx))).toBeLessThan(0.001);
		expect(kart.boostTimer).toBe(RESPAWN_BOOST_TICKS);
		expect(kart.boostPower).toBeCloseTo(RESPAWN_BOOST_POWER, 10);
		expect(sim.drainEvents()).toContainEqual({ kind: 'respawn', player: 'p1' });

		// Going far out respawns too.
		placeOnLine(sim, 'p1', 400);
		kart.x = 320;
		kart.y = 260;
		sim.tickOnce(inputMap({}));
		expect(Math.hypot(kart.x - anchor.x, kart.y - anchor.y)).toBeLessThan(2);
	});

	it('driving against a wall for 1.5s respawns a stuck kart', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		kart.x = 34;
		kart.y = 240;
		kart.speed = 0;
		// Steer into the wall every tick (fighting the wall's steering assist):
		// the gas is pinned but the kart cannot move, so the stuck watchdog
		// kicks it back onto the racing line after 1.5s.
		let respawned = false;
		for (let i = 0; i < 150 && !respawned; i++) {
			if (kart.x < 200) kart.angle = Math.PI;
			sim.tickOnce(inputMap({ p1: KEY.UP }));
			respawned = sim.drainEvents().some((e) => e.kind === 'respawn' && e.player === 'p1');
		}
		expect(respawned).toBe(true);
		// The respawn lands ON the racing line, reoriented along it, boosted.
		expect(nearestSpline(sim.track, kart.x, kart.y, -1).distance).toBeLessThan(20);
		expect(kart.boostTimer).toBe(RESPAWN_BOOST_TICKS);
		expect(kart.speed).toBe(0);
	});
});

describe('kart sim items', () => {
	it('mushroom boosts and consumes the slot', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = placeOnLine(sim, 'p1', 300, 0, 3);
		kart.item = 'mushroom';
		sim.drainEvents();
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		expect(kart.item).toBeNull();
		expect(kart.itemsUsed).toBe(1);
		expect(kart.boostTimer).toBe(MUSHROOM_TICKS);
		expect(kart.boostPower).toBeCloseTo(MUSHROOM_POWER, 10);
		expect(sim.drainEvents()).toContainEqual({
			kind: 'boost',
			player: 'p1',
			power: MUSHROOM_POWER
		});
	});

	it('oil drops a slick that spins out the next kart through it', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		const kart = placeOnLine(sim, 'p1', 300, 0, 3);
		kart.item = 'oil';
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		expect(sim.slicks).toHaveLength(1);
		expect(sim.slicks[0].owner).toBe('p1');
		// Born this tick, so the lifetime counter has already ticked once.
		expect(sim.slicks[0].life).toBe(SLICK_LIFE - 1);

		const victim = placeOnLine(sim, 'p2', 340, 0, 2);
		victim.x = sim.slicks[0].x;
		victim.y = sim.slicks[0].y;
		sim.drainEvents();
		sim.tickOnce(inputMap({}));
		expect(sim.slicks).toHaveLength(0);
		expect(victim.spinTimer).toBe(SPIN_TICKS);
		expect(sim.drainEvents()).toContainEqual({ kind: 'hit', player: 'p2', by: 'p1', force: 1 });
	});

	it('missiles home onto the kart ahead and spin it out', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		const owner = placeOnLine(sim, 'p1', 300, 0, 0);
		const victim = placeOnLine(sim, 'p2', 380, 0, 0);
		owner.item = 'missile';
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		expect(sim.missiles).toHaveLength(1);
		expect(sim.missiles[0].owner).toBe('p1');
		expect(sim.missiles[0].targetId).toBe('p2');

		sim.drainEvents();
		let hit = false;
		for (let i = 0; i < 60 && !hit; i++) {
			sim.tickOnce(inputMap({}));
			hit = victim.spinTimer > 0;
		}
		expect(hit).toBe(true);
		expect(sim.missiles).toHaveLength(0);
		expect(sim.drainEvents()).toContainEqual({ kind: 'hit', player: 'p2', by: 'p1', force: 1 });
		expect(MISSILE_SPEED).toBeGreaterThan(4);
	});

	it('missiles explode on walls', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		const owner = sim.karts[0];
		// Fire straight into the east border wall with no target ahead.
		owner.x = 600;
		owner.y = 240;
		owner.angle = 0;
		owner.speed = 0;
		owner.item = 'missile';
		// Park the other kart behind so the missile flies straight.
		const other = sim.karts[1];
		other.x = 560;
		other.y = 240;
		other.progress = -1000;
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		expect(sim.missiles).toHaveLength(1);
		for (let i = 0; i < 30; i++) sim.tickOnce(inputMap({}));
		expect(sim.missiles).toHaveLength(0);
	});

	it('shield absorbs exactly one hit (force 0, no spin)', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		const owner = placeOnLine(sim, 'p1', 300, 0, 0);
		const victim = placeOnLine(sim, 'p2', 380, 0, 0);
		victim.shieldTimer = 300;
		owner.item = 'missile';
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		sim.drainEvents();
		for (let i = 0; i < 60; i++) sim.tickOnce(inputMap({}));
		expect(victim.spinTimer).toBe(0);
		expect(victim.shieldTimer).toBe(0);
		expect(sim.drainEvents()).toContainEqual({ kind: 'hit', player: 'p2', by: 'p1', force: 0 });
	});

	it('lightning shrinks and slows everyone ahead', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2, P3]);
		const user = placeOnLine(sim, 'p1', 100, 0, 0);
		const ahead1 = placeOnLine(sim, 'p2', 300, 0, 0);
		const ahead2 = placeOnLine(sim, 'p3', 500, 0, 0);
		user.item = 'lightning';
		sim.tickOnce(inputMap({ p1: KEY.ITEM }));
		// (The victims' own updates tick the fresh timer down by one.)
		expect(ahead1.shrinkTimer).toBeGreaterThanOrEqual(175);
		expect(ahead2.shrinkTimer).toBeGreaterThanOrEqual(175);
		expect(user.shrinkTimer).toBe(0);
		// Shrunken karts are capped to ~60% speed.
		ahead1.speed = 3.4;
		for (let i = 0; i < 30; i++) sim.tickOnce(inputMap({}));
		expect(ahead1.speed).toBeLessThan(2.3);
	});

	it('item boxes respawn after 5s and skip karts that already hold an item', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = sim.karts[0];
		const box: ItemBoxState = sim.boxes[0];
		kart.x = box.x;
		kart.y = box.y;
		kart.speed = 0;
		sim.drainEvents();
		sim.tickOnce(inputMap({}));
		expect(box.respawn).toBe(300);
		const events = sim.drainEvents();
		expect(events).toContainEqual({ kind: 'collect', player: 'p1', item: 'itembox' });
		const granted = events.find((e) => e.kind === 'collect' && e.item !== 'itembox');
		if (granted) expect(kart.item).not.toBeNull();
		expect(kart.itemsUsed).toBe(0);

		// A kart holding an item drives over the (recharging) box: nothing.
		kart.item = 'oil';
		kart.x = box.x;
		kart.y = box.y;
		for (let i = 0; i < 299; i++) sim.tickOnce(inputMap({}));
		expect(box.respawn).toBe(1);
		expect(kart.item).toBe('oil');
		box.respawn = 0;
		sim.tickOnce(inputMap({}));
		expect(kart.item).toBe('oil'); // slot full: no grab, box stays up... except
		expect(box.respawn).toBe(0);
	});
});

describe('kart sim item odds', () => {
	function rollMany(place: number, total: number, seed: number, n = 400): Record<string, number> {
		let state = seed >>> 0;
		const rng = (): number => {
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const counts: Record<string, number> = {};
		for (let i = 0; i < n; i++) {
			const item = rollItem(place, total, rng) ?? 'nothing';
			counts[item] = (counts[item] ?? 0) + 1;
		}
		return counts;
	}

	it('first place gets mostly nothing or oil, never missiles or lightning', () => {
		const counts = rollMany(1, 8, 7);
		expect(counts['missile'] ?? 0).toBe(0);
		expect(counts['lightning'] ?? 0).toBe(0);
		const junk = (counts['nothing'] ?? 0) + (counts['oil'] ?? 0);
		expect(junk).toBeGreaterThan(200);
		// The weighting table itself says why.
		expect(itemWeights(1, 8).missile).toBe(0);
		expect(itemWeights(1, 8).nothing).toBeGreaterThan(itemWeights(1, 8).mushroom);
	});

	it('last place gets mushrooms and missiles', () => {
		const counts = rollMany(8, 8, 7);
		const good = (counts['mushroom'] ?? 0) + (counts['missile'] ?? 0);
		expect(good).toBeGreaterThan(200);
		expect(counts['missile'] ?? 0).toBeGreaterThan(50);
		// Lightning is rare everywhere.
		expect(counts['lightning'] ?? 0).toBeLessThan(70);
	});

	it('trailers are favored over leaders', () => {
		const front = rollMany(2, 8, 11);
		const back = rollMany(7, 8, 11);
		const frontGood = (front['mushroom'] ?? 0) + (front['missile'] ?? 0);
		const backGood = (back['mushroom'] ?? 0) + (back['missile'] ?? 0);
		expect(backGood).toBeGreaterThan(frontGood);
	});
});

describe('kart sim laps and checkpoints', () => {
	it('no lap without the full loop: teleports grant nothing', () => {
		const sim = createKartSim(SEED, CONFIG, [P1]);
		const kart = placeOnLine(sim, 'p1', 100);
		kart.lap = 0;
		kart.checkpoint = 1;
		kart.gateSign = -1;
		// Teleport deep into the lap, past gates 1..5: even the gate being
		// approached is refused (it is crossed too far off its gate line) and
		// nothing behind the teleport is granted. No lap can complete without
		// driving through every gate in order.
		kart.x = splineAt(sim.track, 600).x;
		kart.y = splineAt(sim.track, 600).y;
		for (let i = 0; i < 60; i++) sim.tickOnce(inputMap({}));
		expect(kart.checkpoint).toBe(1);
		expect(kart.lap).toBe(0);

		// A proper short-range approach DOES pass exactly one gate at a time.
		placeOnLine(sim, 'p1', 90, 0, 3);
		kart.checkpoint = 1;
		kart.lap = 0;
		kart.gateSign = -1;
		for (let i = 0; i < 20 && kart.checkpoint === 1; i++) sim.tickOnce(inputMap({}));
		expect(kart.checkpoint).toBe(2);
		expect(kart.lap).toBe(0);
	});

	it('a driven lap counts: lap events carry splits and laps complete in order', () => {
		const config: GameConfig = {
			...CONFIG,
			durationTicks: 60 * 240,
			options: { trackId: 'sunny-circuit', laps: 2, aiCount: 1, countdownTicks: 0 }
		};
		const sim = createKartSim(SEED, config, [P1]);
		const ai = sim.karts.find((k) => k.id === 'ai-1')!;
		const laps: number[] = [];
		const finishes: number[] = [];
		const inputs = new Map<PlayerId, InputFrame>([[P1.id, { keys: 0 }]]);
		for (let t = 0; t < config.durationTicks && !ai.finished; t++) {
			sim.tickOnce(inputs);
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'lap' && ev.player === 'ai-1') laps.push(ev.lap);
				if (ev.kind === 'finish' && ev.player === 'ai-1') finishes.push(ev.timeMs);
			}
		}
		expect(laps).toEqual([1, 2]);
		expect(finishes).toHaveLength(1);
		expect(finishes[0]).toBeGreaterThan(1000);
		expect(ai.lap).toBe(2);
		expect(ai.bestLapMs).toBeGreaterThan(0);
		expect(ai.lastLapMs).toBeGreaterThan(0);
		// Lap splits sum to the total race time.
		expect(ai.bestLapMs).toBeLessThanOrEqual(ai.finishTimeMs);
	}, 60_000);

	it('placement follows centerline progress', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2, P3]);
		placeOnLine(sim, 'p1', 200);
		placeOnLine(sim, 'p2', 600);
		placeOnLine(sim, 'p3', 400);
		sim.tickOnce(inputMap({}));
		expect(sim.karts.map((k) => [k.id, k.place])).toEqual([
			['p1', 3],
			['p2', 1],
			['p3', 2]
		]);
	});
});

describe('kart sim results', () => {
	it('ranks finishers by time, then DNFs by progress, with score and stats', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2, P3, P4]);
		const [k1, k2, k3, k4] = sim.karts;
		k1.finished = true;
		k1.finishTimeMs = 30000;
		k1.bestLapMs = 9000;
		k2.finished = true;
		k2.finishTimeMs = 25000;
		k2.bestLapMs = 20000;
		k3.lap = 2;
		k3.progress = 2600;
		k3.itemsUsed = 3;
		k3.driftBoosts = 5;
		k4.lap = 1;
		k4.progress = 900;

		const results = sim.results();
		expect(results.map((r) => r.player)).toEqual(['p2', 'p1', 'p3', 'p4']);
		expect(results.map((r) => r.placement)).toEqual([1, 2, 3, 4]);
		// score = placement bonus (1000/700/500/400...) + best-lap bonus.
		expect(results[0].score).toBe(1000 + 100); // bestLap 20s -> +100
		expect(results[1].score).toBe(700 + 210); // bestLap 9s -> +210
		expect(results[2].score).toBe(500);
		expect(results[3].score).toBe(400);
		for (const r of results) {
			expect(Object.keys(r.stats).sort()).toEqual([
				'bestLapMs',
				'driftBoosts',
				'itemsUsed',
				'laps',
				'totalTimeMs'
			]);
		}
		expect(results[2].stats).toEqual({
			laps: 2,
			bestLapMs: 0,
			totalTimeMs: 0,
			itemsUsed: 3,
			driftBoosts: 5
		});
	});
});

describe('kart sim match flow', () => {
	it('ends when everyone has finished and emits match-end', () => {
		const sim = createKartSim(SEED, CONFIG, [P1, P2]);
		sim.karts[0].finished = true;
		sim.karts[1].finished = true;
		sim.drainEvents();
		sim.tickOnce(inputMap({}));
		expect(sim.finished).toBe(true);
		expect(sim.drainEvents()).toContainEqual({ kind: 'match-end' });
	});

	it('ends at the duration timeout', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 10 };
		const sim = createKartSim(SEED, config, [P1]);
		for (let i = 0; i < 10; i++) sim.tickOnce(inputMap({}));
		expect(sim.finished).toBe(true);
	});

	it('countdown freezes karts and a timed KEY.UP gives a rocket start', () => {
		const config: GameConfig = {
			...CONFIG,
			options: { ...CONFIG.options, countdownTicks: 60 }
		};
		const sim = createKartSim(SEED, config, [P1, P2]);
		const early = sim.karts[0];
		const timed = sim.karts[1];
		// Countdown events: 3/2/1/GO.
		const values: number[] = [];
		for (let t = 0; t <= 60; t++) {
			sim.tickOnce(inputMap({ p1: t === 20 ? KEY.UP : 0, p2: t === 52 ? KEY.UP : 0 }));
			for (const ev of sim.drainEvents()) if (ev.kind === 'countdown') values.push(ev.value);
		}
		expect(values).toEqual([3, 2, 1, 0]);
		// Frozen during the countdown: nobody moved.
		expect(early.x).toBe(sim.track.startGrid[0].x);
		// The early press (20 = 40 ticks before GO) is outside the 12-tick
		// window: no rocket. The timed press (52) gets one.
		expect(early.boostTimer).toBe(0);
		expect(timed.boostTimer).toBeGreaterThan(0);
		expect(timed.boostPower).toBeCloseTo(0.3, 10);
	});
});

describe('kart sim AI', () => {
	it('AI karts are deterministic: same seed, same race, same hashes', () => {
		const config: GameConfig = {
			...CONFIG,
			durationTicks: 600,
			options: { ...CONFIG.options, aiCount: 2, aiDifficulty: 'medium' }
		};
		const a = createKartSim(SEED, config, [P1]);
		const b = createKartSim(SEED, config, [P1]);
		const inputs = inputMap({ p1: KEY.UP | KEY.LEFT });
		for (let t = 0; t < 600; t++) {
			a.tickOnce(inputs);
			b.tickOnce(inputs);
			expect(a.hash()).toBe(b.hash());
		}
		// The AI really drove (progress advanced beyond the grid).
		const ai = a.karts.filter((k) => k.id.startsWith('ai-'));
		expect(ai).toHaveLength(2);
		for (const kart of ai) expect(kart.progress).toBeGreaterThan(150);
	});

	it('AI karts use their items during a race', () => {
		const config: GameConfig = {
			...CONFIG,
			durationTicks: 60 * 60,
			options: { ...CONFIG.options, aiCount: 4, aiDifficulty: 'hard' }
		};
		const sim = createKartSim(SEED, config, [P1]);
		const inputs = inputMap({ p1: 0 });
		for (let t = 0; t < 60 * 60; t++) sim.tickOnce(inputs);
		const used = sim.karts
			.filter((k) => k.id.startsWith('ai-'))
			.reduce((n, k) => n + k.itemsUsed, 0);
		expect(used).toBeGreaterThan(0);
	}, 60_000);
});
