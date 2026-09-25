/**
 * GeoDash sim tests. THE KEY TEST is determinism: same seed + same recorded
 * input stream must produce identical hashes every tick and identical results,
 * including across snapshot/restore. The rest pin down the game feel rules
 * (jump buffer, coyote time), deaths, interactables, and race results.
 */
import { describe, expect, it } from 'vitest';
import type { GameConfig, InputFrame, PlayerId, SimPlayer } from '../types';
import { KEY } from '../types';
import type { GeoDashLevel, GeoDashObject, GeoDashMode } from './level-types';
import {
	createGeodashSim,
	parseGeoDashSnapshot,
	BALL_FLIP_VELOCITY,
	SHIP_MAX_VY,
	type GeoDashSim
} from './sim';

const PLAYERS: SimPlayer[] = [
	{ id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 },
	{ id: 'p2', name: 'Ben', color: '#57e389', slot: 1 },
	{ id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 }
];

function config(
	overrides: Partial<GameConfig> = {},
	options: Record<string, unknown> = {}
): GameConfig {
	return {
		tickRate: 60,
		durationTicks: 600,
		...overrides,
		options: { countdownTicks: 0, ...options }
	};
}

function testLevel(objects: GeoDashObject[], lengthPx = 2000): GeoDashLevel {
	return { id: 'test', name: 'Test', difficulty: 1, bpm: 120, lengthPx, objects };
}

function flatLevel(lengthPx = 2000): GeoDashLevel {
	return testLevel([{ type: 'block', x: 0, y: 0, w: lengthPx + 200, h: 80 }], lengthPx);
}

function player(sim: GeoDashSim, id = 'p1') {
	const p = sim.players.find((entry) => entry.id === id);
	if (!p) throw new Error(`no player ${id}`);
	return p;
}

function frame(key: number): InputFrame {
	return { keys: key };
}

function mapOf(...pairs: [PlayerId, InputFrame][]): Map<PlayerId, InputFrame> {
	return new Map(pairs);
}

/** Press (edge) JUMP for exactly one tick every time `pressed` flips true. */
function driveTicks(
	sim: GeoDashSim,
	ticks: number,
	decide: (tick: number, sim: GeoDashSim) => number
): { deathCauses: string[]; eventKinds: string[] } {
	const deathCauses: string[] = [];
	const eventKinds: string[] = [];
	for (let t = 0; t < ticks; t++) {
		sim.tickOnce(mapOf(['p1', frame(decide(t, sim))]));
		for (const ev of sim.drainEvents()) {
			eventKinds.push(ev.kind);
			if (ev.kind === 'death') deathCauses.push(ev.cause);
		}
	}
	return { deathCauses, eventKinds };
}

// ---- determinism ----

/** Deterministic input script: purely a function of (tick, player index). */
function scriptKeys(tick: number, index: number): number {
	let keys = 0;
	if ((tick + index) % 11 === 0) keys |= KEY.JUMP;
	if ((tick + index) % 29 === 0) keys |= KEY.SPECIAL;
	return keys;
}

type Stream = Map<PlayerId, InputFrame>[];

function makeStream(ticks: number): Stream {
	const stream: Stream = [];
	for (let t = 0; t < ticks; t++) {
		const m = new Map<PlayerId, InputFrame>();
		PLAYERS.forEach((p, i) => m.set(p.id, { keys: scriptKeys(t, i) }));
		stream.push(m);
	}
	return stream;
}

