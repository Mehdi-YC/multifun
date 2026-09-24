/**
 * Echo Arena — deterministic stub simulation proving the netcode pipeline.
 *
 * Each player is a square in a 480x270 arena driven by their InputFrame:
 * accel/decel, max speed, walls bounce. Distance (|dx| + |dy|) is the score.
 * No Date, no Math.random: only fixed-timestep math and the seeded rng used
 * once for spawn scatter.
 */
import type {
	GameConfig,
	GameEvent,
	GameSim,
	GameStatePatch,
	InputFrame,
	MatchResult,
	PlayerId,
	SimPlayer
} from '../../types';
import { EMPTY_INPUT, KEY } from '../../types';
import { approach, integrate } from '../../engine/fixed';
import { mulberry32 } from '../../engine/rng';

export const ECHO_ARENA_WIDTH = 480;
export const ECHO_ARENA_HEIGHT = 270;
export const ECHO_PLAYER_SIZE = 12;

const HALF = ECHO_PLAYER_SIZE / 2;
const BOOST_ON = 0.99; // fraction of max speed that triggers a boost event
const BOOST_OFF = 0.86; // fraction of max speed that re-arms boost detection

export type EchoPlayerState = {
	id: PlayerId;
	x: number;
	y: number;
	vx: number;
	vy: number;
	distance: number;
	boosted: boolean;
	boosts: number;
};

export type EchoPlayerSnapshot = EchoPlayerState;

export type EchoSnapshot = {
	tick: number;
	finished: boolean;
	players: EchoPlayerSnapshot[];
};

/** GameSim plus a read-only view of the live states (used by the renderer). */
export type EchoSim = GameSim & {
	readonly players: readonly EchoPlayerState[];
};

type Tuning = {
	accel: number;
	friction: number;
	maxSpeed: number;
	bounce: number;
};

const DEFAULT_TUNING: Tuning = { accel: 900, friction: 1200, maxSpeed: 170, bounce: 0.85 };

