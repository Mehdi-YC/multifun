/**
 * Turbo Kart — deterministic top-down kart racing simulation (fixed 60Hz).
 *
 * Rules in one paragraph: 2-8 racers line up on the grid and race
 * `config.options.laps` laps (default 3) around a closed circuit. The heart of
 * the handling is the DRIFT: hold KEY.DRIFT while turning at speed to slide —
 * charging a mini-turbo (60 ticks blue, 120 orange, 180 purple) that fires on
 * release at +15/25/40% speed. Boost pads, ramp tricks, slipstreaming and
 * respawn boosts layer more speed on top; items (mushroom/oil/missile/shield/
 * lightning) come from item boxes with weights that favor trailing karts. Walls
 * are soft (speed loss + steering assist back onto the racing line), a head-on
 * crash spins you out for 30 ticks, and falling in water / getting stuck / going
 * far off the spline auto-respawns you at the last checkpoint with a 1.5s
 * boost. Placement is centerline progress; crossing every checkpoint gate in
 * order is the only way to complete a lap (cutting is impossible).
 *
 * Events emitted (existing GameEvent kinds only — nothing new on the wire):
 * `spawn` (all racers at construction), `countdown` (3/2/1/GO), `lap`
 * {player, lap, timeMs} per completed lap (timeMs = that lap's split), `boost`
 * {player, power} for pads/mini-turbos/tricks/slipstream/mushroom/respawn,
 * `collect` {item: 'itembox' | <rolled item>} on item box grabs, `hit`
 * {player, by, force} on missile/oil/hazard/spin contact (force 0 = shield
 * absorbed it, force 1 = spin-out), `finish` {player, timeMs} (race time
 * INCLUDING the countdown), `respawn` and `match-end`.
 *
 * Determinism: no Date, no Math.random — one stateful mulberry32 seeded from
 * `seed` (item rolls, spin direction, AI jitter; state captured by
 * snapshot/restore). Moving hazards are pure functions of the tick. Headings
 * are continuous floats in radians (0 = +x, clockwise with the y-down axis),
 * interpolated with shortest-path wrapping on the client (see `interp.ts`).
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
import { clamp } from '../engine/fixed';
import {
	TILE_SIZE,
	getTrack,
	hazardAt,
	isOffRoadTile,
	isSolidTile,
	nearestSpline,
	tileAt,
	tileAtPx,
	type Track
} from './track';
import { angleDelta } from './interp';
import { aiDecide, aiRubberBand, type AiDifficulty, type AiState } from './ai';

// ---- tuning (fixed 60Hz tick; speeds in px/tick, accel in px/tick^2) ----

/** Kart collision half-extent (14x14 box; the sprite is chunkier). */
export const KART_HALF = 7;
/** Top speed on open road before boost/shrink scaling. */
export const BASE_MAX_SPEED = 3.4;
/** Gas acceleration. */
export const ACCEL = 0.075;
/** Brake / off-throttle deceleration. */
export const BRAKE = 0.16;
/** Reverse speed cap. */
export const REVERSE_MAX = 1.3;
/** Steering rate in radians per tick at full steering grip (~3.1 deg). */
export const STEER_RATE = 0.055;
/** Steering multiplier while drifting (tighter effective steering). */
export const DRIFT_STEER_MULT = 1.35;
/** Steering floor at low speed (grip is worse when barely moving). */
export const MIN_STEER_SCALE = 0.35;
/** Speed at which steering reaches its full rate. */
export const STEER_FULL_SPEED = 2.2;
/** Lateral velocity retention per tick on road. */
export const GRIP_ROAD = 0.86;
/** Lateral retention on ice (Frostbite Falls): almost none. */
export const GRIP_ICE = 0.985;
/** Lateral retention while drifting. */
export const GRIP_DRIFT = 0.97;
/** Lateral retention off-road. */
export const GRIP_OFFROAD = 0.9;
/** Outward slide pushed into the kart each tick while drifting. */
export const DRIFT_PUSH = 0.055;
/** Min speed (px/tick) to hold a drift. */
export const DRIFT_MIN_SPEED = 1.6;
/** Min speed to hold a drift right after a hop (hops initiate drifts easily). */
export const DRIFT_MIN_SPEED_HOP = 0.6;
/** Ticks of drift charge per spark tier (60 = blue, 120 = orange, 180 = purple). */
export const DRIFT_TIER_TICKS = 60;
/** Mini-turbo duration in ticks per tier (0/0.5s/0.9s/1.4s). */
export const MINITURBO_TICKS = [0, 30, 54, 84] as const;
/** Mini-turbo speed bonus per tier (+0/15/25/40%). */
export const MINITURBO_POWER = [0, 0.15, 0.25, 0.4] as const;
/** Off-road speed multiplier (~50%). */
export const OFFROAD_MULT = 0.5;
/** Curb (rumble strip) speed multiplier. */
export const CURB_MULT = 0.85;
/** Ice speed multiplier (slippery but slightly slower). */
export const ICE_MULT = 0.9;
/** Speed multiplier while shrunken by lightning. */
export const SHRINK_MULT = 0.6;
/** Hop vertical velocity (small hop; initiates drifts easily). */
export const HOP_VZ = 1.9;
/** Ramp launch vertical velocity base (scales with speed). */
export const RAMP_VZ = 2.2;
/** Gravity applied to airborne karts. */
export const GRAVITY = 0.22;
/** Ticks after landing before another ramp may launch (no re-launch). */
export const LAND_COOLDOWN = 18;
/** Min |speed| to launch off a ramp. */
export const RAMP_MIN_SPEED = 1.2;
/** Trick landing boost (KEY.JUMP in the air = trick spin). */
export const TRICK_TICKS = 42;
export const TRICK_POWER = 0.2;
/** Boost pad effect. */
export const BOOST_PAD_TICKS = 48;
export const BOOST_PAD_POWER = 0.4;
/** Mushroom boost. */
export const MUSHROOM_TICKS = 54;
export const MUSHROOM_POWER = 0.3;
/** Respawn boost (1.5s). */
export const RESPAWN_BOOST_TICKS = 90;
export const RESPAWN_BOOST_POWER = 0.25;
/** Rocket-start boost (KEY.UP pressed within the countdown window at GO). */
export const ROCKET_WINDOW = 12;
export const ROCKET_TICKS = 48;
export const ROCKET_POWER = 0.3;
/** Slipstream: cone half-angle (rad) and range (px) to draft a rival. */
export const SLIPSTREAM_CONE = 0.5;
export const SLIPSTREAM_RANGE = 110;
/** Ticks of drafting before the slipstream kicks in. */
export const SLIPSTREAM_TICKS = 40;
/** Passive speed bonus while drafting. */
export const SLIPSTREAM_PASSIVE = 0.1;
/** Burst boost granted when the draft ends. */
export const SLIPSTREAM_BURST_TICKS = 36;
export const SLIPSTREAM_BURST_POWER = 0.15;
/** Spin-out duration (crashes, oil, missiles, hazards). */
export const SPIN_TICKS = 30;
/** Shield bubble duration (blocks exactly one hit). */
export const SHIELD_TICKS = 480;
/** Lightning shrink/slow duration. */
export const LIGHTNING_TICKS = 180;
/** Item box respawn delay. */
export const ITEM_BOX_RESPAWN_TICKS = 300;
/** Distance that grabs an item box. */
export const ITEM_BOX_RADIUS = 14;
/** Missile tuning. */
export const MISSILE_SPEED = 5.2;
export const MISSILE_TURN = 0.12;
export const MISSILE_LIFE = 300;
/** Oil slick lifetime and hit radius. */
export const SLICK_LIFE = 480;
export const SLICK_RADIUS = 11;
/** Speed that turns a wall hit into a crash (spin-out) instead of a soft bump. */
export const CRASH_SPEED = 2.6;
/** Speed multiplier after a soft wall bump. */
export const SOFT_WALL_MULT = 0.55;
/** Steering assist back toward the racing line after a wall bump (rad/tick). */
export const WALL_STEER_ASSIST = 0.22;
/** Nearest-spline distance that counts as "far out" (auto-respawn). */
export const FALL_DISTANCE = 150;
/** Ticks of near-standstill before an auto-respawn (1.5s). */
export const RESPAWN_STUCK_TICKS = 90;
/** Default shared countdown length in ticks (3/2/1/GO). */
export const DEFAULT_COUNTDOWN_TICKS = 150;

