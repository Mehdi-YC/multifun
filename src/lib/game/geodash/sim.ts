/**
 * GeoDash Party — deterministic multi-form simulation.
 *
 * COORDINATE CONVENTION (see level-types.ts): y grows downward, the ground
 * surface is y = 0, the air is y < 0. Player state (x, y) is the TOP-LEFT
 * corner of the 30x30 hitbox, so a grounded cube sits at y = -30.
 *
 * FORMS (switched by `portal` objects, reset to 'cube' on death):
 * - cube: jump arcs, hold-jump auto re-jump, pads + orbs.
 * - ship: hold KEY.JUMP to thrust up against gravity, |vy| clamped (no
 *   flipping); lands/slides on top of blocks and under ceilings, dies on
 *   face-first side collisions. Ignores pads and orbs.
 * - ball: tapping KEY.JUMP while pressed against a surface flips the gravity
 *   direction; rolls along whatever surface it is pressed against. Pads and
 *   speed portals apply; orbs are cube-only.
 *
 * Per tick, per player: auto-run right at BASE_SPEED * speedMult, jump on
 * KEY.JUMP (hold = auto re-jump on landing), jump buffer 4 ticks, coyote time
 * 3 ticks, pads launch, orbs give one air jump each per attempt, blocks land
 * on top / kill on side contact, spikes and saws kill, pits kill below the
 * fall line. Death = full restart at x = 0 (attempt counter++). Finish at
 * x >= level.lengthPx. The race (plan §7.3) ends on the tick the FIRST
 * player finishes — remaining players are ranked by the progress they had
 * at that moment — or when durationTicks expires, whichever comes first.
 * Finished players freeze in place so the final snapshot is clean.
 * Everything is seeded/derived from inputs only: no Math.random, no Date.
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
} from '../types';
import { KEY } from '../types';
import {
	CUBE_SIZE,
	orbBox,
	padRect,
	parseGeoDashLevel,
	spikeHitbox,
	blockSize
} from './level-types';
import type { GeoDashLevel, GeoDashMode, GeoDashObject } from './level-types';
import { getLevel } from './levels';

// ---- tuning (fixed 60Hz tick) ----

export const BASE_SPEED = 8.5;
export const JUMP_VELOCITY = -13;
export const GRAVITY = 0.8;
export const MAX_FALL_SPEED = 24;
export const JUMP_BUFFER_TICKS = 4;
export const COYOTE_TICKS = 3;
export const RESPAWN_WARMUP_TICKS = 3;
export const COUNTDOWN_TICKS = 180;
/** Player y (top) below this = fell into a pit ('fall'). */
export const FALL_Y = 260;
/** Player y (top) above this = flew out of the world ('fall'). */
export const CEIL_Y = -520;

// ship form: hold JUMP to thrust up, gravity pulls down, speed clamped.
export const SHIP_THRUST = 0.9;
export const SHIP_GRAVITY = 0.45;
export const SHIP_MAX_VY = 8;

// ball form: tapping JUMP on a surface flips gravity with a small kick.
export const BALL_FLIP_VELOCITY = 3.5;

const TAU = Math.PI * 2;

// ---- deterministic 32-bit hashing + seeded rng (FNV-1a, mulberry32) ----

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

/**
 * Stateful mulberry32 (same sequence as `mulberry32(seed)` from the engine,
 * but with explicit serializable state for snapshot/restore).
 */
class SimRng {
	state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		this.state = (this.state + 0x6d2b79f5) | 0;
		let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
}

// ---- per-player state ----

export type GeoDashPlayerState = {
	id: PlayerId;
	/** Top-left corner of the 30x30 hitbox. */
	x: number;
	y: number;
	vy: number;
	/** Current form (switched by mode portals, reset to 'cube' on death). */
	mode: GeoDashMode;
	/** +1 = normal gravity, -1 = flipped (ball form flips it). */
	gravityDir: 1 | -1;
	speedMult: number;
	onGround: boolean;
	coyote: number;
	jumpBuffer: number;
	/** Invulnerable ticks left after (re)spawn. */
	warmup: number;
	attempts: number;
	deaths: number;
	/** Furthest progress reached this attempt chain, in [0, 1]. */
	maxProgress: number;
	finished: boolean;
	finishTimeMs: number;
	/** Bitmask of orbs already used (one use per orb per attempt). */
	orbUsed: number;
	/** Bitmask of speed portals already crossed. */
	portalUsed: number;
	/** Bitmask of mode portals already crossed. */
	modeUsed: number;
	/** Last input keys (disconnected players keep their last input). */
	lastKeys: number;
	/** Cosmetic idle-animation phase drawn from the seeded rng. */
	phase: number;
};