function numOption(options: Record<string, unknown>, key: string, fallback: number): number {
	const v = options[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readTuning(config: GameConfig): Tuning {
	return {
		accel: numOption(config.options, 'accel', DEFAULT_TUNING.accel),
		friction: numOption(config.options, 'friction', DEFAULT_TUNING.friction),
		maxSpeed: numOption(config.options, 'maxSpeed', DEFAULT_TUNING.maxSpeed),
		bounce: numOption(config.options, 'bounce', DEFAULT_TUNING.bounce)
	};
}

// ---- deterministic 32-bit hashing (FNV-1a over quantized state) ----

const FNV_OFFSET = 0x811c9dc5;

function fnvByte(h: number, byte: number): number {
	return Math.imul(h ^ (byte & 0xff), 0x01000193);
}

function fnvInt(h: number, value: number): number {
	const n = value | 0;
	let out = fnvByte(h, n & 0xff);
	out = fnvByte(out, (n >>> 8) & 0xff);
	out = fnvByte(out, (n >>> 16) & 0xff);
	out = fnvByte(out, (n >>> 24) & 0xff);
	return out;
}

function quantize(value: number): number {
	return Math.round(value * 1000);
}

// ---- snapshot parsing (snapshots arrive as untyped JSON over the wire) ----

function readNumber(source: Record<string, unknown>, key: string): number {
	const v = source[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse an untyped snapshot (e.g. from the wire). Null when malformed. */
export function parseEchoSnapshot(state: GameStatePatch): EchoSnapshot | null {
	const tick = state['tick'];
	const players = state['players'];
	if (typeof tick !== 'number' || !Array.isArray(players)) return null;
	const parsed: EchoPlayerSnapshot[] = [];
	for (const entry of players) {
		if (typeof entry !== 'object' || entry === null) return null;
		const p = entry as Record<string, unknown>;
		const id = p['id'];
		if (typeof id !== 'string') return null;
		parsed.push({
			id,
			x: readNumber(p, 'x'),
			y: readNumber(p, 'y'),
			vx: readNumber(p, 'vx'),
			vy: readNumber(p, 'vy'),
			distance: readNumber(p, 'distance'),
			boosted: p['boosted'] === true,
			boosts: readNumber(p, 'boosts')
		});
	}
	return {
		tick,
		finished: state['finished'] === true,
		players: parsed
	};
}

class EchoSimulation implements GameSim {
	private readonly states: EchoPlayerState[] = [];
	private readonly tuning: Tuning;
	private readonly dt: number;
	private readonly durationTicks: number;
	private readonly events: GameEvent[] = [];

	private currentTick = 0;
	private done = false;

	constructor(seed: number, config: GameConfig, players: SimPlayer[]) {
		this.tuning = readTuning(config);
		this.dt = 1 / config.tickRate;
		this.durationTicks = Math.max(1, Math.floor(config.durationTicks));

		// Seeded spawn scatter; the rng is never used again, so snapshot/restore
		// never has to capture rng state.
		const rng = mulberry32(seed >>> 0);
		for (const player of players) {
			const margin = 40;
			this.states.push({
				id: player.id,
				x: margin + rng() * (ECHO_ARENA_WIDTH - margin * 2),
				y: margin + rng() * (ECHO_ARENA_HEIGHT - margin * 2),
				vx: 0,
				vy: 0,
				distance: 0,
				boosted: false,
				boosts: 0
			});
			this.events.push({ kind: 'spawn', player: player.id });
		}
	}

	get tick(): number {
		return this.currentTick;
	}

	get finished(): boolean {
		return this.done;
	}

	get players(): readonly EchoPlayerState[] {
		return this.states;
	}

	tickOnce(inputs: Map<PlayerId, InputFrame>): void {
		if (this.done) return;

		for (const p of this.states) {
			const frame = inputs.get(p.id) ?? EMPTY_INPUT;
			const keys = frame.keys;
			const ax = ((keys & KEY.RIGHT) !== 0 ? 1 : 0) - ((keys & KEY.LEFT) !== 0 ? 1 : 0);
			const ay = ((keys & KEY.DOWN) !== 0 ? 1 : 0) - ((keys & KEY.UP) !== 0 ? 1 : 0);

			if (ax !== 0 || ay !== 0) {
				p.vx += ax * this.tuning.accel * this.dt;
				p.vy += ay * this.tuning.accel * this.dt;
			} else {
				p.vx = approach(p.vx, 0, this.tuning.friction * this.dt);
				p.vy = approach(p.vy, 0, this.tuning.friction * this.dt);
			}

			// Clamp speed to max (explicit ordering: magnitude first, then scale).
			const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
			if (speed > this.tuning.maxSpeed) {
				const scale = this.tuning.maxSpeed / speed;
				p.vx *= scale;
				p.vy *= scale;
			}

			// Explicit-order integration; the same products feed distance.
			const dx = integrate(0, p.vx, this.dt);
			const dy = integrate(0, p.vy, this.dt);
			p.x = integrate(p.x, p.vx, this.dt);
			p.y = integrate(p.y, p.vy, this.dt);
			p.distance += Math.abs(dx) + Math.abs(dy);

			// Walls bounce.
			if (p.x < HALF) {
				p.x = HALF;
				p.vx = -p.vx * this.tuning.bounce;
			} else if (p.x > ECHO_ARENA_WIDTH - HALF) {
				p.x = ECHO_ARENA_WIDTH - HALF;
				p.vx = -p.vx * this.tuning.bounce;
			}
			if (p.y < HALF) {
				p.y = HALF;
				p.vy = -p.vy * this.tuning.bounce;
			} else if (p.y > ECHO_ARENA_HEIGHT - HALF) {
				p.y = ECHO_ARENA_HEIGHT - HALF;
				p.vy = -p.vy * this.tuning.bounce;
			}

			// Boost fires when a player reaches max speed (edge-triggered).
			const nowSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
			if (!p.boosted && nowSpeed >= this.tuning.maxSpeed * BOOST_ON) {
				p.boosted = true;
				p.boosts++;
				this.events.push({ kind: 'boost', player: p.id, power: 1 });
			} else if (p.boosted && nowSpeed <= this.tuning.maxSpeed * BOOST_OFF) {
				p.boosted = false;
			}
		}

		this.currentTick++;
		if (this.currentTick >= this.durationTicks) {
			this.done = true;
			this.events.push({ kind: 'match-end' });
		}
	}

	drainEvents(): GameEvent[] {
		return this.events.splice(0, this.events.length);
	}

	snapshot(): GameStatePatch {
		return {
			tick: this.currentTick,
			finished: this.done,
			players: this.states.map((p) => ({
				id: p.id,
				x: p.x,
				y: p.y,
				vx: p.vx,
				vy: p.vy,
				distance: p.distance,
				boosted: p.boosted,
				boosts: p.boosts
			}))
		};
	}

	restore(state: GameStatePatch): void {
		const snap = parseEchoSnapshot(state);
		if (!snap) throw new Error('echo: invalid snapshot');
		this.currentTick = snap.tick;
		this.done = snap.finished;
		const byId = new Map(snap.players.map((p) => [p.id, p]));
		for (const target of this.states) {
			const src = byId.get(target.id);
			if (!src) continue;
			target.x = src.x;
			target.y = src.y;
			target.vx = src.vx;
			target.vy = src.vy;
			target.distance = src.distance;
			target.boosted = src.boosted;
			target.boosts = src.boosts;
		}
	}

	results(): MatchResult[] {
		const ranked = this.states.slice().sort((a, b) => {
			if (b.distance !== a.distance) return b.distance - a.distance;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return ranked.map((p, i) => ({
			player: p.id,
			placement: i + 1,
			score: Math.round(p.distance),
			stats: { distance: Math.round(p.distance), boosts: p.boosts }
		}));
	}

	hash(): number {
		let h = FNV_OFFSET;
		h = fnvInt(h, this.currentTick);
		h = fnvByte(h, this.done ? 1 : 0);
		for (const p of this.states) {
			h = fnvInt(h, quantize(p.x));
			h = fnvInt(h, quantize(p.y));
			h = fnvInt(h, quantize(p.vx));
			h = fnvInt(h, quantize(p.vy));
			h = fnvInt(h, quantize(p.distance));
			h = fnvInt(h, p.boosts);
			h = fnvByte(h, p.boosted ? 1 : 0);
		}
		return h >>> 0;
	}
}

export function createEchoSim(seed: number, config: GameConfig, players: SimPlayer[]): EchoSim {
	return new EchoSimulation(seed, config, players);
}