/** Spark tier for a drift charge (0 = none, 1 = blue, 2 = orange, 3 = purple). */
export function driftTier(charge: number): number {
	return Math.min(3, Math.floor(charge / DRIFT_TIER_TICKS));
}

// ---- items ----

export type ItemKind = 'mushroom' | 'oil' | 'missile' | 'shield' | 'lightning';

export const ITEM_KINDS: readonly ItemKind[] = [
	'mushroom',
	'oil',
	'missile',
	'shield',
	'lightning'
];

export type ItemWeights = Record<ItemKind | 'nothing', number>;

/**
 * Item box odds by race position: the leader mostly gets junk (nothing/oil),
 * the tail gets mushrooms and missiles, lightning is rare and trailer-only.
 * `place` is 1-based; `total` is the racer count.
 */
export function itemWeights(place: number, total: number): ItemWeights {
	const frac = total > 1 ? (clamp(place, 1, total) - 1) / (total - 1) : 1;
	if (place === 1) {
		return { nothing: 45, oil: 32, mushroom: 10, shield: 13, missile: 0, lightning: 0 };
	}
	if (frac < 0.34) {
		return { nothing: 22, oil: 24, mushroom: 18, shield: 14, missile: 18, lightning: 4 };
	}
	if (frac < 0.67) {
		return { nothing: 10, oil: 14, mushroom: 24, shield: 13, missile: 30, lightning: 9 };
	}
	return { nothing: 4, oil: 6, mushroom: 28, shield: 12, missile: 40, lightning: 10 };
}

/** Roll one item box outcome (null = nothing). Seeded rng only. */
export function rollItem(place: number, total: number, rng: () => number): ItemKind | null {
	const weights = itemWeights(place, total);
	let sum = 0;
	for (const kind of ITEM_KINDS) sum += weights[kind];
	sum += weights.nothing;
	let draw = rng() * sum;
	for (const kind of ITEM_KINDS) {
		draw -= weights[kind];
		if (draw <= 0) return kind;
	}
	return null;
}

// ---- state ----

export type KartState = {
	id: PlayerId;
	/** Kart center in world px. */
	x: number;
	y: number;
	/** Continuous heading in radians; 0 = +x, grows clockwise (y down). */
	angle: number;
	/** Height above ground (hop/ramp air). 0 = grounded. */
	z: number;
	vz: number;
	/** Ticks until a ramp may launch again after a landing. */
	airCooldown: number;
	/** Forward speed along the heading (px/tick). */
	speed: number;
	/** Lateral slip velocity (px/tick; + = to the right of the heading). */
	lateral: number;
	/** Completed laps (0..laps). */
	lap: number;
	/** Next expected checkpoint gate index (0 = start/finish line). */
	checkpoint: number;
	/** Previous sign of the gate-crossing function for `checkpoint`. */
	gateSign: number;
	/** Nearest-spline search hint (sample index). */
	splineHint: number;
	/** Race progress in px: lap * lapLength + arc position. Placement order. */
	progress: number;
	/** Drift state (see the drift tuning block). */
	drifting: boolean;
	driftDir: number;
	driftCharge: number;
	/** Hop ticks left (drift initiation is easier during a hop). */
	hopTicks: number;
	/** Spin-out ticks left and visual spin direction. */
	spinTimer: number;
	spinDir: number;
	/** Active boost: remaining ticks and speed bonus fraction. */
	boostTimer: number;
	boostPower: number;
	/** Held item (null = empty slot). */
	item: ItemKind | null;
	/** Shield bubble ticks left (absorbs exactly one hit). */
	shieldTimer: number;
	/** Lightning shrink/slow ticks left. */
	shrinkTimer: number;
	/** Slipstream: consecutive ticks spent drafting. */
	draftTicks: number;
	/** Ticks spent near-standstill (auto-respawn when it hits the limit). */
	stuckTicks: number;
	/** Trick spin armed while airborne (boost on landing). */
	trick: boolean;
	/** Tick of the last KEY.UP press (rocket-start timing window). */
	upPressTick: number;
	// race bookkeeping
	lapStartTick: number;
	bestLapMs: number;
	lastLapMs: number;
	itemsUsed: number;
	driftBoosts: number;
	finished: boolean;
	finishTimeMs: number;
	/** 1-based placement (updated every tick). */
	place: number;
	/** Last input; disconnected players keep driving with it. */
	lastKeys: number;
	/** True for sim-owned AI karts. */
	ai: boolean;
};

export type MissileState = {
	/** Stable identity for snapshot interpolation on the client. */
	id: number;
	owner: PlayerId;
	x: number;
	y: number;
	angle: number;
	/** Homing target (null = flies straight). */
	targetId: PlayerId | null;
	/** Ticks left to live. */
	life: number;
};

export type SlickState = {
	id: number;
	owner: PlayerId;
	x: number;
	y: number;
	life: number;
};

export type ItemBoxState = {
	x: number;
	y: number;
	/** Ticks until the box respawns; 0 = active and grabbable. */
	respawn: number;
};

export type KartSnapshot = {
	tick: number;
	finished: boolean;
	rngState: number;
	nextEntityId: number;
	karts: KartState[];
	missiles: MissileState[];
	slicks: SlickState[];
	boxes: ItemBoxState[];
	/** Per breakable wall tile: 1 = intact, 0 = smashed. */
	breakableHp: number[];
	aiStates: AiState[];
};

/** GameSim plus read-only live views used by tests and the renderer. */
export type KartSim = GameSim & {
	readonly track: Track;
	readonly karts: readonly KartState[];
	readonly missiles: readonly MissileState[];
	readonly slicks: readonly SlickState[];
	readonly boxes: readonly ItemBoxState[];
	readonly breakableHp: readonly number[];
	readonly aiStates: readonly AiState[];
	readonly countdownTicks: number;
	readonly laps: number;
};

// ---- deterministic helpers (same FNV/mulberry32 pattern as Pixel Tanks) ----

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