describe('geodash sim determinism', () => {
	const cfg = config({ durationTicks: 900 }, { levelId: 'level-1' });

	it('two sims with the same seed and input stream hash identically at every tick', () => {
		const a = createGeodashSim(1337, cfg, PLAYERS);
		const b = createGeodashSim(1337, cfg, PLAYERS);
		const stream = makeStream(cfg.durationTicks);

		const hashes = new Set<number>();
		for (const input of stream) {
			a.tickOnce(input);
			b.tickOnce(input);
			expect(a.hash()).toBe(b.hash());
			expect(a.tick).toBe(b.tick);
			hashes.add(a.hash());
		}

		expect(hashes.size).toBeGreaterThan(10);
		expect(a.finished).toBe(true);
		expect(a.results()).toEqual(b.results());
		expect(a.hash()).toBe(a.hash());
	});

	it('produces a stable unsigned 32-bit hash', () => {
		const sim = createGeodashSim(7, cfg, PLAYERS);
		const h = sim.hash();
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
	});

	it('resumed sim matches an uninterrupted run tick for tick', () => {
		const cut = 300;
		const stream = makeStream(cfg.durationTicks);

		const a = createGeodashSim(1337, cfg, PLAYERS);
		let snap: ReturnType<GeoDashSim['snapshot']> | null = null;
		let hashAtCut = 0;
		const hashesAfterCut: number[] = [];
		stream.forEach((input, i) => {
			a.tickOnce(input);
			if (i === cut - 1) {
				snap = a.snapshot();
				hashAtCut = a.hash();
			}
			if (i >= cut) hashesAfterCut.push(a.hash());
		});
		const endHash = a.hash();
		expect(snap).not.toBeNull();

		const b = createGeodashSim(1337, cfg, PLAYERS);
		for (let i = 0; i < cut; i++) b.tickOnce(stream[i]);
		b.restore(snap!);
		expect(b.hash()).toBe(hashAtCut);
		expect(b.tick).toBe(cut);

		stream.slice(cut).forEach((input, i) => {
			b.tickOnce(input);
			expect(b.hash()).toBe(hashesAfterCut[i]);
		});
		expect(b.hash()).toBe(endHash);
		expect(b.results()).toEqual(a.results());
	});

	it('restore works into a fresh sim and erases rng state', () => {
		const cut = 250;
		const stream = makeStream(cfg.durationTicks);
		const a = createGeodashSim(1337, cfg, PLAYERS);
		for (let i = 0; i < cut; i++) a.tickOnce(stream[i]);
		const snap = a.snapshot();

		// Different seed => different spawn phases; restore must erase that too.
		const b = createGeodashSim(999, cfg, PLAYERS);
		b.restore(snap);
		expect(b.hash()).toBe(a.hash());

		for (let i = cut; i < stream.length; i++) {
			a.tickOnce(stream[i]);
			b.tickOnce(stream[i]);
			expect(b.hash()).toBe(a.hash());
		}
		expect(b.results()).toEqual(a.results());
	});

	it('snapshot parses back from untyped JSON', () => {
		const sim = createGeodashSim(5, cfg, PLAYERS);
		for (let i = 0; i < 50; i++) sim.tickOnce(new Map());
		const roundTripped = JSON.parse(JSON.stringify(sim.snapshot()));
		const parsed = parseGeoDashSnapshot(roundTripped);
		expect(parsed).not.toBeNull();
		expect(parsed!.players).toHaveLength(PLAYERS.length);
		expect(parsed!.tick).toBe(50);
	});
});

// ---- jump feel: buffer + coyote ----

describe('geodash jump buffer and coyote time', () => {
	const cfg = config({ durationTicks: 400 }, { level: flatLevel() });

	it('a jump pressed 3 ticks before landing still jumps; 6 ticks before does not', () => {
		// First: learn exactly when the landing happens after a tick-0 jump.
		const probe = createGeodashSim(1, cfg, [PLAYERS[0]]);
		probe.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
		let landTick = -1;
		for (let t = 1; t < 60; t++) {
			probe.tickOnce(mapOf(['p1', frame(0)]));
			if (landTick < 0 && player(probe).onGround) landTick = t;
		}
		expect(landTick).toBeGreaterThan(10);

		const jumpAt = (tick: number): void => {
			const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
			for (let t = 0; t < landTick + 4; t++) {
				sim.tickOnce(mapOf(['p1', frame(t === 0 || t === tick ? KEY.JUMP : 0)]));
			}
			sim.drainEvents();
			// A buffered press fires the jump right when the cube touches down.
			expect(player(sim).onGround).toBe(tick < landTick - 3);
			expect(player(sim).vy < 0).toBe(tick >= landTick - 3);
		};

		jumpAt(landTick - 3); // within the 4-tick buffer -> jumps on landing
		jumpAt(landTick - 6); // buffer expired -> stays grounded
	});

	it('hold-jump re-jumps immediately on landing (auto-jump)', () => {
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		let jumps = 0;
		let prevVy = 0;
		for (let t = 0; t < 200; t++) {
			sim.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
			const p = player(sim);
			if (prevVy >= 0 && p.vy < 0) jumps++;
			prevVy = p.vy;
		}
		expect(jumps).toBeGreaterThanOrEqual(3);
	});

	it('coyote time: jump works 3 ticks after walking off a ledge, not later', () => {
		const level = testLevel([{ type: 'block', x: 0, y: 0, w: 400, h: 80 }], 1200);
		const ledgeCfg = config({ durationTicks: 300 }, { level });

		// Find the tick where the cube runs off the ledge (ground -> air, no jump).
		const probe = createGeodashSim(1, ledgeCfg, [PLAYERS[0]]);
		let fallTick = -1;
		for (let t = 0; t < 80; t++) {
			probe.tickOnce(mapOf(['p1', frame(0)]));
			if (fallTick < 0 && t > 0 && !player(probe).onGround) fallTick = t;
		}
		expect(fallTick).toBeGreaterThan(10);

		const pressAt = (tick: number) => {
			const sim = createGeodashSim(1, ledgeCfg, [PLAYERS[0]]);
			for (let t = 0; t <= tick; t++) {
				sim.tickOnce(mapOf(['p1', frame(t === tick ? KEY.JUMP : 0)]));
			}
			return player(sim);
		};

		expect(pressAt(fallTick + 3).vy).toBeLessThan(0); // inside coyote window
		expect(pressAt(fallTick + 5).vy).toBeGreaterThan(0); // window missed
	});
});

