import type {
	GameConfig,
	GameEvent,
	GameId,
	GameSim,
	InputFrame,
	MatchResult,
	SimPlayer
} from '$lib/game/types';
import type { ServerMessage } from '$lib/net/protocol';

const SNAPSHOT_EVERY = 3; // 20Hz snapshots at a 60Hz tick

interface GameRoomOpts {
	matchId: string;
	gameId: GameId;
	sim: GameSim;
	config: GameConfig;
	players: SimPlayer[];
	broadcast: (msg: ServerMessage) => void;
	onEnd: (results: MatchResult[]) => void;
}

/**
 * Authoritative match simulation. Runs the deterministic sim on a fixed
 * timestep from the latest inputs of each player, broadcasts events and
 * snapshots, and reports final results exactly once.
 */
export class GameRoom {
	readonly matchId: string;
	readonly gameId: GameId;
	private readonly sim: GameSim;
	private readonly config: GameConfig;
	private readonly players: SimPlayer[];
	private readonly broadcast: (msg: ServerMessage) => void;
	private readonly onEnd: (results: MatchResult[]) => void;

	private inputs = new Map<string, InputFrame>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private startTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshotCounter = 0;
	private stopped = false;
	private ended = false;

	constructor(opts: GameRoomOpts) {
		this.matchId = opts.matchId;
		this.gameId = opts.gameId;
		this.sim = opts.sim;
		this.config = opts.config;
		this.players = opts.players;
		this.broadcast = opts.broadcast;
		this.onEnd = opts.onEnd;
	}

	get playerIds(): Set<string> {
		return new Set(this.players.map((p) => p.id));
	}

	start(startAt: number): void {
		const delay = Math.max(0, startAt - Date.now());
		this.startTimer = setTimeout(() => this.begin(), delay);
	}

	private begin(): void {
		if (this.stopped) return;
		const interval = 1000 / this.config.tickRate;
		this.timer = setInterval(() => this.step(), interval);
	}

	addInput(playerId: string, keys: number): void {
		if (this.stopped || this.ended) return;
		if (!this.playerIds.has(playerId)) return;
		this.inputs.set(playerId, { keys });
	}

	private step(): void {
		if (this.ended) return;
		this.sim.tickOnce(this.inputs);
		const tick = this.sim.tick;
		const events = this.sim.drainEvents();
		for (const ev of events) {
			this.broadcast({ t: 'game.event', d: { matchId: this.matchId, tick, ev: ev as GameEvent } });
		}
		if (++this.snapshotCounter % SNAPSHOT_EVERY === 0) {
			this.broadcast({
				t: 'game.snap',
				d: { matchId: this.matchId, tick, state: this.sim.snapshot() }
			});
		}
		if (this.sim.finished) this.finish();
	}

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.clearTimers();
		// final snapshot so clients converge before results
		this.broadcast({
			t: 'game.snap',
			d: { matchId: this.matchId, tick: this.sim.tick, state: this.sim.snapshot() }
		});
		this.broadcast({
			t: 'game.event',
			d: { matchId: this.matchId, tick: this.sim.tick, ev: { kind: 'match-end' } }
		});
		const results = this.sim.results();
		this.onEnd(results);
	}

	/** Abort (e.g. everyone left). */
	stop(): void {
		this.stopped = true;
		this.clearTimers();
	}

	private clearTimers(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.startTimer) clearTimeout(this.startTimer);
		this.timer = null;
		this.startTimer = null;
	}
}
