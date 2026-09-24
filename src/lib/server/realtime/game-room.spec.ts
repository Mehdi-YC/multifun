import { describe, expect, it, vi, afterEach } from 'vitest';
import type { GameConfig, GameEvent, GameSim, InputFrame, MatchResult } from '$lib/game/types';
import type { ServerMessage } from '$lib/net/protocol';
import { GameRoom } from './game-room';

/** Minimal deterministic sim: each tick moves every player by their input keys. */
function fakeSim(tickLimit: number): GameSim & { positions: Map<string, number> } {
	let tick = 0;
	const positions = new Map<string, number>();
	const events: GameEvent[] = [];
	return {
		positions,
		get tick() {
			return tick;
		},
		get finished() {
			return tick >= tickLimit;
		},
		tickOnce(inputs: Map<string, InputFrame>) {
			tick++;
			for (const [player, input] of inputs) {
				positions.set(player, (positions.get(player) ?? 0) + input.keys);
				if (input.keys > 0) events.push({ kind: 'boost', player, power: input.keys });
			}
		},
		drainEvents() {
			return events.splice(0);
		},
		snapshot() {
			return { tick, positions: Object.fromEntries(positions) };
		},
		restore() {},
		results(): MatchResult[] {
			return [...positions.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([player, score], i) => ({ player, placement: i + 1, score, stats: {} }));
		},
		hash() {
			return tick;
		}
	};
}

const config: GameConfig = { tickRate: 60, durationTicks: 5, options: {} };

function setup(tickLimit: number) {
	const sim = fakeSim(tickLimit);
	const messages: ServerMessage[] = [];
	const onEnd = vi.fn();
	const room = new GameRoom({
		matchId: 'm1',
		gameId: 'echo',
		sim,
		config,
		players: [
			{ id: 'a', name: 'A', color: '#fff', slot: 0 },
			{ id: 'b', name: 'B', color: '#000', slot: 1 }
		],
		broadcast: (msg) => messages.push(msg),
		onEnd
	});
	return { sim, messages, onEnd, room };
}

describe('GameRoom', () => {
	afterEach(() => vi.useRealTimers());

	it('ticks the sim, broadcasts events and periodic snapshots', () => {
		vi.useFakeTimers();
		const { room, messages, sim } = setup(4);
		room.addInput('a', 3);
		room.start(Date.now());
		vi.advanceTimersByTime(70); // ~4 ticks at 60Hz
		expect(sim.tick).toBeGreaterThanOrEqual(4);
		expect(messages.some((m) => m.t === 'game.event')).toBe(true);
		expect(messages.filter((m) => m.t === 'game.snap').length).toBeGreaterThanOrEqual(1);
	});

	it('ends the match exactly once with ranked results', () => {
		vi.useFakeTimers();
		const { room, onEnd, messages } = setup(3);
		room.addInput('a', 5);
		room.addInput('b', 2);
		room.start(Date.now());
		vi.advanceTimersByTime(100);
		expect(onEnd).toHaveBeenCalledTimes(1);
		const results = onEnd.mock.calls[0][0] as MatchResult[];
		expect(results[0].player).toBe('a');
		expect(results[0].placement).toBe(1);
		expect(messages.filter((m) => m.t === 'game.end')).toHaveLength(0); // server sends it
	});

	it('ignores inputs from non-players and after stop()', () => {
		vi.useFakeTimers();
		const { room, sim } = setup(3);
		room.addInput('intruder', 9);
		room.start(Date.now());
		room.stop();
		vi.advanceTimersByTime(100);
		expect(sim.positions.has('intruder')).toBe(false);
		expect(sim.tick).toBe(0);
	});

	it('waits until startAt before ticking', () => {
		vi.useFakeTimers();
		const now = Date.now();
		const { room, sim } = setup(10);
		room.start(now + 2_000);
		vi.advanceTimersByTime(1_000);
		expect(sim.tick).toBe(0);
		vi.advanceTimersByTime(1_500);
		expect(sim.tick).toBeGreaterThan(0);
	});
});
