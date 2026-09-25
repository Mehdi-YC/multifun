/**
 * Pixel Tanks — deterministic top-down tank battle simulation (fixed 60Hz).
 *
 * Rules in one paragraph: every tank has 2 lives and no hit points — one
 * bullet hit costs one life and a 2s respawn (then 1.5s of invulnerability).
 * Bullets bounce once off steel walls, shatter crates in two hits and fly over
 * water. Landing hits earns xp (10/hit) and eliminating a tank earns kills and
 * more xp (25/elimination); levels 2..5 (xp 40/100/180/280) speed the tank up,
 * shorten reloads, accelerate bullets and give level-5 shells two bounces.
 * Last tank with lives left wins, or the clock decides.
 *
 * Random upgrades: power-ups (`shield`, `triple`, `rapid`, `speed`) pop up on
 * the map every 300 ticks (and from destroyed crates, 50%) at seeded-rng-chosen
 * free floor tiles, and are collected by driving over them. Effects live in the
 * sim (timers and counters on each tank, part of snapshot/restore/hash), so
 * every client and the server agree on them without any protocol change:
 * pickups emit `collect {item:'powerup:<id>'}`, a shield eating a shell emits
 * `hit` with `force: 0` (documented choice: the existing event kind doubles as
 * "absorbed" — no life is lost, no `death` follows), and no expiry events are
 * emitted at all because effect timers travel in the snapshot for VFX.
 *
 * Determinism: no Date, no Math.random — everything is fixed-timestep math and
 * one stateful mulberry32 seeded from `seed` (used for spawn scatter, respawn
 * placement and power-up spawns/drops; its state is captured by
 * snapshot/restore). Hull angles are continuous floats in radians (0 = facing
 * +x, growing clockwise with the screen's y-down axis) and are interpolated
 * with shortest-path wrapping on the client (see `interp.ts`); Math.cos/sin are
 * used per tick, so bit-identical replay holds on a single JS engine (all our
 * client/server run V8).
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
	getArena,
	isBulletSolid,
	isTankSolid,
	tileAt,
	tileCenter,
	type Arena,
	type ArenaPoint
} from './arena';

// ---- tuning (fixed 60Hz tick) ----

/** Tank collision half-extent (12x12 box; the sprite is chunkier). */
export const TANK_HALF = 6;
/** Forward drive in px/tick before level scaling. */
export const BASE_FORWARD_SPEED = 2.2;
/** Reverse drive in px/tick before level scaling. */
export const BASE_REVERSE_SPEED = 1.4;
/** Hull rotation in radians per tick (~3.5 degrees). */
export const TURN_PER_TICK = (3.5 * Math.PI) / 180;
/** Bullet speed in px/tick before level scaling. */
export const BASE_BULLET_SPEED = 6;
/** Bullet lifetime in ticks. */
export const BULLET_LIFE = 90;
/** Reload time in ticks at level 1. */
export const BASE_RELOAD_TICKS = 45;
/** Ticks between dying and respawning. */
export const RESPAWN_TICKS = 120;
/** Invulnerability ticks after a respawn. */
export const INVULN_TICKS = 90;
/** Lives each tank starts with (2 lives = can take two hits). */
export const START_LIVES = 2;
/** xp granted to the shooter per hit landed. */
export const XP_PER_HIT = 10;
/** xp granted to the shooter per elimination. */
export const XP_PER_KILL = 25;
/** xp thresholds for levels 1..5. */
export const LEVEL_XP = [0, 40, 100, 180, 280] as const;
export const MAX_LEVEL = 5;
/** Countdown length in ticks (3/2/1/GO). Overridable via `options.countdownTicks`. */
export const DEFAULT_COUNTDOWN_TICKS = 120;
/** Ticks between tank center and muzzle tip where bullets spawn. */
export const TURRET_LENGTH = 12;

// ---- power-up tuning (see the header; ids are exactly shield/triple/rapid/speed) ----

export const POWERUP_KINDS = ['shield', 'triple', 'rapid', 'speed'] as const;
export type PowerupKind = (typeof POWERUP_KINDS)[number];

/** Ticks between automatic power-up spawns (300 = 5s at 60Hz). */
export const POWERUP_SPAWN_INTERVAL = 300;
/** Maximum power-ups alive on the map at once. */
export const POWERUP_MAX_ALIVE = 4;
/**
 * Ticks a pickup must sit visible on the map before anyone may grab it (60 =
 * 1s). Fairness rule: no pickup can change a fight (or a spawn-adjacent brawl)
 * before every screen has shown it for at least a second.
 */