function numOption(options: Record<string, unknown>, key: string, fallback: number): number {
	const v = options[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strOption(options: Record<string, unknown>, key: string, fallback: string): string {
	const v = options[key];
	return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function readNumber(source: Record<string, unknown>, key: string): number {
	const v = source[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readBool(source: Record<string, unknown>, key: string): boolean {
	return source[key] === true;
}

const ITEM_LOOKUP: Record<string, ItemKind> = {
	mushroom: 'mushroom',
	oil: 'oil',
	missile: 'missile',
	shield: 'shield',
	lightning: 'lightning'
};

function readKart(source: Record<string, unknown>): KartState | null {
	const id = source['id'];
	if (typeof id !== 'string') return null;
	const itemRaw = source['item'];
	const item = typeof itemRaw === 'string' ? (ITEM_LOOKUP[itemRaw] ?? null) : null;
	return {
		id,
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		angle: readNumber(source, 'angle'),
		z: readNumber(source, 'z'),
		vz: readNumber(source, 'vz'),
		airCooldown: readNumber(source, 'airCooldown'),
		speed: readNumber(source, 'speed'),
		lateral: readNumber(source, 'lateral'),
		lap: readNumber(source, 'lap'),
		checkpoint: readNumber(source, 'checkpoint'),
		gateSign: readNumber(source, 'gateSign'),
		splineHint: readNumber(source, 'splineHint'),
		progress: readNumber(source, 'progress'),
		drifting: readBool(source, 'drifting'),
		driftDir: readNumber(source, 'driftDir'),
		driftCharge: readNumber(source, 'driftCharge'),
		hopTicks: readNumber(source, 'hopTicks'),
		spinTimer: readNumber(source, 'spinTimer'),
		spinDir: readNumber(source, 'spinDir'),
		boostTimer: readNumber(source, 'boostTimer'),
		boostPower: readNumber(source, 'boostPower'),
		item,
		shieldTimer: readNumber(source, 'shieldTimer'),
		shrinkTimer: readNumber(source, 'shrinkTimer'),
		draftTicks: readNumber(source, 'draftTicks'),
		stuckTicks: readNumber(source, 'stuckTicks'),
		trick: readBool(source, 'trick'),
		upPressTick: readNumber(source, 'upPressTick'),
		lapStartTick: readNumber(source, 'lapStartTick'),
		bestLapMs: readNumber(source, 'bestLapMs'),
		lastLapMs: readNumber(source, 'lastLapMs'),
		itemsUsed: readNumber(source, 'itemsUsed'),
		driftBoosts: readNumber(source, 'driftBoosts'),
		finished: readBool(source, 'finished'),
		finishTimeMs: readNumber(source, 'finishTimeMs'),
		place: readNumber(source, 'place'),
		lastKeys: readNumber(source, 'lastKeys'),
		ai: readBool(source, 'ai')
	};
}

function readMissile(source: Record<string, unknown>): MissileState | null {
	if (typeof source['owner'] !== 'string') return null;
	const target = source['targetId'];
	return {
		id: readNumber(source, 'id'),
		owner: source['owner'],
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		angle: readNumber(source, 'angle'),
		targetId: typeof target === 'string' ? target : null,
		life: readNumber(source, 'life')
	};
}

function readSlick(source: Record<string, unknown>): SlickState | null {
	if (typeof source['owner'] !== 'string') return null;
	return {
		id: readNumber(source, 'id'),
		owner: source['owner'],
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		life: readNumber(source, 'life')
	};
}

function readBox(source: Record<string, unknown>): ItemBoxState | null {
	if (typeof source['x'] !== 'number') return null;
	return {
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		respawn: readNumber(source, 'respawn')
	};
}

function readAiState(source: Record<string, unknown>): AiState | null {
	if (typeof source['id'] !== 'string') return null;
	return {
		id: source['id'],
		itemTimer: readNumber(source, 'itemTimer'),
		driftTimer: readNumber(source, 'driftTimer'),
		wobble: readNumber(source, 'wobble'),
		wobbleTimer: readNumber(source, 'wobbleTimer')
	};
}

/** Parse an untyped snapshot (e.g. from the wire). Null when malformed. */
export function parseKartSnapshot(state: GameStatePatch): KartSnapshot | null {
	const tick = state['tick'];
	if (typeof tick !== 'number') return null;
	const rawKarts = state['karts'];
	const rawMissiles = state['missiles'];
	const rawSlicks = state['slicks'];
	const rawBoxes = state['boxes'];
	const rawHp = state['breakableHp'];
	if (
		!Array.isArray(rawKarts) ||
		!Array.isArray(rawMissiles) ||
		!Array.isArray(rawSlicks) ||
		!Array.isArray(rawBoxes) ||
		!Array.isArray(rawHp)
	) {
		return null;
	}
	const karts: KartState[] = [];
	for (const entry of rawKarts) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readKart(entry as Record<string, unknown>);
		if (!parsed) return null;
		karts.push(parsed);
	}
	const missiles: MissileState[] = [];
	for (const entry of rawMissiles) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readMissile(entry as Record<string, unknown>);
		if (!parsed) return null;
		missiles.push(parsed);
	}
	const slicks: SlickState[] = [];
	for (const entry of rawSlicks) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readSlick(entry as Record<string, unknown>);
		if (!parsed) return null;
		slicks.push(parsed);
	}
	const boxes: ItemBoxState[] = [];
	for (const entry of rawBoxes) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readBox(entry as Record<string, unknown>);
		if (!parsed) return null;
		boxes.push(parsed);
	}
	const breakableHp: number[] = [];
	for (const entry of rawHp) {
		if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
		breakableHp.push(entry);
	}
	// AI states are optional on the wire (older payloads predate them).
	const rawAi = state['aiStates'] ?? [];
	if (!Array.isArray(rawAi)) return null;
	const aiStates: AiState[] = [];
	for (const entry of rawAi) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readAiState(entry as Record<string, unknown>);
		if (!parsed) return null;
		aiStates.push(parsed);
	}
	return {
		tick,
		finished: state['finished'] === true,
		rngState: readNumber(state, 'rngState'),
		nextEntityId: readNumber(state, 'nextEntityId'),
		karts,
		missiles,
		slicks,
		boxes,
		breakableHp,
		aiStates
	};
}

// ---- simulation ----

class KartSimulation implements KartSim {
	readonly track: Track;
	readonly countdownTicks: number;
	readonly laps: number;

	private readonly states: KartState[] = [];
	private readonly byId = new Map<PlayerId, KartState>();
	private readonly missileList: MissileState[] = [];
	private readonly slickList: SlickState[] = [];
	private readonly boxList: ItemBoxState[] = [];
	private readonly hpList: number[];
	private readonly aiStateList: AiState[] = [];
	private readonly events: GameEvent[] = [];
	private readonly rng: SimRng;
	private readonly durationTicks: number;
	private readonly tickRate: number;
	private readonly difficulty: AiDifficulty;
	/** Tile index -> breakable slot (-1 = ordinary wall). */
	private readonly breakableSlot: Int8Array;

	private currentTick = 0;
	private done = false;
	private nextEntityId = 1;

	constructor(seed: number, config: GameConfig, players: SimPlayer[]) {
		this.track = getTrack(strOption(config.options, 'trackId', 'sunny-circuit'));
		this.tickRate = config.tickRate > 0 ? config.tickRate : 60;
		this.durationTicks = Math.max(1, Math.floor(config.durationTicks));
		this.countdownTicks = Math.max(
			0,
			Math.floor(numOption(config.options, 'countdownTicks', DEFAULT_COUNTDOWN_TICKS))
		);
		this.laps = Math.max(1, Math.floor(numOption(config.options, 'laps', 3)));
		const difficulty = strOption(config.options, 'aiDifficulty', 'medium');
		this.difficulty = difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium';
		this.rng = new SimRng(seed >>> 0);

		this.hpList = this.track.breakables.map(() => 1);
		this.breakableSlot = new Int8Array(this.track.cols * this.track.rows).fill(-1);
		this.track.breakables.forEach((tileIndex, slot) => {
			this.breakableSlot[tileIndex] = slot;
		});
		for (const box of this.track.itemBoxes) this.boxList.push({ x: box.x, y: box.y, respawn: 0 });

		// Humans first (slot order), then sim-owned AI karts fill the grid.
		// Names/colors for AI karts come from `aiMeta(id)` (ai.ts) on the client.
		players.forEach((player, index) => {
			this.addKart(player.id, index, false);
		});
		// At most 8 racers total: AI fills whatever the humans leave open.
		const aiCount = Math.max(
			0,
			Math.min(7, 8 - players.length, Math.floor(numOption(config.options, 'aiCount', 0)))
		);
		for (let i = 0; i < aiCount; i++) {
			const id = `ai-${i + 1}`;
			this.addKart(id, players.length + i, true);
			this.aiStateList.push({ id, itemTimer: 60, driftTimer: 0, wobble: 0, wobbleTimer: 0 });
		}
		this.updatePlacement();
	}