export type GeoDashPlayerSnapshot = GeoDashPlayerState;

export type GeoDashSnapshot = {
	tick: number;
	finished: boolean;
	rngState: number;
	players: GeoDashPlayerSnapshot[];
};

/** GameSim plus a read-only view of the live player states (used by the renderer). */
export type GeoDashSim = GameSim & {
	readonly players: readonly GeoDashPlayerState[];
	readonly level: GeoDashLevel;
};

function readNumber(source: Record<string, unknown>, key: string): number {
	const v = source[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readMode(source: Record<string, unknown>): GeoDashMode {
	const v = source['mode'];
	return v === 'ship' || v === 'ball' ? v : 'cube';
}

/** Parse an untyped snapshot (e.g. from the wire). Null when malformed. */
export function parseGeoDashSnapshot(state: GameStatePatch): GeoDashSnapshot | null {
	const tick = state['tick'];
	const players = state['players'];
	if (typeof tick !== 'number' || !Array.isArray(players)) return null;
	const parsed: GeoDashPlayerSnapshot[] = [];
	for (const entry of players) {
		if (typeof entry !== 'object' || entry === null) return null;
		const p = entry as Record<string, unknown>;
		const id = p['id'];
		if (typeof id !== 'string') return null;
		parsed.push({
			id,
			x: readNumber(p, 'x'),
			y: readNumber(p, 'y'),
			vy: readNumber(p, 'vy'),
			mode: readMode(p),
			gravityDir: p['gravityDir'] === -1 ? -1 : 1,
			speedMult: readNumber(p, 'speedMult') || 1,
			onGround: p['onGround'] === true,
			coyote: readNumber(p, 'coyote'),
			jumpBuffer: readNumber(p, 'jumpBuffer'),
			warmup: readNumber(p, 'warmup'),
			attempts: readNumber(p, 'attempts'),
			deaths: readNumber(p, 'deaths'),
			maxProgress: readNumber(p, 'maxProgress'),
			finished: p['finished'] === true,
			finishTimeMs: readNumber(p, 'finishTimeMs'),
			orbUsed: readNumber(p, 'orbUsed'),
			portalUsed: readNumber(p, 'portalUsed'),
			modeUsed: readNumber(p, 'modeUsed'),
			lastKeys: readNumber(p, 'lastKeys'),
			phase: readNumber(p, 'phase')
		});
	}
	return {
		tick,
		finished: state['finished'] === true,
		rngState: readNumber(state, 'rngState') | 0,
		players: parsed
	};
}

function readLevel(config: GameConfig): GeoDashLevel {
	const override = config.options['level'];
	if (override !== undefined) {
		const parsed = parseGeoDashLevel(override);
		if (!parsed.ok) throw new Error(`geodash: invalid level override: ${parsed.errors.join('; ')}`);
		return parsed.level;
	}
	const id = typeof config.options['levelId'] === 'string' ? config.options['levelId'] : 'level-1';
	const level = getLevel(id);
	if (!level) throw new Error(`geodash: unknown level '${id}'`);
	return level;
}

type Rect = { x: number; y: number; w: number; h: number };

type Solid = Rect;

type SpikeBox = Rect;

type SawBody = { x: number; y: number; r: number };

type PadBody = Rect & { power: number };

type OrbBody = { x: number; y: number; box: Rect; index: number };

type PortalBody = { x: number; mult: number; index: number };

type ModePortalBody = { x: number; mode: GeoDashMode; index: number };

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

class GeoDashSimulation implements GameSim {
	readonly level: GeoDashLevel;
	readonly players: readonly GeoDashPlayerState[];

	private readonly states: GeoDashPlayerState[];
	private readonly solids: Solid[] = [];
	private readonly spikes: SpikeBox[] = [];
	private readonly saws: SawBody[] = [];
	private readonly pads: PadBody[] = [];
	private readonly orbs: OrbBody[] = [];
	private readonly portals: PortalBody[] = [];
	private readonly modePortals: ModePortalBody[] = [];

	private readonly rng = new SimRng(0);
	private readonly durationTicks: number;
	private readonly countdownTicks: number;
	private readonly events: GameEvent[] = [];

	private currentTick = 0;
	private done = false;

	constructor(seed: number, config: GameConfig, players: SimPlayer[]) {
		this.level = readLevel(config);
		this.durationTicks = Math.max(1, Math.floor(config.durationTicks));
		this.countdownTicks = Math.max(0, Math.floor(readCountdown(config)));

		let orbIndex = 0;
		let portalIndex = 0;
		let modePortalIndex = 0;
		for (const obj of this.level.objects as GeoDashObject[]) {
			switch (obj.type) {
				case 'block': {
					const { w, h } = blockSize(obj);
					this.solids.push({ x: obj.x, y: obj.y, w, h });
					break;
				}
				case 'spike':
					this.spikes.push(spikeHitbox(obj));
					break;
				case 'saw':
					this.saws.push({ x: obj.x, y: obj.y, r: obj.r ?? 22 });
					break;
				case 'pad':
					this.pads.push({ ...padRect(obj), power: obj.power });
					break;
				case 'orb':
					this.orbs.push({ x: obj.x, y: obj.y, box: orbBox(obj), index: orbIndex++ });
					break;
				case 'speed':
					this.portals.push({ x: obj.x, mult: obj.mult, index: portalIndex++ });
					break;
				case 'portal':
					this.modePortals.push({ x: obj.x, mode: obj.mode, index: modePortalIndex++ });
					break;
				default:
					break;
			}
		}

		this.rng.state = seed >>> 0;
		this.states = players.map((player) => {
			const state: GeoDashPlayerState = {
				id: player.id,
				x: 0,
				y: -CUBE_SIZE,
				vy: 0,
				mode: 'cube',
				gravityDir: 1,
				speedMult: 1,
				onGround: true,
				coyote: 0,
				jumpBuffer: 0,
				warmup: RESPAWN_WARMUP_TICKS,
				attempts: 1,
				deaths: 0,
				maxProgress: 0,
				finished: false,
				finishTimeMs: 0,
				orbUsed: 0,
				portalUsed: 0,
				modeUsed: 0,
				lastKeys: 0,
				phase: 0
			};
			state.phase = this.rng.next() * TAU;
			this.events.push({ kind: 'spawn', player: player.id });
			return state;
		});
		this.players = this.states;
	}

	get tick(): number {
		return this.currentTick;
	}

	/**
	 * True once the race is over: the first player finished, everyone is
	 * done, or durationTicks expired (whichever happened first).
	 */
	get finished(): boolean {
		return this.done;
	}

	tickOnce(inputs: Map<PlayerId, InputFrame>): void {
		if (this.done) return;

		// Countdown is shared by everyone: 3/2/1/0 ticks snap the match start.
		if (this.countdownTicks > 0 && this.currentTick <= this.countdownTicks) {
			const step = this.countdownTicks / 3;
			if (Number.isInteger(this.currentTick / step)) {
				this.events.push({ kind: 'countdown', value: 3 - this.currentTick / step });
			}
		}
		const frozen = this.currentTick < this.countdownTicks;

		for (const p of this.states) {
			const frame = inputs.get(p.id);
			// Disconnected players keep their last input.
			const keys = frame ? frame.keys : p.lastKeys;
			if (!p.finished && !frozen) this.updatePlayer(p, keys);
			p.lastKeys = keys;
		}

		this.currentTick++;
		// Race end (plan §7.3): the match is over the tick the FIRST player
		// crosses the finish (their `finish` event already fired above), when
		// everyone is done, or when the duration expires — whichever comes
		// first. Solo play therefore ends instantly on finish and the platform
		// gets `match-end` + results right away.
		const anyFinished = this.states.some((p) => p.finished);
		if (anyFinished || this.currentTick >= this.durationTicks) {
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
			rngState: this.rng.state,
			players: this.states.map((p) => ({ ...p }))
		};
	}

	restore(state: GameStatePatch): void {
		const snap = parseGeoDashSnapshot(state);
		if (!snap) throw new Error('geodash: invalid snapshot');
		this.currentTick = snap.tick;
		this.done = snap.finished;
		this.rng.state = snap.rngState | 0;
		const byId = new Map(snap.players.map((p) => [p.id, p]));
		for (const target of this.states) {
			const src = byId.get(target.id);
			if (!src) continue;
			Object.assign(target, src, { id: target.id });
		}
	}

	results(): MatchResult[] {
		const nowMs = this.currentTick * (1000 / 60);
		const ranked = this.states.slice().sort((a, b) => {
			if (a.finished !== b.finished) return a.finished ? -1 : 1;
			if (a.finished && a.finishTimeMs !== b.finishTimeMs) return a.finishTimeMs - b.finishTimeMs;
			if (a.maxProgress !== b.maxProgress) return b.maxProgress - a.maxProgress;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return ranked.map((p, i) => {
			const timeMs = p.finished ? p.finishTimeMs : nowMs;
			const progressPercent = Math.round(p.maxProgress * 100);
			const score = Math.max(
				0,
				Math.round(p.maxProgress * 100) + (p.finished ? 1000 : 0) - timeMs / 100
			);
			return {
				player: p.id,
				placement: i + 1,
				score: Math.round(score),
				stats: {
					attempts: p.attempts,
					deaths: p.deaths,
					progressPercent,
					timeMs: Math.round(timeMs)
				}
			};
		});
	}

	hash(): number {
		let h = FNV_OFFSET;
		h = fnvInt(h, this.currentTick);
		h = fnvByte(h, this.done ? 1 : 0);
		h = fnvInt(h, this.rng.state);
		for (const p of this.states) {
			h = fnvInt(h, quantize(p.x));
			h = fnvInt(h, quantize(p.y));
			h = fnvInt(h, quantize(p.vy));
			h = fnvInt(h, quantize(p.speedMult));
			h = fnvInt(h, quantize(p.maxProgress));
			h = fnvInt(h, quantize(p.finishTimeMs));
			h = fnvInt(h, quantize(p.phase));
			h = fnvInt(h, p.orbUsed);
			h = fnvInt(h, p.portalUsed);
			h = fnvInt(h, p.modeUsed);
			h = fnvInt(h, p.attempts);
			h = fnvInt(h, p.deaths);
			h = fnvInt(h, p.coyote);
			h = fnvInt(h, p.jumpBuffer);
			h = fnvInt(h, p.warmup);
			h = fnvInt(h, p.lastKeys);
			h = fnvByte(h, p.onGround ? 1 : 0);
			h = fnvByte(h, p.finished ? 1 : 0);
			h = fnvByte(h, p.gravityDir === -1 ? 1 : 0);
			h = fnvByte(h, p.mode === 'cube' ? 0 : p.mode === 'ship' ? 1 : 2);
		}
		return h >>> 0;
	}

	// ---- one player's tick ----

	private updatePlayer(p: GeoDashPlayerState, keys: number): void {
		const jumpHeld = (keys & KEY.JUMP) !== 0;
		const jumpPressed = jumpHeld && (p.lastKeys & KEY.JUMP) === 0;
		if (jumpPressed) p.jumpBuffer = JUMP_BUFFER_TICKS;

		// Per-form vertical intent (evaluated before gravity integrates).
		if (p.mode === 'cube') {
			// Jump intent: ground/coyote jump (hold = auto re-jump), else an orb.
			if (p.onGround || p.coyote > 0) {
				if (jumpHeld || p.jumpBuffer > 0) {
					p.vy = JUMP_VELOCITY * p.gravityDir;
					p.onGround = false;
					p.coyote = 0;
					p.jumpBuffer = 0;
				}
			} else if (jumpPressed || p.jumpBuffer > 0) {
				const orb = this.orbUnder(p);
				if (orb) {
					p.vy = JUMP_VELOCITY * p.gravityDir;
					p.jumpBuffer = 0;
					p.orbUsed |= 1 << orb.index;
					this.events.push({ kind: 'collect', player: p.id, item: 'orb' });
				}
			}
		} else if (p.mode === 'ball') {
			// Tap (edge, not hold) while pressed against a surface: flip gravity.
			if (p.onGround && (jumpPressed || p.jumpBuffer > 0)) {
				p.gravityDir = p.gravityDir === 1 ? -1 : 1;
				p.vy = BALL_FLIP_VELOCITY * p.gravityDir;
				p.onGround = false;
				p.coyote = 0;
				p.jumpBuffer = 0;
			}
		}

		const wasOnGround = p.onGround;
		if (p.mode === 'ship') {
			// Hold JUMP to thrust against gravity; clamped vertical speed.
			p.vy += (jumpHeld ? -SHIP_THRUST : SHIP_GRAVITY) * p.gravityDir;
			if (p.vy > SHIP_MAX_VY) p.vy = SHIP_MAX_VY;
			if (p.vy < -SHIP_MAX_VY) p.vy = -SHIP_MAX_VY;
		} else {
			p.vy += GRAVITY * p.gravityDir;
			if (p.vy > MAX_FALL_SPEED) p.vy = MAX_FALL_SPEED;
			if (p.vy < -MAX_FALL_SPEED) p.vy = -MAX_FALL_SPEED;
		}
		const beforeY = p.y;

		// Auto-run right; speed + mode portals trigger at their x plane.
		p.x += BASE_SPEED * p.speedMult;
		for (const portal of this.portals) {
			const bit = 1 << portal.index;
			if (p.x >= portal.x && (p.portalUsed & bit) === 0) {
				p.portalUsed |= bit;
				p.speedMult = portal.mult;
				this.events.push({ kind: 'boost', player: p.id, power: portal.mult });
			}
		}
		for (const portal of this.modePortals) {
			const bit = 1 << portal.index;
			if (p.x >= portal.x && (p.modeUsed & bit) === 0) {
				p.modeUsed |= bit;
				p.mode = portal.mode;
				if (p.mode === 'ship') {
					if (p.vy > SHIP_MAX_VY) p.vy = SHIP_MAX_VY;
					if (p.vy < -SHIP_MAX_VY) p.vy = -SHIP_MAX_VY;
				}
				this.events.push({ kind: 'transform', player: p.id, mode: portal.mode });
			}
		}

		p.y += p.vy;

		// AABB vs blocks: penetration decides. Deeper in y = land/bonk,
		// deeper in x = hit the side = death — except when the cube was still
		// above the block's top before this move (corner clip while landing or
		// walking off an edge resolves as a landing instead).
		p.onGround = false;
		let landing: Solid | null = null;
		let landingOverlap = 0;
		for (const b of this.solids) {
			const ox = Math.min(p.x + CUBE_SIZE, b.x + b.w) - Math.max(p.x, b.x);
			if (ox <= 0) continue;
			const oy = Math.min(p.y + CUBE_SIZE, b.y + b.h) - Math.max(p.y, b.y);
			if (oy <= 0) continue;
			if (oy > ox && beforeY + CUBE_SIZE > b.y + 1) {
				this.kill(p, 'block');
				return;
			}
			if (oy > landingOverlap) {
				landing = b;
				landingOverlap = oy;
			}
		}
		if (landing) {
			if (p.vy >= 0) {
				p.y = landing.y - CUBE_SIZE;
				p.onGround = true;
				// Buffered or held jump fires the instant the cube touches
				// down (the jump buffer stays valid 4 ticks before landing).
				if (p.mode === 'cube' && (jumpHeld || p.jumpBuffer > 0)) {
					p.vy = JUMP_VELOCITY * p.gravityDir;
					p.onGround = false;
					p.coyote = 0;
					p.jumpBuffer = 0;
				} else {
					p.vy = 0;
				}
			} else {
				// Pressed against the underside of a block: grounded too (the
				// ball needs this to flip gravity while ceiling-rolling).
				p.y = landing.y + landing.h;
				p.vy = 0;
				p.onGround = true;
			}
		}
		// Walked off a ledge without jumping: grace ticks (set, don't also decay).
		if (wasOnGround && !p.onGround && p.vy >= 0) p.coyote = COYOTE_TICKS;
		else if (p.coyote > 0 && !p.onGround) p.coyote--;

		// Pads launch on contact (after landing, so a pad on the floor fires).
		// The ship ignores pads: it flies.
		if (p.warmup <= 0 && p.mode !== 'ship') {
			const box = { x: p.x, y: p.y, w: CUBE_SIZE, h: CUBE_SIZE };
			for (const pad of this.pads) {
				if (overlaps(box, pad)) {
					p.vy = JUMP_VELOCITY * pad.power * p.gravityDir;
					p.onGround = false;
					p.coyote = 0;
					this.events.push({ kind: 'boost', player: p.id, power: pad.power });
					break;
				}
			}
		}

		if (p.warmup <= 0) {
			const box = { x: p.x, y: p.y, w: CUBE_SIZE, h: CUBE_SIZE };
			for (const spike of this.spikes) {
				if (overlaps(box, spike)) {
					this.kill(p, 'spike');
					return;
				}
			}
			for (const saw of this.saws) {
				const cx = Math.max(box.x, Math.min(saw.x, box.x + box.w));
				const cy = Math.max(box.y, Math.min(saw.y, box.y + box.h));
				const dx = saw.x - cx;
				const dy = saw.y - cy;
				if (dx * dx + dy * dy < saw.r * 0.85 * (saw.r * 0.85)) {
					this.kill(p, 'saw');
					return;
				}
			}
		}

		if (p.y > FALL_Y || p.y < CEIL_Y) {
			this.kill(p, 'fall');
			return;
		}

		const progress = Math.min(1, Math.max(0, p.x / this.level.lengthPx));
		if (progress > p.maxProgress) p.maxProgress = progress;

		if (p.x >= this.level.lengthPx) {
			p.finished = true;
			p.finishTimeMs = Math.round(this.currentTick * (1000 / 60));
			this.events.push({ kind: 'finish', player: p.id, timeMs: p.finishTimeMs });
		}

		// Invulnerable warmup ticks (decremented last so it covers exactly
		// RESPAWN_WARMUP_TICKS full ticks of hazard checks).
		if (p.warmup > 0) p.warmup--;
		if (p.jumpBuffer > 0) p.jumpBuffer--;
	}

	private orbUnder(p: GeoDashPlayerState): OrbBody | null {
		const box = { x: p.x, y: p.y, w: CUBE_SIZE, h: CUBE_SIZE };
		for (const orb of this.orbs) {
			if ((p.orbUsed & (1 << orb.index)) !== 0) continue;
			if (overlaps(box, orb.box)) return orb;
		}
		return null;
	}

	/** Death: full restart at x = 0 with a short invulnerable warmup. */
	private kill(p: GeoDashPlayerState, cause: 'spike' | 'block' | 'saw' | 'fall'): void {
		p.deaths++;
		p.attempts++;
		this.events.push({ kind: 'death', player: p.id, cause });
		p.x = 0;
		p.y = -CUBE_SIZE;
		p.vy = 0;
		p.mode = 'cube';
		p.onGround = true;
		p.coyote = 0;
		p.jumpBuffer = 0;
		p.speedMult = 1;
		p.gravityDir = 1;
		p.orbUsed = 0;
		p.portalUsed = 0;
		p.modeUsed = 0;
		p.warmup = RESPAWN_WARMUP_TICKS;
		p.phase = this.rng.next() * TAU;
		this.events.push({ kind: 'respawn', player: p.id });
	}
}

function readCountdown(config: GameConfig): number {
	const v = config.options['countdownTicks'];
	return typeof v === 'number' && Number.isFinite(v) ? v : COUNTDOWN_TICKS;
}

export function createGeodashSim(
	seed: number,
	config: GameConfig,
	players: SimPlayer[]
): GeoDashSim {
	return new GeoDashSimulation(seed, config, players);
}