export const POWERUP_GRACE_TICKS = 60;
/** Tank-center distance that collects a pickup. */
export const POWERUP_PICKUP_RADIUS = 12;
/** Shots remaining after grabbing `triple` (the next 5 shots spread 3-way). */
export const TRIPLE_SHOTS = 5;
/** Half-angle of the 3-way spread in radians (~10 degrees). */
export const TRIPLE_SPREAD = 0.18;
/** Duration of `rapid` and `speed` in ticks (480 = 8s at 60Hz). */
export const EFFECT_TICKS = 480;
/** Drive speed multiplier while `speed` is active (+40%). */
export const SPEED_MULTIPLIER = 1.4;
/** Chance a destroyed crate drops a power-up. */
export const CRATE_DROP_CHANCE = 0.5;

/** Reload ticks while `rapid` is active: base reload divided by 3 (min 1). */
export function rapidReloadTicks(level: number): number {
	return Math.max(1, Math.round(reloadTicks(level) / 3));
}

export function levelForXp(xp: number): number {
	let level = 1;
	for (let i = 1; i < LEVEL_XP.length; i++) {
		if (xp >= LEVEL_XP[i]) level = i + 1;
	}
	return level;
}

export function speedScale(level: number): number {
	return 1 + 0.08 * (level - 1);
}

export function reloadTicks(level: number): number {
	return Math.max(1, Math.round(BASE_RELOAD_TICKS * (1 - 0.1 * (level - 1))));
}

export function bulletSpeed(level: number): number {
	return BASE_BULLET_SPEED * (1 + 0.12 * (level - 1));
}

/** Wall bounces a shell survives: one normally, two at max level. */
export function maxBounces(level: number): number {
	return level >= MAX_LEVEL ? 2 : 1;
}

// ---- state ----

export type TankState = {
	id: PlayerId;
	/** Hull center in world pixels. */
	x: number;
	y: number;
	/** Continuous hull angle in radians; 0 = +x, grows clockwise (y down). */
	angle: number;
	/** -1 reversing, 0 idle, 1 driving — tread animation. */
	moveDir: number;
	lives: number;
	kills: number;
	deaths: number;
	/** Hits landed on other tanks. */
	damage: number;
	xp: number;
	level: number;
	/** Ticks until the cannon may fire again. */
	reloadTimer: number;
	/** Ticks until respawn; > 0 while dead. */
	respawnTimer: number;
	/** Ticks of post-respawn invulnerability left. */
	invulnTimer: number;
	alive: boolean;
	/** Last input seen; disconnected players keep driving with it. */
	lastKeys: number;
	/** 1 when the shield bubble is up (absorbs the next shell hit). */
	shield: number;
	/** `triple` shots left: each shot fires a 3-way spread. */
	triple: number;
	/** Ticks of rapid fire (reload / 3) left. */
	rapidTimer: number;
	/** Ticks of +40% drive speed left. */
	speedTimer: number;
};

/**
 * A map pickup. Kinds are exactly `shield`, `triple`, `rapid`, `speed`.
 * `born` is the spawn tick — pickups can only be collected after
 * `POWERUP_GRACE_TICKS` of visibility (fairness, see the tuning block).
 */
export type PowerupState = {
	/** Stable identity for snapshot/interpolation maps. */
	id: number;
	kind: PowerupKind;
	/** Center in world pixels (a free floor tile's center). */
	x: number;
	y: number;
	/** Tick the pickup appeared on the map. */
	born: number;
};

export type BulletState = {
	/** Stable identity for snapshot interpolation on the client. */
	id: number;
	owner: PlayerId;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Ticks left to live. */
	life: number;
	/** Wall bounces so far. */
	bounces: number;
};

export type TankSnapshot = {
	tick: number;
	finished: boolean;
	rngState: number;
	nextBulletId: number;
	tanks: TankState[];
	bullets: BulletState[];
	/** Per-tile crate hit points (0 = no crate / destroyed). */
	crates: number[];
	/** Power-ups currently on the map. */
	powerups: PowerupState[];
	/** Identity generator for power-ups (restored for determinism). */
	nextPowerupId: number;
};

/** GameSim plus read-only live views used by tests and the renderer. */
export type TankSim = GameSim & {
	readonly arena: Arena;
	readonly tanks: readonly TankState[];
	readonly bullets: readonly BulletState[];
	readonly crateHp: readonly number[];
	readonly powerups: readonly PowerupState[];
	readonly countdownTicks: number;
};

// ---- deterministic helpers ----

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