	private addKart(id: PlayerId, slot: number, ai: boolean): void {
		const grid = this.track.startGrid[slot % this.track.startGrid.length];
		const state: KartState = {
			id,
			x: grid.x,
			y: grid.y,
			angle: grid.angle,
			z: 0,
			vz: 0,
			airCooldown: 0,
			speed: 0,
			lateral: 0,
			lap: 0,
			checkpoint: 1,
			gateSign: -1,
			splineHint: -1,
			progress: 0,
			drifting: false,
			driftDir: 0,
			driftCharge: 0,
			hopTicks: 0,
			spinTimer: 0,
			spinDir: 1,
			boostTimer: 0,
			boostPower: 0,
			item: null,
			shieldTimer: 0,
			shrinkTimer: 0,
			draftTicks: 0,
			stuckTicks: 0,
			trick: false,
			upPressTick: -1000,
			lapStartTick: 0,
			bestLapMs: 0,
			lastLapMs: 0,
			itemsUsed: 0,
			driftBoosts: 0,
			finished: false,
			finishTimeMs: 0,
			place: slot + 1,
			lastKeys: 0,
			ai
		};
		const near = nearestSpline(this.track, state.x, state.y, -1);
		state.splineHint = near.index;
		state.progress = near.point.s;
		state.gateSign = this.gateSignFor(state, 1);
		this.states.push(state);
		this.byId.set(id, state);
		this.events.push({ kind: 'spawn', player: id });
	}

	get tick(): number {
		return this.currentTick;
	}

	get finished(): boolean {
		return this.done;
	}

	get karts(): readonly KartState[] {
		return this.states;
	}

	get missiles(): readonly MissileState[] {
		return this.missileList;
	}

	get slicks(): readonly SlickState[] {
		return this.slickList;
	}

	get boxes(): readonly ItemBoxState[] {
		return this.boxList;
	}

	get breakableHp(): readonly number[] {
		return this.hpList;
	}

	get aiStates(): readonly AiState[] {
		return this.aiStateList;
	}

	tickOnce(inputs: Map<PlayerId, InputFrame>): void {
		if (this.done) return;

		// Countdown is shared: 3/2/1/GO ticks the race start.
		if (this.countdownTicks > 0 && this.currentTick <= this.countdownTicks) {
			const step = this.countdownTicks / 3;
			if (Number.isInteger(this.currentTick / step)) {
				this.events.push({ kind: 'countdown', value: 3 - this.currentTick / step });
			}
		}
		const frozen = this.currentTick < this.countdownTicks;

		// Rubber-banding reads last tick's progress (deterministic ordering).
		const aiBands = this.aiBands();

		for (const kart of this.states) {
			const keys = kart.ai ? this.aiKeys(kart) : (inputs.get(kart.id)?.keys ?? kart.lastKeys);
			this.updateKart(kart, keys, frozen, aiBands.get(kart.id) ?? 1);
		}
		this.resolveKartPairs();
		this.updateSlipstreams();
		this.stepMissiles();
		this.stepSlicks();
		this.collectBoxes();
		this.checkHazards();
		this.updatePlacement();

		this.currentTick++;
		const allDone = this.states.length > 0 && this.states.every((k) => k.finished);
		if (allDone || this.currentTick >= this.durationTicks) {
			this.done = true;
			this.events.push({ kind: 'match-end' });
		}
	}

	private aiKeys(kart: KartState): number {
		const ai = this.aiStateList.find((s) => s.id === kart.id);
		if (!ai) return 0;
		return aiDecide(this.track, kart, this.states, ai, this.difficulty, this.currentTick, () =>
			this.rng.next()
		);
	}

	/**
	 * Mild rubber-banding: AI speed multiplier from the signed progress gap to
	 * the pack average (leaders slow a touch, trailers speed up), capped at
	 * +/-8% and scaled down on easier difficulties.
	 */
	private aiBands(): Map<PlayerId, number> {
		const bands = new Map<PlayerId, number>();
		if (this.states.length < 2) return bands;
		let sum = 0;
		for (const k of this.states) sum += k.progress;
		const mean = sum / this.states.length;
		for (const k of this.states) {
			if (!k.ai) continue;
			bands.set(k.id, aiRubberBand(this.difficulty, mean - k.progress));
		}
		return bands;
	}

	drainEvents(): GameEvent[] {
		return this.events.splice(0, this.events.length);
	}

	snapshot(): GameStatePatch {
		return {
			tick: this.currentTick,
			finished: this.done,
			rngState: this.rng.state,
			nextEntityId: this.nextEntityId,
			karts: this.states.map((k) => ({ ...k })),
			missiles: this.missileList.map((m) => ({ ...m })),
			slicks: this.slickList.map((s) => ({ ...s })),
			boxes: this.boxList.map((b) => ({ ...b })),
			breakableHp: this.hpList.slice(),
			aiStates: this.aiStateList.map((a) => ({ ...a }))
		};
	}

	restore(state: GameStatePatch): void {
		const snap = parseKartSnapshot(state);
		if (!snap) throw new Error('kart: invalid snapshot');
		this.currentTick = snap.tick;
		this.done = snap.finished;
		this.rng.state = snap.rngState | 0;
		this.nextEntityId = Math.max(1, snap.nextEntityId | 0);
		const byId = new Map(snap.karts.map((k) => [k.id, k]));
		for (const target of this.states) {
			const src = byId.get(target.id);
			if (!src) continue;
			Object.assign(target, src, { id: target.id, ai: target.ai });
		}
		this.missileList.length = 0;
		for (const m of snap.missiles) this.missileList.push({ ...m });
		this.slickList.length = 0;
		for (const s of snap.slicks) this.slickList.push({ ...s });
		for (let i = 0; i < this.boxList.length; i++) {
			if (i < snap.boxes.length) {
				this.boxList[i].x = snap.boxes[i].x;
				this.boxList[i].y = snap.boxes[i].y;
				this.boxList[i].respawn = snap.boxes[i].respawn;
			}
		}
		for (let i = 0; i < this.hpList.length; i++) {
			this.hpList[i] = i < snap.breakableHp.length ? snap.breakableHp[i] : this.hpList[i];
		}
		const aiById = new Map(snap.aiStates.map((a) => [a.id, a]));
		for (const target of this.aiStateList) {
			const src = aiById.get(target.id);
			if (src) Object.assign(target, src, { id: target.id });
		}
	}