// ---- deaths ----

describe('geodash deaths', () => {
	it('dies on spikes with cause spike and counts attempts', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2000, h: 80 },
				{ type: 'spike', x: 400, y: -40 }
			],
			1800
		);
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		const { deathCauses, eventKinds } = driveTicks(sim, 120, () => 0);
		expect(deathCauses).toContain('spike');
		expect(deathCauses[0]).toBe('spike');
		expect(eventKinds[0]).toBe('spawn');
		expect(eventKinds).toContain('death');
		expect(eventKinds).toContain('respawn');
		const p = player(sim);
		expect(p.deaths).toBeGreaterThanOrEqual(1);
		expect(p.attempts).toBe(p.deaths + 1);
		expect(p.x).toBeLessThan(400); // reset back to the start
	});

	it('dies on block side collision with cause block', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2000, h: 80 },
				{ type: 'block', x: 400, y: -80, w: 80, h: 80 }
			],
			1800
		);
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		const { deathCauses } = driveTicks(sim, 120, () => 0);
		expect(deathCauses[0]).toBe('block');
	});

	it('falls into a pit with cause fall', () => {
		const level = testLevel([{ type: 'block', x: 0, y: 0, w: 300, h: 80 }], 1800);
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		const { deathCauses } = driveTicks(sim, 120, () => 0);
		expect(deathCauses[0]).toBe('fall');
	});

	it('respawn is invulnerable for 3 ticks', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2000, h: 80 },
				{ type: 'spike', x: 24, y: -40 }
			],
			1800
		);
		// The spike sits right at the spawn point: only the warmup makes the
		// start survivable, and once it lapses the cube dies there.
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		const { deathCauses } = driveTicks(sim, 30, () => 0);
		expect(deathCauses.length).toBeGreaterThanOrEqual(1);
		expect(player(sim).warmup).toBeLessThanOrEqual(3);
	});
});

// ---- interactables ----