function numOption(options: Record<string, unknown>, key: string, fallback: number): number {
	const v = options[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readNumber(source: Record<string, unknown>, key: string): number {
	const v = source[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readBool(source: Record<string, unknown>, key: string): boolean {
	return source[key] === true;
}

function readTank(source: Record<string, unknown>): TankState | null {
	const id = source['id'];
	if (typeof id !== 'string') return null;
	return {
		id,
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		angle: readNumber(source, 'angle'),
		moveDir: readNumber(source, 'moveDir'),
		lives: readNumber(source, 'lives'),
		kills: readNumber(source, 'kills'),
		deaths: readNumber(source, 'deaths'),
		damage: readNumber(source, 'damage'),
		xp: readNumber(source, 'xp'),
		level: readNumber(source, 'level'),
		reloadTimer: readNumber(source, 'reloadTimer'),
		respawnTimer: readNumber(source, 'respawnTimer'),
		invulnTimer: readNumber(source, 'invulnTimer'),
		alive: readBool(source, 'alive'),
		lastKeys: readNumber(source, 'lastKeys'),
		shield: readNumber(source, 'shield'),
		triple: readNumber(source, 'triple'),
		rapidTimer: readNumber(source, 'rapidTimer'),
		speedTimer: readNumber(source, 'speedTimer')
	};
}

function readBullet(source: Record<string, unknown>): BulletState | null {
	if (typeof source['owner'] !== 'string') return null;
	return {
		id: readNumber(source, 'id'),
		owner: source['owner'],
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		vx: readNumber(source, 'vx'),
		vy: readNumber(source, 'vy'),
		life: readNumber(source, 'life'),
		bounces: readNumber(source, 'bounces')
	};
}

function readPowerup(source: Record<string, unknown>): PowerupState | null {
	const kind = source['kind'];
	if (typeof kind !== 'string' || !POWERUP_KINDS.includes(kind as PowerupKind)) return null;
	return {
		id: readNumber(source, 'id'),
		kind: kind as PowerupKind,
		x: readNumber(source, 'x'),
		y: readNumber(source, 'y'),
		born: readNumber(source, 'born')
	};
}

/** Parse an untyped snapshot (e.g. from the wire). Null when malformed. */
export function parseTankSnapshot(state: GameStatePatch): TankSnapshot | null {
	const tick = state['tick'];
	if (typeof tick !== 'number') return null;
	const rawTanks = state['tanks'];
	const rawBullets = state['bullets'];
	const rawCrates = state['crates'];
	if (!Array.isArray(rawTanks) || !Array.isArray(rawBullets) || !Array.isArray(rawCrates)) {
		return null;
	}
	const tanks: TankState[] = [];
	for (const entry of rawTanks) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readTank(entry as Record<string, unknown>);
		if (!parsed) return null;
		tanks.push(parsed);
	}
	const bullets: BulletState[] = [];
	for (const entry of rawBullets) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readBullet(entry as Record<string, unknown>);
		if (!parsed) return null;
		bullets.push(parsed);
	}
	const crates: number[] = [];
	for (const entry of rawCrates) {
		if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
		crates.push(entry);
	}
	// Power-ups are optional on the wire (older payloads predate them).
	const rawPowerups = state['powerups'] ?? [];
	if (!Array.isArray(rawPowerups)) return null;
	const powerups: PowerupState[] = [];
	for (const entry of rawPowerups) {
		if (typeof entry !== 'object' || entry === null) return null;
		const parsed = readPowerup(entry as Record<string, unknown>);
		if (!parsed) return null;
		powerups.push(parsed);
	}
	return {
		tick,
		finished: state['finished'] === true,
		rngState: readNumber(state, 'rngState'),
		nextBulletId: readNumber(state, 'nextBulletId'),
		tanks,
		bullets,
		crates,
		powerups,
		nextPowerupId: readNumber(state, 'nextPowerupId')
	};
}

// ---- simulation ----

class TankSimulation implements TankSim {
	readonly arena: Arena;
	readonly countdownTicks: number;

	private readonly states: TankState[] = [];
	private readonly byId = new Map<PlayerId, TankState>();
	private readonly shotList: BulletState[] = [];
	private readonly crateList: number[];
	private readonly powerupList: PowerupState[] = [];
	private readonly events: GameEvent[] = [];
	private readonly rng: SimRng;
	private readonly durationTicks: number;
	private readonly tickRate: number;

	private currentTick = 0;
	private done = false;
	private nextBulletId = 1;
	private nextPowerupId = 1;

	constructor(seed: number, config: GameConfig, players: SimPlayer[]) {
		this.arena = getArena(String(config.options['arenaId'] ?? 'crossfire'));
		this.tickRate = config.tickRate > 0 ? config.tickRate : 60;
		this.durationTicks = Math.max(1, Math.floor(config.durationTicks));
		this.countdownTicks = Math.max(
			0,
			Math.floor(numOption(config.options, 'countdownTicks', DEFAULT_COUNTDOWN_TICKS))
		);
		this.rng = new SimRng(seed >>> 0);

		this.crateList = this.arena.tiles.map((tile) => (tile === 'crate' ? 2 : 0));

		// Seeded spawn scatter: shuffle the arena's spawn points, then seat
		// players in slot order so both sides see the same arena setup.
		const order = this.arena.spawns.map((_, i) => i);
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(this.rng.next() * (i + 1));
			const tmp = order[i];
			order[i] = order[j];
			order[j] = tmp;
		}
		players.forEach((player, index) => {
			const spawn = this.arena.spawns[order[index % order.length]];
			const state: TankState = {
				id: player.id,
				x: spawn.x,
				y: spawn.y,
				angle: 0,
				moveDir: 0,
				lives: START_LIVES,
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
				speedTimer: 0
			};
			this.states.push(state);
			this.byId.set(state.id, state);
			this.events.push({ kind: 'spawn', player: player.id });
		});
	}

	get tick(): number {
		return this.currentTick;
	}

	get finished(): boolean {
		return this.done;
	}

	get tanks(): readonly TankState[] {
		return this.states;
	}

	get bullets(): readonly BulletState[] {
		return this.shotList;
	}

	get crateHp(): readonly number[] {
		return this.crateList;
	}

	get powerups(): readonly PowerupState[] {
		return this.powerupList;
	}

	tickOnce(inputs: Map<PlayerId, InputFrame>): void {
		if (this.done) return;

		// Countdown is shared by everyone: 3/2/1/GO ticks the match start.
		if (this.countdownTicks > 0 && this.currentTick <= this.countdownTicks) {
			const step = this.countdownTicks / 3;
			if (Number.isInteger(this.currentTick / step)) {
				this.events.push({ kind: 'countdown', value: 3 - this.currentTick / step });
			}
		}
		const frozen = this.currentTick < this.countdownTicks;

		for (const tank of this.states) {
			const frame = inputs.get(tank.id);
			// Disconnected players keep their last input.
			const keys = frame ? frame.keys : tank.lastKeys;
			tank.lastKeys = keys;
			this.updateTank(tank, keys, frozen);
		}
		this.resolveTankPairs();
		this.stepBullets();

		// Level-ups ride the xp gained this tick.
		for (const tank of this.states) {
			const level = levelForXp(tank.xp);
			if (level > tank.level) {
				tank.level = level;
				this.events.push({ kind: 'collect', player: tank.id, item: 'levelup' });
			}
		}

		this.spawnPowerups();
		this.collectPowerups();

		this.currentTick++;
		const withLives = this.states.filter((t) => t.lives > 0).length;
		if ((this.states.length > 0 && withLives <= 1) || this.currentTick >= this.durationTicks) {
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
			nextBulletId: this.nextBulletId,
			tanks: this.states.map((t) => ({ ...t })),
			bullets: this.shotList.map((b) => ({ ...b })),
			crates: this.crateList.slice(),
			powerups: this.powerupList.map((p) => ({ ...p })),
			nextPowerupId: this.nextPowerupId
		};
	}

	restore(state: GameStatePatch): void {
		const snap = parseTankSnapshot(state);
		if (!snap) throw new Error('tank: invalid snapshot');
		this.currentTick = snap.tick;
		this.done = snap.finished;
		this.rng.state = snap.rngState | 0;
		this.nextBulletId = snap.nextBulletId | 0;
		this.nextPowerupId = Math.max(1, snap.nextPowerupId | 0);
		const byId = new Map(snap.tanks.map((t) => [t.id, t]));
		for (const target of this.states) {
			const src = byId.get(target.id);
			if (!src) continue;
			Object.assign(target, src, { id: target.id });
		}
		this.shotList.length = 0;
		for (const b of snap.bullets) this.shotList.push({ ...b });
		this.powerupList.length = 0;
		for (const p of snap.powerups) this.powerupList.push({ ...p });
		for (let i = 0; i < this.crateList.length; i++) {
			this.crateList[i] = i < snap.crates.length ? snap.crates[i] : this.crateList[i];
		}
	}

	results(): MatchResult[] {
		const ranked = this.states.slice().sort((a, b) => {
			if (b.lives !== a.lives) return b.lives - a.lives;
			if (b.kills !== a.kills) return b.kills - a.kills;
			if (b.damage !== a.damage) return b.damage - a.damage;
			if (b.xp !== a.xp) return b.xp - a.xp;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return ranked.map((t, i) => ({
			player: t.id,
			placement: i + 1,
			score: t.kills * 100 + t.damage * 10 + t.level * 50 + t.lives * 25,
			stats: {
				kills: t.kills,
				deaths: t.deaths,
				damage: t.damage,
				level: t.level,
				lives: t.lives
			}
		}));
	}

	hash(): number {
		let h = FNV_OFFSET;
		h = fnvInt(h, this.currentTick);
		h = fnvByte(h, this.done ? 1 : 0);
		h = fnvInt(h, this.rng.state);
		h = fnvInt(h, this.nextBulletId);
		h = fnvInt(h, this.nextPowerupId);
		for (const t of this.states) {
			h = fnvInt(h, quantize(t.x));
			h = fnvInt(h, quantize(t.y));
			h = fnvInt(h, quantize(t.angle));
			h = fnvInt(h, t.moveDir);
			h = fnvInt(h, t.lives);
			h = fnvInt(h, t.kills);
			h = fnvInt(h, t.deaths);
			h = fnvInt(h, t.damage);
			h = fnvInt(h, t.xp);
			h = fnvInt(h, t.level);
			h = fnvInt(h, t.reloadTimer);
			h = fnvInt(h, t.respawnTimer);
			h = fnvInt(h, t.invulnTimer);
			h = fnvInt(h, t.lastKeys);
			h = fnvByte(h, t.alive ? 1 : 0);
			h = fnvInt(h, t.shield);
			h = fnvInt(h, t.triple);
			h = fnvInt(h, t.rapidTimer);
			h = fnvInt(h, t.speedTimer);
		}
		for (const b of this.shotList) {
			h = fnvInt(h, b.id);
			h = fnvInt(h, quantize(b.x));
			h = fnvInt(h, quantize(b.y));
			h = fnvInt(h, quantize(b.vx));
			h = fnvInt(h, quantize(b.vy));
			h = fnvInt(h, b.life);
			h = fnvInt(h, b.bounces);
		}
		for (const p of this.powerupList) {
			h = fnvInt(h, p.id);
			h = fnvInt(h, POWERUP_KINDS.indexOf(p.kind));
			h = fnvInt(h, quantize(p.x));
			h = fnvInt(h, quantize(p.y));
			h = fnvInt(h, p.born);
		}
		for (const hp of this.crateList) h = fnvInt(h, hp);
		return h >>> 0;
	}

	// ---- per-tank update ----

	private updateTank(tank: TankState, keys: number, frozen: boolean): void {
		if (tank.invulnTimer > 0) tank.invulnTimer--;
		// Timed effects lapse through death too (death clears them anyway).
		if (tank.rapidTimer > 0) tank.rapidTimer--;
		if (tank.speedTimer > 0) tank.speedTimer--;

		if (!tank.alive) {
			if (tank.lives > 0 && tank.respawnTimer > 0) {
				tank.respawnTimer--;
				if (tank.respawnTimer <= 0) this.respawn(tank);
			}
			return;
		}

		tank.moveDir = 0;
		if (frozen) return;

		if ((keys & KEY.LEFT) !== 0) tank.angle -= TURN_PER_TICK;
		if ((keys & KEY.RIGHT) !== 0) tank.angle += TURN_PER_TICK;

		let speed = 0;
		const drive = speedScale(tank.level) * (tank.speedTimer > 0 ? SPEED_MULTIPLIER : 1);
		if ((keys & KEY.UP) !== 0) {
			tank.moveDir = 1;
			speed = BASE_FORWARD_SPEED * drive;
		} else if ((keys & KEY.DOWN) !== 0) {
			tank.moveDir = -1;
			speed = BASE_REVERSE_SPEED * drive;
		}
		if (speed !== 0) {
			const dx = Math.cos(tank.angle) * speed * tank.moveDir;
			const dy = Math.sin(tank.angle) * speed * tank.moveDir;
			this.moveTank(tank, dx, dy);
		}

		if (tank.reloadTimer > 0) tank.reloadTimer--;
		if ((keys & KEY.JUMP) !== 0 && tank.reloadTimer <= 0) this.fire(tank);
	}

	/**
	 * Fire one shell — or a 3-way spread while `triple` has shots left.
	 * `rapid` shortens the reload; both counters here are sim state, so every
	 * client predicts the same shells from the same snapshots.
	 */
	private fire(tank: TankState): void {
		const speed = bulletSpeed(tank.level);
		const angles =
			tank.triple > 0
				? [tank.angle - TRIPLE_SPREAD, tank.angle, tank.angle + TRIPLE_SPREAD]
				: [tank.angle];
		for (const angle of angles) {
			const dx = Math.cos(angle);
			const dy = Math.sin(angle);
			this.shotList.push({
				id: this.nextBulletId++,
				owner: tank.id,
				x: tank.x + dx * TURRET_LENGTH,
				y: tank.y + dy * TURRET_LENGTH,
				vx: dx * speed,
				vy: dy * speed,
				life: BULLET_LIFE,
				bounces: 0
			});
		}
		if (tank.triple > 0) tank.triple--;
		tank.reloadTimer = tank.rapidTimer > 0 ? rapidReloadTicks(tank.level) : reloadTicks(tank.level);
	}

	private respawn(tank: TankState): void {
		const spawn = this.pickSpawn(tank);
		tank.x = spawn.x;
		tank.y = spawn.y;
		tank.alive = true;
		tank.moveDir = 0;
		tank.reloadTimer = 0;
		tank.invulnTimer = INVULN_TICKS;
		this.events.push({ kind: 'spawn', player: tank.id });
	}

	/**
	 * Seeded respawn placement: prefer the spawn point farthest from any
	 * living enemy (ties broken by the rng).
	 */
	private pickSpawn(tank: TankState): ArenaPoint {
		const enemies = this.states.filter((o) => o.alive && o.id !== tank.id);
		let best = this.arena.spawns[0];
		let bestScore = -1;
		let ties = 0;
		for (const spawn of this.arena.spawns) {
			let score = Number.POSITIVE_INFINITY;
			for (const enemy of enemies) {
				const dx = spawn.x - enemy.x;
				const dy = spawn.y - enemy.y;
				score = Math.min(score, dx * dx + dy * dy);
			}
			if (!Number.isFinite(score)) score = 0;
			if (score > bestScore) {
				best = spawn;
				bestScore = score;
				ties = 1;
			} else if (score === bestScore) {
				ties++;
				if (this.rng.next() < 1 / ties) best = spawn;
			}
		}
		return best;
	}

	// ---- movement and collisions ----

	/** Axis-separated move with substeps, so nothing tunnels at any speed. */
	private moveTank(tank: TankState, dx: number, dy: number): void {
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 4));
		const stepX = dx / steps;
		const stepY = dy / steps;
		for (let i = 0; i < steps; i++) {
			this.moveTankAxis(tank, stepX, 0);
			this.moveTankAxis(tank, 0, stepY);
		}
	}

	private moveTankAxis(tank: TankState, dx: number, dy: number): void {
		tank.x += dx;
		tank.y += dy;
		// World bounds are solid.
		tank.x = clamp(tank.x, TANK_HALF, this.arena.cols * TILE_SIZE - TANK_HALF);
		tank.y = clamp(tank.y, TANK_HALF, this.arena.rows * TILE_SIZE - TANK_HALF);

		const minCol = Math.floor((tank.x - TANK_HALF) / TILE_SIZE);
		const maxCol = Math.floor((tank.x + TANK_HALF - 0.001) / TILE_SIZE);
		const minRow = Math.floor((tank.y - TANK_HALF) / TILE_SIZE);
		const maxRow = Math.floor((tank.y + TANK_HALF - 0.001) / TILE_SIZE);
		for (let row = minRow; row <= maxRow; row++) {
			for (let col = minCol; col <= maxCol; col++) {
				if (!isTankSolid(tileAt(this.arena, col, row))) continue;
				if (dx > 0) tank.x = col * TILE_SIZE - TANK_HALF;
				else if (dx < 0) tank.x = (col + 1) * TILE_SIZE + TANK_HALF;
				else if (dy > 0) tank.y = row * TILE_SIZE - TANK_HALF;
				else if (dy < 0) tank.y = (row + 1) * TILE_SIZE + TANK_HALF;
			}
		}
	}

	/** Push overlapping tanks apart along their shallowest axis (both stop). */
	private resolveTankPairs(): void {
		for (let i = 0; i < this.states.length; i++) {
			for (let j = i + 1; j < this.states.length; j++) {
				const a = this.states[i];
				const b = this.states[j];
				if (!a.alive || !b.alive) continue;
				const size = TANK_HALF * 2;
				const overlapX = size - Math.abs(a.x - b.x);
				const overlapY = size - Math.abs(a.y - b.y);
				if (overlapX <= 0 || overlapY <= 0) continue;
				if (overlapX < overlapY) {
					const dir = a.x <= b.x ? -1 : 1;
					const push = overlapX / 2;
					this.moveTankAxis(a, dir * push, 0);
					this.moveTankAxis(b, -dir * push, 0);
				} else {
					const dir = a.y <= b.y ? -1 : 1;
					const push = overlapY / 2;
					this.moveTankAxis(a, 0, dir * push);
					this.moveTankAxis(b, 0, -dir * push);
				}
			}
		}
	}

	// ---- bullets ----

	private stepBullets(): void {
		const surviving: BulletState[] = [];
		for (const bullet of this.shotList) {
			bullet.life--;
			if (bullet.life <= 0) continue;
			const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bullet.vx), Math.abs(bullet.vy)) / 4));
			let dead = false;
			for (let s = 0; s < steps && !dead; s++) {
				// Each substep reads the live velocity so a bounce mid-tick
				// redirects the remaining substeps immediately.
				dead = this.stepBulletOnce(bullet, steps);
			}
			if (!dead) surviving.push(bullet);
		}
		this.shotList.length = 0;
		for (const bullet of surviving) this.shotList.push(bullet);
	}

	private stepBulletOnce(bullet: BulletState, steps: number): boolean {
		const oldX = bullet.x;
		const oldY = bullet.y;
		bullet.x += bullet.vx / steps;
		bullet.y += bullet.vy / steps;

		const tile = this.bulletTileAt(bullet.x, bullet.y);
		if (isBulletSolid(tile)) {
			if (tile === 'crate') {
				this.damageCrateAt(bullet.x, bullet.y, bullet.owner);
				return true;
			}
			// Wall: bounce once (twice at max level), die on the next impact.
			if (bullet.bounces >= maxBounces(this.levelOf(bullet.owner))) return true;
			const blockX = this.bulletTileBlocked(bullet.x, oldY);
			const blockY = this.bulletTileBlocked(oldX, bullet.y);
			if (blockX && blockY) {
				bullet.vx = -bullet.vx;
				bullet.vy = -bullet.vy;
				bullet.x = oldX;
				bullet.y = oldY;
			} else if (blockX) {
				bullet.vx = -bullet.vx;
				bullet.x = oldX;
			} else {
				bullet.vy = -bullet.vy;
				bullet.y = oldY;
			}
			bullet.bounces++;
		}

		for (const tank of this.states) {
			if (!tank.alive || tank.invulnTimer > 0) continue;
			if (
				Math.abs(bullet.x - tank.x) < TANK_HALF + 1 &&
				Math.abs(bullet.y - tank.y) < TANK_HALF + 1
			) {
				this.hitTank(tank, bullet.owner);
				return true;
			}
		}
		return false;
	}

	private levelOf(id: PlayerId): number {
		return this.byId.get(id)?.level ?? 1;
	}

	private bulletTileAt(x: number, y: number): 'wall' | 'crate' | 'floor' {
		if (x < 0 || y < 0 || x >= this.arena.cols * TILE_SIZE || y >= this.arena.rows * TILE_SIZE) {
			return 'wall';
		}
		const col = Math.floor(x / TILE_SIZE);
		const row = Math.floor(y / TILE_SIZE);
		const index = row * this.arena.cols + col;
		if (this.crateList[index] > 0) return 'crate';
		return isBulletSolid(tileAt(this.arena, col, row)) ? 'wall' : 'floor';
	}

	private bulletTileBlocked(x: number, y: number): boolean {
		return this.bulletTileAt(x, y) !== 'floor';
	}

	private damageCrateAt(x: number, y: number, owner: PlayerId): void {
		const col = Math.floor(x / TILE_SIZE);
		const row = Math.floor(y / TILE_SIZE);
		const index = row * this.arena.cols + col;
		if (this.crateList[index] <= 0) return;
		this.crateList[index]--;
		if (this.crateList[index] === 0) {
			this.events.push({ kind: 'collect', player: owner, item: 'crate' });
			// Destroyed crates may drop a power-up (seeded 50%, respects the cap).
			if (this.rng.next() < CRATE_DROP_CHANCE && this.powerupList.length < POWERUP_MAX_ALIVE) {
				const kind = POWERUP_KINDS[Math.floor(this.rng.next() * POWERUP_KINDS.length)];
				this.addPowerup(kind, tileCenter(col, row), this.currentTick);
			}
		}
	}

	/**
	 * One bullet hit = one life lost. The shooter earns damage + xp; the kill
	 * and the bigger xp prize only pay out when the hit eliminates the victim.
	 * Self-hits count (classic and funny).
	 *
	 * A `shield` charge absorbs exactly one shell instead: no life is lost, no
	 * xp is paid, and the hit is signalled with the existing `hit` event at
	 * `force: 0` (deliberate protocol choice — see the file header) so every
	 * client can pop the bubble without a new event kind.
	 */
	private hitTank(tank: TankState, shooterId: PlayerId): void {
		if (tank.shield > 0) {
			tank.shield = 0;
			this.events.push({ kind: 'hit', player: tank.id, by: shooterId, force: 0 });
			return;
		}
		tank.lives = Math.max(0, tank.lives - 1);
		tank.deaths++;
		tank.alive = false;
		tank.moveDir = 0;
		// The wreck drops every transient effect (shield is already spent above).
		tank.triple = 0;
		tank.rapidTimer = 0;
		tank.speedTimer = 0;
		this.events.push({ kind: 'hit', player: tank.id, by: shooterId, force: 1 });
		this.events.push({ kind: 'death', player: tank.id, cause: 'bullet' });

		const shooter = this.byId.get(shooterId);
		if (shooter) {
			shooter.damage++;
			shooter.xp += XP_PER_HIT;
		}
		if (tank.lives <= 0) {
			tank.respawnTimer = 0;
			if (shooter) {
				shooter.kills++;
				shooter.xp += XP_PER_KILL;
			}
			this.events.push({
				kind: 'finish',
				player: tank.id,
				timeMs: Math.round((this.currentTick * 1000) / this.tickRate)
			});
		} else {
			tank.respawnTimer = RESPAWN_TICKS;
		}
	}

	// ---- power-ups ----

	/** Deterministic cadence: one spawn every POWERUP_SPAWN_INTERVAL ticks. */
	private spawnPowerups(): void {
		if (this.currentTick === 0 || this.currentTick % POWERUP_SPAWN_INTERVAL !== 0) return;
		if (this.powerupList.length >= POWERUP_MAX_ALIVE) return;
		const candidates = this.freePowerupTiles();
		if (candidates.length === 0) return;
		const spot = candidates[Math.floor(this.rng.next() * candidates.length)];
		const kind = POWERUP_KINDS[Math.floor(this.rng.next() * POWERUP_KINDS.length)];
		this.addPowerup(kind, spot, this.currentTick);
	}

	/**
	 * Floor tiles a pickup may appear on: never inside walls/water/crates, and
	 * never under tanks, bullets or other pickups (nobody gets one dropped on
	 * their head mid-fight).
	 */
	private freePowerupTiles(): ArenaPoint[] {
		const out: ArenaPoint[] = [];
		for (let row = 0; row < this.arena.rows; row++) {
			for (let col = 0; col < this.arena.cols; col++) {
				if (tileAt(this.arena, col, row) !== 'floor') continue;
				const spot = tileCenter(col, row);
				if (this.powerupSpotFree(spot)) out.push(spot);
			}
		}
		return out;
	}

	private powerupSpotFree(spot: ArenaPoint): boolean {
		for (const tank of this.states) {
			if (!tank.alive) continue;
			const dx = tank.x - spot.x;
			const dy = tank.y - spot.y;
			if (dx * dx + dy * dy < 24 * 24) return false;
		}
		for (const b of this.shotList) {
			const dx = b.x - spot.x;
			const dy = b.y - spot.y;
			if (dx * dx + dy * dy < 12 * 12) return false;
		}
		for (const p of this.powerupList) {
			const dx = p.x - spot.x;
			const dy = p.y - spot.y;
			if (dx * dx + dy * dy < 24 * 24) return false;
		}
		return true;
	}

	private addPowerup(kind: PowerupKind, spot: ArenaPoint, born: number): void {
		this.powerupList.push({
			id: this.nextPowerupId++,
			kind,
			x: spot.x,
			y: spot.y,
			born
		});
	}

	/** Driving over a pickup collects it once its grace ticks have passed. */
	private collectPowerups(): void {
		for (let i = this.powerupList.length - 1; i >= 0; i--) {
			const powerup = this.powerupList[i];
			if (this.currentTick - powerup.born < POWERUP_GRACE_TICKS) continue;
			const radius2 = POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS;
			const tank = this.states.find((t) => {
				if (!t.alive) return false;
				const dx = t.x - powerup.x;
				const dy = t.y - powerup.y;
				return dx * dx + dy * dy <= radius2;
			});
			if (!tank) continue;
			this.applyPowerup(tank, powerup.kind);
			this.powerupList.splice(i, 1);
			this.events.push({ kind: 'collect', player: tank.id, item: `powerup:${powerup.kind}` });
		}
	}

	private applyPowerup(tank: TankState, kind: PowerupKind): void {
		switch (kind) {
			case 'shield':
				tank.shield = 1;
				break;
			case 'triple':
				tank.triple = Math.min(TRIPLE_SHOTS, tank.triple + TRIPLE_SHOTS);
				break;
			case 'rapid':
				tank.rapidTimer = EFFECT_TICKS;
				break;
			case 'speed':
				tank.speedTimer = EFFECT_TICKS;
				break;
		}
	}
}

export function createTankSim(seed: number, config: GameConfig, players: SimPlayer[]): TankSim {
	return new TankSimulation(seed, config, players);
}