	results(): MatchResult[] {
		const ranked = this.states.slice().sort((a, b) => {
			if (a.finished !== b.finished) return a.finished ? -1 : 1;
			if (a.finished && b.finished) return a.finishTimeMs - b.finishTimeMs;
			if (b.progress !== a.progress) return b.progress - a.progress;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		const placeBonus = [1000, 700, 500, 400, 300, 200, 100, 50];
		return ranked.map((k, i) => ({
			player: k.id,
			placement: i + 1,
			score:
				placeBonus[Math.min(i, placeBonus.length - 1)] +
				(k.bestLapMs > 0 ? clamp(Math.round((30000 - k.bestLapMs) / 100), 0, 300) : 0),
			stats: {
				laps: k.lap,
				bestLapMs: k.bestLapMs,
				totalTimeMs: k.finished ? k.finishTimeMs : this.elapsedMs(),
				itemsUsed: k.itemsUsed,
				driftBoosts: k.driftBoosts
			}
		}));
	}

	private elapsedMs(): number {
		return Math.round((this.currentTick * 1000) / this.tickRate);
	}

	hash(): number {
		let h = FNV_OFFSET;
		h = fnvInt(h, this.currentTick);
		h = fnvByte(h, this.done ? 1 : 0);
		h = fnvInt(h, this.rng.state);
		h = fnvInt(h, this.nextEntityId);
		for (const k of this.states) {
			h = fnvInt(h, quantize(k.x));
			h = fnvInt(h, quantize(k.y));
			h = fnvInt(h, quantize(k.angle));
			h = fnvInt(h, quantize(k.z));
			h = fnvInt(h, quantize(k.vz));
			h = fnvInt(h, k.airCooldown);
			h = fnvInt(h, quantize(k.speed));
			h = fnvInt(h, quantize(k.lateral));
			h = fnvInt(h, k.lap);
			h = fnvInt(h, k.checkpoint);
			h = fnvInt(h, k.gateSign);
			h = fnvInt(h, k.splineHint);
			h = fnvInt(h, quantize(k.progress));
			h = fnvByte(h, k.drifting ? 1 : 0);
			h = fnvInt(h, k.driftDir);
			h = fnvInt(h, k.driftCharge);
			h = fnvInt(h, k.hopTicks);
			h = fnvInt(h, k.spinTimer);
			h = fnvInt(h, k.spinDir);
			h = fnvInt(h, k.boostTimer);
			h = fnvInt(h, quantize(k.boostPower));
			h = fnvInt(h, k.item ? ITEM_KINDS.indexOf(k.item) + 1 : 0);
			h = fnvInt(h, k.shieldTimer);
			h = fnvInt(h, k.shrinkTimer);
			h = fnvInt(h, k.draftTicks);
			h = fnvInt(h, k.stuckTicks);
			h = fnvByte(h, k.trick ? 1 : 0);
			h = fnvInt(h, k.upPressTick);
			h = fnvInt(h, k.lapStartTick);
			h = fnvInt(h, k.bestLapMs);
			h = fnvInt(h, k.lastLapMs);
			h = fnvInt(h, k.itemsUsed);
			h = fnvInt(h, k.driftBoosts);
			h = fnvByte(h, k.finished ? 1 : 0);
			h = fnvInt(h, k.finishTimeMs);
			h = fnvInt(h, k.place);
			h = fnvInt(h, k.lastKeys);
		}
		for (const m of this.missileList) {
			h = fnvInt(h, m.id);
			h = fnvByte(h, m.owner.length);
			h = fnvInt(h, quantize(m.x));
			h = fnvInt(h, quantize(m.y));
			h = fnvInt(h, quantize(m.angle));
			h = fnvByte(h, m.targetId === null ? 0 : 1);
			h = fnvInt(h, m.life);
		}
		for (const s of this.slickList) {
			h = fnvInt(h, s.id);
			h = fnvInt(h, quantize(s.x));
			h = fnvInt(h, quantize(s.y));
			h = fnvInt(h, s.life);
		}
		for (const b of this.boxList) {
			h = fnvInt(h, quantize(b.x));
			h = fnvInt(h, quantize(b.y));
			h = fnvInt(h, b.respawn);
		}
		for (const hp of this.hpList) h = fnvInt(h, hp);
		for (const a of this.aiStateList) {
			h = fnvInt(h, a.itemTimer);
			h = fnvInt(h, a.driftTimer);
			h = fnvInt(h, quantize(a.wobble));
			h = fnvInt(h, a.wobbleTimer);
		}
		return h >>> 0;
	}

	// ---- per-kart update ----

	private updateKart(kart: KartState, keys: number, frozen: boolean, rubber: number): void {
		const edges = keys & ~kart.lastKeys;
		kart.lastKeys = keys;

		if (frozen) {
			// Engines rev on the line: KEY.UP presses in the final window set up
			// the rocket start (checked on the GO tick below).
			if ((edges & KEY.UP) !== 0) kart.upPressTick = this.currentTick;
			return;
		}

		// Timers tick down regardless of control state.
		if (kart.airCooldown > 0) kart.airCooldown--;
		if (kart.spinTimer > 0) kart.spinTimer--;
		// Boost power lives exactly as long as the boost; overlapping boosts
		// keep the strongest power while any of them lasts.
		if (kart.boostTimer > 0) kart.boostTimer--;
		else if (kart.boostPower !== 0) kart.boostPower = 0;
		if (kart.shieldTimer > 0) kart.shieldTimer--;
		if (kart.shrinkTimer > 0) kart.shrinkTimer--;
		if (kart.hopTicks > 0) kart.hopTicks--;

		// Rocket start: a well-timed KEY.UP press at the end of the countdown
		// (no countdown = no rocket window).
		if ((edges & KEY.UP) !== 0) kart.upPressTick = this.currentTick;
		if (
			this.countdownTicks > 0 &&
			this.currentTick === this.countdownTicks &&
			kart.upPressTick >= this.countdownTicks - ROCKET_WINDOW
		) {
			this.applyBoost(kart, ROCKET_TICKS, ROCKET_POWER);
		}

		const spinning = kart.spinTimer > 0;
		const airborne = kart.z > 0;
		const tile = tileAtPx(this.track, kart.x, kart.y);
		const offroad = isOffRoadTile(tile);
		const onIce = tile === 'ice';
		const onCurb = tile === 'curb';

		// Steering (weaker grip at low speed; barely steers in the air).
		const steer = (keys & KEY.RIGHT ? 1 : 0) - (keys & KEY.LEFT ? 1 : 0);
		let steerScale = clamp(Math.abs(kart.speed) / STEER_FULL_SPEED, MIN_STEER_SCALE, 1);
		if (airborne) steerScale *= 0.35;
		else if (onIce) steerScale *= 0.8;
		if (!spinning) {
			const rate = kart.drifting ? STEER_RATE * DRIFT_STEER_MULT : STEER_RATE;
			kart.angle += steer * rate * steerScale;
		}

		// Drift charging / mini-turbo release. A drift needs a turn (or hop) to
		// START, but once going it holds as long as DRIFT is down and the kart
		// is moving — steering only picks the slide direction.
		const driftHeld = (keys & KEY.DRIFT) !== 0;
		const threshold = kart.hopTicks > 0 ? DRIFT_MIN_SPEED_HOP : DRIFT_MIN_SPEED;
		if (kart.drifting) {
			if (driftHeld && !airborne && !spinning && Math.abs(kart.speed) >= threshold) {
				if (steer !== 0) kart.driftDir = steer;
				kart.driftCharge++;
			} else {
				kart.drifting = false;
				kart.driftDir = 0;
				const tier = driftTier(kart.driftCharge);
				kart.driftCharge = 0;
				if (tier >= 1) {
					kart.driftBoosts++;
					this.applyBoost(kart, MINITURBO_TICKS[tier], MINITURBO_POWER[tier]);
				}
			}
		} else if (
			driftHeld &&
			!airborne &&
			!spinning &&
			steer !== 0 &&
			Math.abs(kart.speed) >= threshold
		) {
			kart.drifting = true;
			kart.driftDir = steer;
			kart.driftCharge = 1;
		}

		// Hop: tapping DRIFT on the ground hops (drifts start easier afterwards).
		if ((edges & KEY.DRIFT) !== 0 && !airborne && kart.vz <= 0 && !spinning) {
			kart.vz = HOP_VZ;
			kart.z = 0.001;
			kart.hopTicks = 30;
		}

		// Throttle / brake / reverse, with surface- and boost-aware caps.
		let surfaceMult = 1;
		if (offroad) surfaceMult = OFFROAD_MULT;
		else if (onCurb) surfaceMult = CURB_MULT;
		else if (onIce) surfaceMult = ICE_MULT;
		if (kart.shrinkTimer > 0) surfaceMult *= SHRINK_MULT;
		let cap = BASE_MAX_SPEED * surfaceMult * rubber;
		if (kart.draftTicks >= SLIPSTREAM_TICKS) cap *= 1 + SLIPSTREAM_PASSIVE;
		if (kart.boostTimer > 0) cap = Math.max(cap, BASE_MAX_SPEED * (1 + kart.boostPower));

		if (!spinning) {
			if ((keys & KEY.UP) !== 0) {
				const accel = kart.boostTimer > 0 ? 0.14 : offroad ? ACCEL * 0.8 : ACCEL;
				if (kart.speed < 0) kart.speed += BRAKE;
				// Gas never pushes past the cap; the bleed below handles the
				// case where a boost left the kart faster than the new cap.
				else if (kart.speed < cap) kart.speed = Math.min(cap, kart.speed + accel);
			} else if ((keys & KEY.DOWN) !== 0) {
				if (kart.speed > 0) kart.speed -= BRAKE;
				else kart.speed = Math.max(-REVERSE_MAX, kart.speed - ACCEL * 0.7);
			} else {
				kart.speed *= 0.995;
			}
		}
		// Over the cap (boost bleed-out, surface change): decay smoothly toward
		// it instead of hard-clamping — a boost should fade, not snap off.
		if (kart.speed > cap) {
			kart.speed = Math.max(cap, kart.speed - Math.max(0.05, (kart.speed - cap) * 0.15));
		}
		kart.speed = Math.max(-REVERSE_MAX, kart.speed);

		// Lateral grip: drifting and ice keep the slide alive.
		const grip = airborne
			? 1
			: kart.drifting
				? GRIP_DRIFT
				: onIce
					? GRIP_ICE
					: offroad
						? GRIP_OFFROAD
						: GRIP_ROAD;
		kart.lateral *= grip;
		if (kart.drifting && !airborne) kart.lateral -= kart.driftDir * DRIFT_PUSH;

		// Integrate: velocity = heading * speed + right-vector * lateral.
		const fx = Math.cos(kart.angle);
		const fy = Math.sin(kart.angle);
		const vx = fx * kart.speed - fy * kart.lateral;
		const vy = fy * kart.speed + fx * kart.lateral;
		this.moveKart(kart, vx, vy, fx, fy);

		// Air / ground tile interactions at the new position.
		if (kart.z > 0 || kart.vz > 0) {
			if ((edges & KEY.JUMP) !== 0 && !kart.trick) kart.trick = true;
			kart.vz -= GRAVITY;
			kart.z += kart.vz;
			if (kart.z <= 0) {
				kart.z = 0;
				kart.vz = 0;
				kart.airCooldown = LAND_COOLDOWN;
				const landTile = tileAtPx(this.track, kart.x, kart.y);
				if (landTile === 'water') {
					this.respawn(kart);
					return;
				}
				if (kart.trick) {
					kart.trick = false;
					this.applyBoost(kart, TRICK_TICKS, TRICK_POWER);
				}
			}
		} else {
			const groundTile = tileAtPx(this.track, kart.x, kart.y);
			if (groundTile === 'water') {
				this.respawn(kart);
				return;
			}
			if (groundTile === 'boost' && kart.boostTimer < BOOST_PAD_TICKS - 6) {
				this.applyBoost(kart, BOOST_PAD_TICKS, BOOST_PAD_POWER);
			}
			if (groundTile === 'ramp' && kart.airCooldown <= 0 && Math.abs(kart.speed) > RAMP_MIN_SPEED) {
				kart.vz = RAMP_VZ + Math.abs(kart.speed) * 0.25;
				kart.z = 0.001;
				kart.hopTicks = 0;
			}
		}

		// Item firing.
		if ((edges & KEY.ITEM) !== 0 && kart.item !== null && kart.spinTimer === 0) {
			this.fireItem(kart);
		}

		this.updateProgress(kart);

		// Off-track watchdog: far from the line or driving-but-stuck for 1.5s.
		const near = nearestSpline(this.track, kart.x, kart.y, kart.splineHint);
		if (near.distance > FALL_DISTANCE) {
			this.respawn(kart);
			return;
		}
		// "Stuck" means trying to drive but not moving (parked karts stay put).
		if (Math.abs(kart.speed) < 0.15 && !spinning && keys !== 0) kart.stuckTicks++;
		else kart.stuckTicks = 0;
		if (kart.stuckTicks >= RESPAWN_STUCK_TICKS) {
			this.respawn(kart);
		}
	}

	private applyBoost(kart: KartState, ticks: number, power: number): void {
		if (kart.boostTimer < ticks) kart.boostTimer = ticks;
		if (kart.boostPower < power) kart.boostPower = power;
		this.events.push({ kind: 'boost', player: kart.id, power });
	}

	// ---- movement and collisions ----

	/**
	 * Substepped axis-separated move with soft walls: a graze costs speed and
	 * steers you back toward the racing line, a head-on crash costs much more
	 * and spins you out. Smashing into a breakable shortcut wall destroys it
	 * instead (the wall gives way).
	 */
	private moveKart(kart: KartState, dx: number, dy: number, fx: number, fy: number): void {
		const beforeSpeed = kart.speed;
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 4));
		let blockedX = false;
		let blockedY = false;
		let brokeWall = false;
		for (let i = 0; i < steps; i++) {
			const hit = this.moveKartAxis(kart, dx / steps, 0);
			if (hit === 2) brokeWall = true;
			else if (hit === 1) blockedX = true;
			const hitY = this.moveKartAxis(kart, 0, dy / steps);
			if (hitY === 2) brokeWall = true;
			else if (hitY === 1) blockedY = true;
		}
		if (brokeWall) {
			kart.speed = beforeSpeed * 0.7;
			kart.lateral *= 0.6;
			return;
		}
		if (!blockedX && !blockedY) return;
		const headOn = (blockedX && Math.abs(fx) > 0.55) || (blockedY && Math.abs(fy) > 0.55);
		const impact = Math.abs(beforeSpeed);
		if (headOn && impact > CRASH_SPEED) {
			kart.speed = Math.sign(beforeSpeed || 1) * impact * 0.25;
			kart.spinTimer = SPIN_TICKS;
			kart.spinDir = this.rng.next() < 0.5 ? -1 : 1;
			kart.drifting = false;
			kart.driftCharge = 0;
			kart.lateral = 0;
			this.events.push({ kind: 'hit', player: kart.id, by: kart.id, force: 1 });
		} else {
			kart.speed = beforeSpeed * SOFT_WALL_MULT;
			kart.lateral *= 0.5;
			// Steering assist back onto the racing line (no dead bouncing).
			const near = nearestSpline(this.track, kart.x, kart.y, kart.splineHint);
			const tangent = Math.atan2(near.point.ty, near.point.tx);
			kart.angle += clamp(angleDelta(kart.angle, tangent), -WALL_STEER_ASSIST, WALL_STEER_ASSIST);
		}
	}