describe('geodash pads, orbs and speed portals', () => {
	it('a jump pad launches with vy = -13 * power and boosts once', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2000, h: 80 },
				{ type: 'pad', x: 300, y: -8, power: 1.4 }
			],
			1800
		);
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		const boosts: number[] = [];
		let launchedVy = 0;
		for (let t = 0; t < 120; t++) {
			sim.tickOnce(mapOf(['p1', frame(0)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'boost') boosts.push(ev.power);
			}
			const p = player(sim);
			if (boosts.length > 0 && launchedVy === 0) launchedVy = p.vy;
		}
		expect(boosts).toEqual([1.4]);
		expect(launchedVy).toBeLessThan(-18);
		expect(player(sim).deaths).toBe(0);
	});

	it('an orb gives one air jump per attempt and reports collect', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2000, h: 80 },
				{ type: 'orb', x: 140, y: -110 }
			],
			1800
		);
		const sim = createGeodashSim(1, config({ durationTicks: 200 }, { level }), [PLAYERS[0]]);
		let collects = 0;
		let orbJumpVy = 0;
		for (let t = 0; t < 60; t++) {
			// Jump at tick 0, then tap JUMP on and off through the arc.
			const keys = t === 0 || (t >= 5 && t <= 15 && t % 2 === 1) ? KEY.JUMP : 0;
			sim.tickOnce(mapOf(['p1', frame(keys)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'collect') {
					collects++;
					orbJumpVy = player(sim).vy;
				}
			}
		}
		expect(collects).toBe(1);
		expect(orbJumpVy).toBeLessThan(-12);
		expect(player(sim).orbUsed).toBe(1);
	});

	it('a speed portal changes the run speed and boosts once', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 2400, h: 80 },
				{ type: 'speed', x: 300, y: -140, mult: 1.3 }
			],
			1800
		);
		const sim = createGeodashSim(1, config({ durationTicks: 120 }, { level }), [PLAYERS[0]]);
		const powers: number[] = [];
		for (let t = 0; t < 120; t++) {
			sim.tickOnce(mapOf(['p1', frame(0)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'boost') powers.push(ev.power);
			}
		}
		expect(powers).toEqual([1.3]);
		const p = player(sim);
		expect(p.speedMult).toBe(1.3);
		expect(p.x).toBeGreaterThan(8.5 * 1.3 * 100); // clearly faster than base
		expect(p.x).toBeGreaterThan(8.5 * 120); // fastest tick already past the portal
	});
});

// ---- race results ----

describe('geodash race results', () => {
	it('ranks finishers first by time, then by progress, with GD stats', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 1400, h: 80 },
				{ type: 'spike', x: 200, y: -40 },
				{ type: 'spike', x: 400, y: -40 }
			],
			1200
		);
		const cfg = config({ durationTicks: 400 }, { level });
		const sim = createGeodashSim(1, cfg, PLAYERS);
		sim.drainEvents();

		// p1 clears both spikes, p2 clears only the first, p3 clears none.
		const avoid = (tick: number, sim: GeoDashSim, id: PlayerId, spikes: number[]): number => {
			const p = sim.players.find((entry) => entry.id === id);
			if (!p || !p.onGround) return 0;
			for (const sx of spikes) {
				const hitLeft = sx + 9;
				if (hitLeft - p.x > 0 && hitLeft - p.x <= 150) return KEY.JUMP;
			}
			return 0;
		};

		for (let t = 0; t < cfg.durationTicks; t++) {
			sim.tickOnce(
				mapOf(
					['p1', frame(avoid(t, sim, 'p1', [200, 400]))],
					['p2', frame(avoid(t, sim, 'p2', [200]))],
					['p3', frame(0)]
				)
			);
			sim.drainEvents();
		}

		expect(sim.finished).toBe(true);
		const results = sim.results();
		expect(results.map((r) => r.player)).toEqual(['p1', 'p2', 'p3']);
		expect(results.map((r) => r.placement)).toEqual([1, 2, 3]);
		expect(results[0].stats['deaths']).toBe(0);
		expect(results[0].score).toBeGreaterThanOrEqual(1000); // finish bonus
		expect(results[1].stats['deaths']).toBeGreaterThan(0);
		expect(results[1].stats['progressPercent']).toBeGreaterThan(
			results[2].stats['progressPercent']
		);
		expect(results[2].stats['attempts']).toBeGreaterThan(1);
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});
});

// ---- countdown + lifecycle ----

