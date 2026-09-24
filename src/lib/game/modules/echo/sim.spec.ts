/**
 * THE determinism test for the netcode pipeline: same seed + same recorded
 * input stream must reproduce identical sims — on every tick, across
 * snapshot/restore, and in the final results.
 */
import { describe, expect, it } from 'vitest';
import type { GameConfig, InputFrame, PlayerId, SimPlayer } from '../../types';
import { KEY } from '../../types';
import { createEchoSim, type EchoSim } from './sim';

const PLAYERS: SimPlayer[] = [
	{ id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 },
	{ id: 'p2', name: 'Ben', color: '#57e389', slot: 1 },
	{ id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 }
];

const SEED = 1337;
const CONFIG: GameConfig = { tickRate: 60, durationTicks: 240, options: {} };

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

type Stream = Map<PlayerId, InputFrame>[];

function makeStream(ticks: number): Stream {
	const stream: Stream = [];
	for (let t = 0; t < ticks; t++) {
		const frame = new Map<PlayerId, InputFrame>();
		PLAYERS.forEach((p, i) => frame.set(p.id, { keys: scriptKeys(t, i) }));
		stream.push(frame);
	}
	return stream;
}

function drainAll(sim: EchoSim, into: Record<string, number> | null = null) {
	const events = sim.drainEvents();
	if (into) for (const ev of events) into[ev.kind] = (into[ev.kind] ?? 0) + 1;
	return events;
}

function bucket(): Record<string, number> {
	return {};
}

describe('echo sim determinism', () => {
	it('two sims with the same seed and input stream hash identically at every tick', () => {
		const a = createEchoSim(SEED, CONFIG, PLAYERS);
		const b = createEchoSim(SEED, CONFIG, PLAYERS);
		const stream = makeStream(CONFIG.durationTicks);

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
		const a = createEchoSim(SEED, CONFIG, PLAYERS);
		const h = a.hash();
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
	});
});

describe('echo sim snapshot/restore', () => {
	it('resumed sim matches an uninterrupted run tick for tick', () => {
		const cut = 100;
		const stream = makeStream(CONFIG.durationTicks);

		// Uninterrupted reference run, snapshotting exactly at `cut` ticks.
		const a = createEchoSim(SEED, CONFIG, PLAYERS);
		let snap: ReturnType<EchoSim['snapshot']> | null = null;
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

		// Replay up to the cut, then resume from the snapshot.
		const b = createEchoSim(SEED, CONFIG, PLAYERS);
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

	it('restore works into a fresh sim and preserves results', () => {
		const cut = 50;
		const stream = makeStream(CONFIG.durationTicks);
		const a = createEchoSim(SEED, CONFIG, PLAYERS);
		for (let i = 0; i < cut; i++) a.tickOnce(stream[i]);
		const snap = a.snapshot();

		// Different seed => different spawns; restore must erase all of that.
		const b = createEchoSim(SEED + 999, CONFIG, PLAYERS);
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
});

describe('echo sim results', () => {
	it('ranks by accumulated distance with placement and score', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 180 };
		const sim = createEchoSim(SEED, config, PLAYERS);
		sim.drainEvents();

		const drive = new Map<PlayerId, InputFrame>([
			['p1', { keys: KEY.RIGHT | KEY.DOWN }], // full speed all match
			['p2', { keys: 0 }], // idle
			['p3', { keys: KEY.RIGHT }] // half speed
		]);
		for (let i = 0; i < config.durationTicks; i++) sim.tickOnce(drive);

		const results = sim.results();
		expect(results.map((r) => r.placement)).toEqual([1, 2, 3]);
		expect(results.map((r) => r.player)).toEqual(['p1', 'p3', 'p2']);
		expect(results[0].score).toBeGreaterThan(results[1].score);
		expect(results[1].score).toBeGreaterThan(results[2].score);
		for (const r of results) {
			expect(r.score).toBe(Math.round(r.stats['distance']));
			expect(r.score).toBeGreaterThanOrEqual(0);
		}
	});

	it('breaks distance ties deterministically by player id', () => {
		const sim = createEchoSim(SEED, CONFIG, PLAYERS);
		for (let i = 0; i < CONFIG.durationTicks; i++) sim.tickOnce(new Map());
		const results = sim.results();
		expect(results.map((r) => r.player)).toEqual(['p1', 'p2', 'p3']);
		expect(new Set(results.map((r) => r.placement)).size).toBe(3);
	});
});

describe('echo sim events and lifecycle', () => {
	it('emits spawn for every player at start', () => {
		const sim = createEchoSim(SEED, CONFIG, PLAYERS);
		const events = drainAll(sim);
		expect(events.map((e) => e.kind)).toEqual(['spawn', 'spawn', 'spawn']);
		expect(events.map((e) => (e.kind === 'spawn' ? e.player : ''))).toEqual(['p1', 'p2', 'p3']);
	});

	it('emits boost when a player reaches max speed', () => {
		const sim = createEchoSim(SEED, CONFIG, PLAYERS);
		sim.drainEvents();
		const drive = new Map<PlayerId, InputFrame>([['p1', { keys: KEY.RIGHT | KEY.DOWN }]]);
		const counts = bucket();
		for (let i = 0; i < 60; i++) {
			sim.tickOnce(drive);
			drainAll(sim, counts);
		}
		expect(counts['boost']).toBeGreaterThanOrEqual(1);
	});

	it('finishes exactly after durationTicks with a single match-end', () => {
		const config: GameConfig = { ...CONFIG, durationTicks: 60 };
		const sim = createEchoSim(SEED, config, PLAYERS);
		const counts = bucket();
		drainAll(sim, counts);

		for (let i = 0; i < config.durationTicks - 1; i++) {
			sim.tickOnce(new Map());
			drainAll(sim, counts);
			expect(sim.finished).toBe(false);
		}
		sim.tickOnce(new Map());
		drainAll(sim, counts);
		expect(sim.finished).toBe(true);
		expect(sim.tick).toBe(config.durationTicks);
		expect(counts['match-end']).toBe(1);

		// Ticks after the end are ignored: state and events stay put.
		const endHash = sim.hash();
		sim.tickOnce(new Map());
		drainAll(sim, counts);
		expect(sim.hash()).toBe(endHash);
		expect(counts['match-end']).toBe(1);
		expect(sim.results()).toHaveLength(PLAYERS.length);
	});
});