	/** 0 = clear, 1 = solid wall, 2 = breakable wall smashed through. */
	private moveKartAxis(kart: KartState, dx: number, dy: number): number {
		kart.x += dx;
		kart.y += dy;
		kart.x = clamp(kart.x, KART_HALF, this.track.cols * TILE_SIZE - KART_HALF);
		kart.y = clamp(kart.y, KART_HALF, this.track.rows * TILE_SIZE - KART_HALF);

		let result = 0;
		const minCol = Math.floor((kart.x - KART_HALF) / TILE_SIZE);
		const maxCol = Math.floor((kart.x + KART_HALF - 0.001) / TILE_SIZE);
		const minRow = Math.floor((kart.y - KART_HALF) / TILE_SIZE);
		const maxRow = Math.floor((kart.y + KART_HALF - 0.001) / TILE_SIZE);
		for (let row = minRow; row <= maxRow; row++) {
			for (let col = minCol; col <= maxCol; col++) {
				if (!this.solidAt(col, row)) continue;
				// Breakable shortcut walls give way to a hard enough impact (the
				// smash is signalled by `breakableHp` in the snapshot stream).
				const slot = this.breakableSlot[row * this.track.cols + col];
				if (slot >= 0 && Math.abs(kart.speed) > CRASH_SPEED * 0.8) {
					this.hpList[slot] = 0;
					continue;
				}
				result = 1;
				if (dx > 0) kart.x = col * TILE_SIZE - KART_HALF;
				else if (dx < 0) kart.x = (col + 1) * TILE_SIZE + KART_HALF;
				else if (dy > 0) kart.y = row * TILE_SIZE - KART_HALF;
				else if (dy < 0) kart.y = (row + 1) * TILE_SIZE + KART_HALF;
			}
		}
		return result;
	}