describe('geodash countdown and match lifecycle', () => {
	it('freezes movement for 180 ticks and emits 3/2/1/0', () => {
		const cfg = config({ durationTicks: 500 }, { level: flatLevel(), countdownTicks: 180 });
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		const countdowns: { tick: number; value: number }[] = [];
		for (let t = 0; t < 190; t++) {
			sim.tickOnce(mapOf(['p1', frame(KEY.JUMP | KEY.RIGHT)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'countdown') countdowns.push({ tick: t, value: ev.value });
			}
			if (t < 180) expect(player(sim).x).toBe(0);
		}
		expect(countdowns.map((c) => c.value)).toEqual([3, 2, 1, 0]);
		expect(countdowns.map((c) => c.tick)).toEqual([0, 60, 120, 180]);
		expect(player(sim).x).toBeGreaterThan(0);
	});

	it('emits match-end exactly once at durationTicks', () => {
		const cfg = config({ durationTicks: 100 }, { level: flatLevel() });
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		sim.drainEvents();
		let ends = 0;
		for (let t = 0; t < 120; t++) {
			sim.tickOnce(new Map());
			for (const ev of sim.drainEvents()) if (ev.kind === 'match-end') ends++;
		}
		expect(ends).toBe(1);
		expect(sim.finished).toBe(true);
		const endHash = sim.hash();
		sim.tickOnce(new Map());
		expect(sim.hash()).toBe(endHash);
	});

	it('disconnected players keep their last input', () => {
		const cfg = config({ durationTicks: 200 }, { level: flatLevel() });
		const held = createGeodashSim(1, cfg, [PLAYERS[0]]);
		const idle = createGeodashSim(1, cfg, [PLAYERS[0]]);
		let heldAirborne = 0;
		let idleAirborne = 0;
		for (let t = 0; t < 120; t++) {
			// The "connected" frame arrives only on tick 0; after that the
			// player is gone from the inputs map entirely.
			held.tickOnce(t === 0 ? mapOf(['p1', frame(KEY.JUMP)]) : new Map());
			idle.tickOnce(new Map());
			if (!player(held).onGround) heldAirborne++;
			if (!player(idle).onGround) idleAirborne++;
		}
		expect(heldAirborne).toBeGreaterThan(idleAirborne + 30);
		expect(player(held).deaths).toBe(0);
	});
});

// ---- forms: ship ----

/** Tall corridor (floor + ceiling) with a ship portal right at the start. */
function shipLevel(): GeoDashLevel {
	return testLevel(
		[
			{ type: 'block', x: 0, y: -560, w: 3000, h: 80 },
			{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
			{ type: 'portal', x: 10, mode: 'ship' }
		],
		2500
	);
}

function becomeShip(sim: GeoDashSim): void {
	for (let t = 0; t < 3; t++) sim.tickOnce(mapOf(['p1', frame(0)]));
	sim.drainEvents();
	expect(player(sim).mode).toBe('ship');
}

describe('geodash ship form', () => {
	const cfg = config({ durationTicks: 400 }, { level: shipLevel() });

	it('hold JUMP thrusts up and clamps at SHIP_MAX_VY; release falls and clamps down', () => {
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		becomeShip(sim);

		let sawClampUp = false;
		let maxAbsVy = 0;
		let minY = 0;
		for (let t = 0; t < 25; t++) {
			sim.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
			const p = player(sim);
			if (p.vy === -SHIP_MAX_VY) sawClampUp = true;
			maxAbsVy = Math.max(maxAbsVy, Math.abs(p.vy));
			minY = Math.min(minY, p.y);
		}
		expect(sawClampUp).toBe(true);
		expect(minY).toBeLessThan(-90); // clearly climbed

		let sawClampDown = false;
		for (let t = 0; t < 60; t++) {
			sim.tickOnce(mapOf(['p1', frame(0)]));
			const p = player(sim);
			if (p.vy === SHIP_MAX_VY) sawClampDown = true;
			maxAbsVy = Math.max(maxAbsVy, Math.abs(p.vy));
			if (p.onGround) break;
		}
		expect(sawClampDown).toBe(true);
		expect(maxAbsVy).toBeLessThanOrEqual(SHIP_MAX_VY); // never flips past the clamp
		expect(player(sim).deaths).toBe(0);
	});

	it('a short tap barely lifts the ship; a sustained hold climbs hard', () => {
		const fly = (keys: (t: number) => number): number => {
			const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
			becomeShip(sim);
			let minY = 0;
			for (let t = 0; t < 35; t++) {
				sim.tickOnce(mapOf(['p1', frame(keys(t))]));
				minY = Math.min(minY, player(sim).y);
			}
			return minY;
		};
		const tapY = fly((t) => (t === 0 || t === 1 ? KEY.JUMP : 0));
		const holdY = fly((t) => (t < 30 ? KEY.JUMP : 0));
		expect(holdY).toBeLessThan(tapY - 60);
	});

	it('lands on top of a block and slides along; side hits still kill', () => {
		// A low mound mid-corridor: fly over its edge and settle on its top.
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: -560, w: 3000, h: 80 },
				{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
				{ type: 'portal', x: 10, mode: 'ship' },
				{ type: 'block', x: 200, y: -40, w: 800, h: 40 }
			],
			2500
		);
		const sim = createGeodashSim(1, config({ durationTicks: 300 }, { level }), [PLAYERS[0]]);
		becomeShip(sim);
		let landedY = 0;
		let landedX = 0;
		for (let t = 0; t < 80; t++) {
			// climb over the mound's leading edge, then coast down onto its top
			sim.tickOnce(mapOf(['p1', frame(t < 12 ? KEY.JUMP : 0)]));
			const p = player(sim);
			if (p.onGround && p.x > 300) {
				landedY = p.y;
				landedX = p.x;
				break;
			}
		}
		expect(landedY).toBe(-70); // top of the mound (-40) minus the 30px hitbox
		expect(landedX).toBeGreaterThan(300);
		expect(player(sim).deaths).toBe(0);

		// Same mound with no thrust: the ship rams its side and dies.
		const crash = createGeodashSim(1, config({ durationTicks: 300 }, { level }), [PLAYERS[0]]);
		becomeShip(crash);
		const { deathCauses } = driveTicks(crash, 80, () => 0);
		expect(deathCauses[0]).toBe('block');
	});
});