	/** Walls and intact breakable shortcut walls block movement. */
	private solidAt(col: number, row: number): boolean {
		if (col < 0 || row < 0 || col >= this.track.cols || row >= this.track.rows) return true;
		const tile = tileAt(this.track, col, row);
		if (!isSolidTile(tile)) return false;
		const slot = this.breakableSlot[row * this.track.cols + col];
		return slot < 0 || this.hpList[slot] > 0;
	}

	/**
	 * Slipstreaming: drafting in a rival's wake for SLIPSTREAM_TICKS gives a
	 * passive +10% (applied via the speed cap next tick) and ending a qualifying
	 * draft pops a burst boost. Grounded karts only — you can't draft in the air.
	 */
	private updateSlipstreams(): void {
		for (const kart of this.states) {
			if (kart.z > 0 || kart.spinTimer > 0) {
				kart.draftTicks = 0;
				continue;
			}
			const fx = Math.cos(kart.angle);
			const fy = Math.sin(kart.angle);
			let drafting = false;
			for (const other of this.states) {
				if (other.id === kart.id) continue;
				const dx = other.x - kart.x;
				const dy = other.y - kart.y;
				const dist = Math.hypot(dx, dy);
				if (dist > SLIPSTREAM_RANGE || dist < 8) continue;
				// The rival must sit ahead, inside the drafting cone.
				if (dx * fx + dy * fy <= 0) continue;
				const toward = Math.atan2(dy, dx);
				if (Math.abs(angleDelta(kart.angle, toward)) > SLIPSTREAM_CONE) continue;
				drafting = true;
				break;
			}
			if (drafting) {
				kart.draftTicks = Math.min(SLIPSTREAM_TICKS + 60, kart.draftTicks + 1);
			} else if (kart.draftTicks > 0) {
				if (kart.draftTicks >= SLIPSTREAM_TICKS) {
					this.applyBoost(kart, SLIPSTREAM_BURST_TICKS, SLIPSTREAM_BURST_POWER);
				}
				kart.draftTicks = 0;
			}
		}
	}

	/** Push overlapping karts apart along their shallowest axis (tiny slowdown). */
	private resolveKartPairs(): void {
		for (let i = 0; i < this.states.length; i++) {
			for (let j = i + 1; j < this.states.length; j++) {
				const a = this.states[i];
				const b = this.states[j];
				const overlapX = KART_HALF * 2 - Math.abs(a.x - b.x);
				const overlapY = KART_HALF * 2 - Math.abs(a.y - b.y);
				if (overlapX <= 0 || overlapY <= 0) continue;
				a.speed *= 0.98;
				b.speed *= 0.98;
				if (overlapX < overlapY) {
					const dir = a.x <= b.x ? -1 : 1;
					const push = overlapX / 2;
					a.x += dir * push;
					b.x -= dir * push;
				} else {
					const dir = a.y <= b.y ? -1 : 1;
					const push = overlapY / 2;
					a.y += dir * push;
					b.y -= dir * push;
				}
			}
		}
	}

	// ---- progress, laps, respawns ----

	private gateSignFor(kart: KartState, gateIndex: number): number {
		const cp = this.track.checkpoints[gateIndex];
		const f = (kart.x - cp.x) * cp.tx + (kart.y - cp.y) * cp.ty;
		return f >= 0 ? 1 : -1;
	}

	private updateProgress(kart: KartState): void {
		const near = nearestSpline(this.track, kart.x, kart.y, kart.splineHint);
		kart.splineHint = near.index;
		kart.progress = kart.lap * this.track.lapLength + near.point.s;
		if (kart.finished) return;

		const gateCount = this.track.checkpoints.length;
		const cp = this.track.checkpoints[kart.checkpoint];
		const f = (kart.x - cp.x) * cp.tx + (kart.y - cp.y) * cp.ty;
		const sign = f >= 0 ? 1 : -1;
		const perp = (kart.x - cp.x) * -cp.ty + (kart.y - cp.y) * cp.tx;
		const gateHalf = this.track.roadHalfWidth * 2 + 24;
		// A gate passes only when the kart crosses its line THIS tick while
		// actually at the gate: laterally inside the gate band and long-ways
		// within one tick of travel of the line. Teleports (respawns, cuts)
		// jump over that window and grant nothing.
		if (kart.gateSign < 0 && sign > 0 && Math.abs(perp) <= gateHalf && Math.abs(f) <= 32) {
			if (kart.checkpoint === 0) {
				this.completeLap(kart);
				if (kart.finished) return;
			}
			kart.checkpoint = (kart.checkpoint + 1) % gateCount;
			kart.gateSign = this.gateSignFor(kart, kart.checkpoint);
		} else {
			kart.gateSign = sign;
		}
	}

	private completeLap(kart: KartState): void {
		const lapMs = this.elapsedMs() - kart.lapStartTick;
		kart.lastLapMs = lapMs;
		if (kart.bestLapMs === 0 || lapMs < kart.bestLapMs) kart.bestLapMs = lapMs;
		kart.lap++;
		kart.lapStartTick = this.currentTick;
		this.events.push({ kind: 'lap', player: kart.id, lap: kart.lap, timeMs: lapMs });
		if (kart.lap >= this.laps) {
			kart.finished = true;
			kart.finishTimeMs = this.elapsedMs();
			this.events.push({ kind: 'finish', player: kart.id, timeMs: kart.finishTimeMs });
		}
	}

	/**
	 * Auto-respawn at the last checkpoint anchor: reoriented along the racing
	 * line, all transient state cleared, 1.5s of respawn boost.
	 */
	private respawn(kart: KartState): void {
		const gateCount = this.track.checkpoints.length;
		const anchorIndex = (kart.checkpoint - 1 + gateCount) % gateCount;
		const anchor = this.track.respawns[anchorIndex];
		kart.x = anchor.x;
		kart.y = anchor.y;
		kart.angle = Math.atan2(anchor.ty, anchor.tx);
		kart.z = 0;
		kart.vz = 0;
		kart.airCooldown = LAND_COOLDOWN;
		kart.speed = 0;
		kart.lateral = 0;
		kart.drifting = false;
		kart.driftDir = 0;
		kart.driftCharge = 0;
		kart.hopTicks = 0;
		kart.spinTimer = 0;
		kart.trick = false;
		kart.stuckTicks = 0;
		kart.draftTicks = 0;
		kart.boostTimer = RESPAWN_BOOST_TICKS;
		kart.boostPower = RESPAWN_BOOST_POWER;
		const near = nearestSpline(this.track, kart.x, kart.y, -1);
		kart.splineHint = near.index;
		kart.progress = kart.lap * this.track.lapLength + near.point.s;
		kart.gateSign = this.gateSignFor(kart, kart.checkpoint);
		this.events.push({ kind: 'respawn', player: kart.id });
		this.events.push({ kind: 'boost', player: kart.id, power: RESPAWN_BOOST_POWER });
	}

	// ---- items ----

	private fireItem(kart: KartState): void {
		const item = kart.item;
		if (item === null) return;
		kart.item = null;
		kart.itemsUsed++;
		const fx = Math.cos(kart.angle);
		const fy = Math.sin(kart.angle);
		switch (item) {
			case 'mushroom':
				this.applyBoost(kart, MUSHROOM_TICKS, MUSHROOM_POWER);
				break;
			case 'oil':
				this.slickList.push({
					id: this.nextEntityId++,
					owner: kart.id,
					x: kart.x - fx * 14,
					y: kart.y - fy * 14,
					life: SLICK_LIFE
				});
				break;
			case 'missile': {
				const target = this.kartAheadOf(kart);
				this.missileList.push({
					id: this.nextEntityId++,
					owner: kart.id,
					x: kart.x + fx * 12,
					y: kart.y + fy * 12,
					angle: kart.angle,
					targetId: target ? target.id : null,
					life: MISSILE_LIFE
				});
				break;
			}
			case 'shield':
				kart.shieldTimer = SHIELD_TICKS;
				break;
			case 'lightning':
				for (const other of this.states) {
					if (other.id === kart.id) continue;
					if (other.progress > kart.progress) other.shrinkTimer = LIGHTNING_TICKS;
				}
				break;
		}
	}

	/** The kart directly ahead in race progress (missile homing target). */
	private kartAheadOf(kart: KartState): KartState | null {
		let best: KartState | null = null;
		for (const other of this.states) {
			if (other.id === kart.id) continue;
			if (other.progress <= kart.progress) continue;
			if (!best || other.progress < best.progress) best = other;
		}
		if (best) return best;
		// Nothing ahead (last place): the leader eats it instead.
		for (const other of this.states) {
			if (other.id === kart.id) continue;
			if (!best || other.progress > best.progress) best = other;
		}
		return best;
	}

	private stepMissiles(): void {
		const surviving: MissileState[] = [];
		for (const missile of this.missileList) {
			missile.life--;
			if (missile.life <= 0) continue;
			const target = missile.targetId !== null ? this.byId.get(missile.targetId) : undefined;
			if (target) {
				const desired = Math.atan2(target.y - missile.y, target.x - missile.x);
				missile.angle += clamp(angleDelta(missile.angle, desired), -MISSILE_TURN, MISSILE_TURN);
			}
			const vx = Math.cos(missile.angle) * MISSILE_SPEED;
			const vy = Math.sin(missile.angle) * MISSILE_SPEED;
			const steps = 2;
			let dead = false;
			for (let s = 0; s < steps && !dead; s++) {
				missile.x += vx / steps;
				missile.y += vy / steps;
				const col = Math.floor(missile.x / TILE_SIZE);
				const row = Math.floor(missile.y / TILE_SIZE);
				if (this.solidAt(col, row)) {
					// Wall: explode. A hard impact smashes breakable shortcut walls.
					const slot = this.breakableSlot[row * this.track.cols + col];
					if (slot >= 0) this.hpList[slot] = 0;
					dead = true;
					break;
				}
				for (const kart of this.states) {
					if (kart.id === missile.owner) continue;
					if (kart.z > 2) continue;
					const dx = kart.x - missile.x;
					const dy = kart.y - missile.y;
					if (dx * dx + dy * dy > (KART_HALF + 5) * (KART_HALF + 5)) continue;
					this.hitKart(kart, missile.owner);
					dead = true;
					break;
				}
			}
			if (!dead) surviving.push(missile);
		}
		this.missileList.length = 0;
		for (const m of surviving) this.missileList.push(m);
	}

	private stepSlicks(): void {
		for (let i = this.slickList.length - 1; i >= 0; i--) {
			const slick = this.slickList[i];
			slick.life--;
			if (slick.life <= 0) {
				this.slickList.splice(i, 1);
				continue;
			}
			const kart = this.states.find((k) => {
				if (k.z > 0) return false;
				const dx = k.x - slick.x;
				const dy = k.y - slick.y;
				return dx * dx + dy * dy <= SLICK_RADIUS * SLICK_RADIUS;
			});
			if (kart) {
				this.hitKart(kart, slick.owner);
				this.slickList.splice(i, 1);
			}
		}
	}

	private checkHazards(): void {
		for (const hazard of this.track.hazards) {
			const pos = hazardAt(hazard, this.currentTick);
			for (const kart of this.states) {
				if (kart.z > 0) continue;
				const dx = kart.x - pos.x;
				const dy = kart.y - pos.y;
				const r = hazard.radius + KART_HALF;
				if (dx * dx + dy * dy <= r * r) this.hitKart(kart, kart.id);
			}
		}
	}

	/**
	 * One hit = 30-tick spin-out (missiles, oil, hazards, hard crashes). A
	 * shield bubble absorbs exactly one hit instead: no spin, no slowdown, and
	 * the hit is signalled with `hit` at `force: 0` (documented protocol choice,
	 * same as Pixel Tanks) so every client pops the bubble without a new event.
	 */
	private hitKart(victim: KartState, by: PlayerId): void {
		if (victim.shieldTimer > 0) {
			victim.shieldTimer = 0;
			this.events.push({ kind: 'hit', player: victim.id, by, force: 0 });
			return;
		}
		victim.spinTimer = SPIN_TICKS;
		victim.spinDir = this.rng.next() < 0.5 ? -1 : 1;
		victim.drifting = false;
		victim.driftDir = 0;
		victim.driftCharge = 0;
		victim.lateral *= 0.5;
		victim.speed *= 0.4;
		this.events.push({ kind: 'hit', player: victim.id, by, force: 1 });
	}

	private collectBoxes(): void {
		for (const box of this.boxList) {
			if (box.respawn > 0) {
				box.respawn--;
				continue;
			}
			const kart = this.states.find((k) => {
				if (k.item !== null || k.z > 0) return false;
				const dx = k.x - box.x;
				const dy = k.y - box.y;
				return dx * dx + dy * dy <= ITEM_BOX_RADIUS * ITEM_BOX_RADIUS;
			});
			if (!kart) continue;
			box.respawn = ITEM_BOX_RESPAWN_TICKS;
			this.events.push({ kind: 'collect', player: kart.id, item: 'itembox' });
			const item = rollItem(kart.place, this.states.length, () => this.rng.next());
			if (item !== null) {
				kart.item = item;
				this.events.push({ kind: 'collect', player: kart.id, item });
			}
		}
	}

	private updatePlacement(): void {
		const ranked = this.states.slice().sort((a, b) => {
			if (b.progress !== a.progress) return b.progress - a.progress;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		ranked.forEach((kart, index) => {
			kart.place = index + 1;
		});
	}
}

export function createKartSim(seed: number, config: GameConfig, players: SimPlayer[]): KartSim {
	return new KartSimulation(seed, config, players);
}