// ---- forms: ball ----

/** Floor + rollable ceiling with a ball portal right at the start. */
function ballLevel(): GeoDashLevel {
	return testLevel(
		[
			{ type: 'block', x: 0, y: -240, w: 3000, h: 40 },
			{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
			{ type: 'portal', x: 10, mode: 'ball' }
		],
		2500
	);
}

function becomeBall(sim: GeoDashSim): void {
	for (let t = 0; t < 3; t++) sim.tickOnce(mapOf(['p1', frame(0)]));
	sim.drainEvents();
	expect(player(sim).mode).toBe('ball');
}

describe('geodash ball form', () => {
	const cfg = config({ durationTicks: 400 }, { level: ballLevel() });

	it('tapping JUMP on the ground flips gravity and rolls to the ceiling', () => {
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		becomeBall(sim);
		expect(player(sim).gravityDir).toBe(1);

		sim.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
		sim.drainEvents();
		const flipped = player(sim);
		expect(flipped.gravityDir).toBe(-1);
		expect(flipped.vy).toBeLessThan(0);
		expect(flipped.vy).toBeCloseTo(BALL_FLIP_VELOCITY * -1 - 0.8, 5);

		// rises to the ceiling (underside at y = -200) and presses against it
		for (let t = 0; t < 40; t++) sim.tickOnce(mapOf(['p1', frame(0)]));
		const onCeiling = player(sim);
		expect(onCeiling.onGround).toBe(true);
		expect(onCeiling.y).toBe(-200);
		expect(onCeiling.gravityDir).toBe(-1);

		// tap again: flips back down to the floor
		sim.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
		expect(player(sim).gravityDir).toBe(1);
		for (let t = 0; t < 40; t++) sim.tickOnce(mapOf(['p1', frame(0)]));
		expect(player(sim).onGround).toBe(true);
		expect(player(sim).y).toBe(-30);
		expect(player(sim).deaths).toBe(0);
	});

	it('holding JUMP flips once, not repeatedly', () => {
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		becomeBall(sim);
		let flips = 0;
		let prevDir: 1 | -1 = 1;
		for (let t = 0; t < 120; t++) {
			sim.tickOnce(mapOf(['p1', frame(KEY.JUMP)]));
			const p = player(sim);
			if (p.gravityDir !== prevDir) {
				flips++;
				prevDir = p.gravityDir;
			}
		}
		expect(flips).toBe(1);
		expect(player(sim).deaths).toBe(0);
	});

	it('pads and speed portals apply to the ball; spikes still kill it', () => {
		const level = testLevel(
			[
				{ type: 'block', x: 0, y: -240, w: 3000, h: 40 },
				{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
				{ type: 'portal', x: 10, mode: 'ball' },
				{ type: 'speed', x: 300, y: -140, mult: 1.3 },
				{ type: 'pad', x: 500, y: -8, power: 1.4 }
			],
			2500
		);
		const sim = createGeodashSim(1, config({ durationTicks: 300 }, { level }), [PLAYERS[0]]);
		becomeBall(sim);
		const boosts: number[] = [];
		let padVy = 0;
		for (let t = 0; t < 100; t++) {
			sim.tickOnce(mapOf(['p1', frame(0)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'boost') {
					boosts.push(ev.power);
					padVy = player(sim).vy;
				}
			}
		}
		expect(boosts).toEqual([1.3, 1.4]);
		expect(padVy).toBeLessThan(-18); // pad launches against gravity
		expect(player(sim).speedMult).toBe(1.3);

		// rolling into a spike kills; the death resets the form to cube
		// (the re-crossed portal transforms again on the next attempt)
		const spikeLevel = testLevel(
			[
				{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
				{ type: 'portal', x: 10, mode: 'ball' },
				{ type: 'spike', x: 600, y: -40 }
			],
			2500
		);
		const deathSim = createGeodashSim(1, config({ durationTicks: 300 }, { level: spikeLevel }), [
			PLAYERS[0]
		]);
		const deathCauses: string[] = [];
		let modeAtDeath: GeoDashMode | null = null;
		for (let t = 0; t < 100; t++) {
			deathSim.tickOnce(mapOf(['p1', frame(0)]));
			for (const ev of deathSim.drainEvents()) {
				if (ev.kind === 'death') {
					deathCauses.push(ev.cause);
					modeAtDeath = player(deathSim).mode;
				}
			}
		}
		expect(deathCauses[0]).toBe('spike');
		expect(modeAtDeath).toBe('cube'); // respawn resets the form
	});
});

// ---- mode portals ----

describe('geodash mode portals', () => {
	const level = testLevel(
		[
			{ type: 'block', x: 0, y: 0, w: 3000, h: 80 },
			{ type: 'portal', x: 500, mode: 'ball' }
		],
		2500
	);
	const cfg = config({ durationTicks: 200 }, { level });

	it('transforms on the exact tick the portal plane is crossed (deterministic)', () => {
		const a = createGeodashSim(1, cfg, [PLAYERS[0]]);
		const b = createGeodashSim(1, cfg, [PLAYERS[0]]);
		let crossTick = -1;
		let prevMode: GeoDashMode = 'cube';
		for (let t = 0; t < 200; t++) {
			const input = mapOf(['p1', frame(0)]);
			a.tickOnce(input);
			b.tickOnce(input);
			expect(b.hash()).toBe(a.hash());
			const p = player(a);
			if (crossTick < 0 && p.x >= 500) {
				crossTick = t;
				expect(p.mode).toBe('ball'); // flips exactly on the crossing tick
				expect(prevMode).toBe('cube');
			}
			prevMode = p.mode;
		}
		expect(crossTick).toBe(58); // 8.5px/tick: x first reaches 500 on tick 58
	});

	it('emits a transform event with the target mode on portal entry', () => {
		const sim = createGeodashSim(1, cfg, [PLAYERS[0]]);
		const transforms: { tick: number; mode: string }[] = [];
		for (let t = 0; t < 200; t++) {
			sim.tickOnce(mapOf(['p1', frame(0)]));
			for (const ev of sim.drainEvents()) {
				if (ev.kind === 'transform') transforms.push({ tick: t, mode: ev.mode });
			}
		}
		expect(transforms).toEqual([{ tick: 58, mode: 'ball' }]);
	});

	it('snapshot/restore/hash include the form', () => {
		const a = createGeodashSim(1, cfg, [PLAYERS[0]]);
		for (let t = 0; t < 60; t++) a.tickOnce(mapOf(['p1', frame(0)]));
		expect(player(a).mode).toBe('ball');
		const snap = JSON.parse(JSON.stringify(a.snapshot()));

		const b = createGeodashSim(999, cfg, [PLAYERS[0]]);
		b.restore(snap);
		expect(player(b).mode).toBe('ball');
		expect(b.hash()).toBe(a.hash());
		for (let t = 60; t < 200; t++) {
			const input = mapOf(['p1', frame(0)]);
			a.tickOnce(input);
			b.tickOnce(input);
			expect(b.hash()).toBe(a.hash());
		}

		// The hash actually depends on the form: two sims with identical
		// physics but a portal (form change) vs without must diverge.
		const plain = createGeodashSim(1, config({ durationTicks: 200 }, { level: flatLevel() }), [
			PLAYERS[0]
		]);
		const withPortal = createGeodashSim(1, cfg, [PLAYERS[0]]);
		for (let t = 0; t < 100; t++) {
			plain.tickOnce(mapOf(['p1', frame(0)]));
			withPortal.tickOnce(mapOf(['p1', frame(0)]));
		}
		expect(player(plain).x).toBe(player(withPortal).x);
		expect(player(plain).y).toBe(player(withPortal).y);
		expect(plain.hash()).not.toBe(withPortal.hash());
	});
});
