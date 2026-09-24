/**
 * Pixel Tanks renderer/client. Draws the arena, tanks, shells and HUD on the
 * fixed 480x270 PixelCanvas, predicts the local tank through a private sim fed
 * by local input, and interpolates remote tanks/bullets from server snapshots
 * buffered ~100ms in the past. The camera is pinned to the arena (the whole
 * 30x17 map is visible) and only shakes on explosions.
 */
import type {
	GameClient,
	GameContext,
	GameEvent,
	GameStatePatch,
	InputFrame,
	PlayerId,
	SimPlayer
} from '../types';
import { AudioManager } from '../engine/audio';
import { PixelCanvas, type CanvasSourceLike } from '../engine/gfx';
import { InputManager } from '../engine/input';
import { FixedTimestepLoop } from '../engine/loop';
import { Camera } from '../engine/camera';
import { ParticleSystem } from '../engine/particles';
import { nowMs } from '../engine/fixed';
import { mulberry32 } from '../engine/rng';
import { TILE_SIZE, tileAt } from './arena';
import {
	BULLET_LIFE,
	TANK_HALF,
	createTankSim,
	parseTankSnapshot,
	reloadTicks,
	type BulletState,
	type TankSim,
	type TankState
} from './sim';

// ---- palette ----

const BG = '#14162b';
const FLOOR_A = '#242739';
const FLOOR_B = '#1f2231';
const WALL = '#6c7488';
const WALL_LIGHT = '#9aa3b8';
const WALL_DARK = '#454b60';
const CRATE = '#b07a3c';
const CRATE_LIGHT = '#d29a5c';
const CRATE_DARK = '#7a5222';
const CRATE_CRACK = '#5c3c18';
const WATER_A = '#274b8f';
const WATER_B = '#3c6fc4';
const BUSH_A = '#3e8e3f';
const BUSH_B = '#56b45a';
const TRACK = '#22252f';
const TRACK_LIGHT = '#3a3f52';
const BARREL = '#e8e8f0';
const TEXT = '#e8e8f0';
const TEXT_DIM = '#8b97b5';
const PANEL = '#22263a';
const PANEL_EDGE = '#1a1c2c';
const BULLET_CORE = '#ffe066';
const BULLET_TRAIL = '#ff9f43';

const MAX_REMOTE_SAMPLES = 32;
const FEED_SECONDS = 4.5;

/** GameClient plus canvas fitting (GameShell calls it via optional cast). */
export interface TankClient extends GameClient {
	/** Fit the canvas backing store (internal resolution stays 480x270). */
	resize(cssWidth: number, cssHeight: number): void;
}

type RemoteSample = {
	tick: number;
	tanks: Map<PlayerId, TankState>;
	bullets: Map<number, BulletState>;
	crates: number[];
};

type Explosion = { x: number; y: number; age: number; life: number; size: number; color: string };
type Burst = { x: number; y: number; age: number; life: number };
type FeedEntry = { killer: string; victim: string; age: number };

class TankClientImpl implements TankClient {
	private readonly ctx: GameContext;
	private readonly pixel: PixelCanvas;
	private readonly input = new InputManager();
	private readonly audio = new AudioManager();
	private readonly loop: FixedTimestepLoop;
	private readonly camera: Camera;
	private readonly particles: ParticleSystem;

	/** Private prediction sim: only the local player drives it. */
	private readonly sim: TankSim;
	private readonly tickInputs = new Map<PlayerId, InputFrame>();
	private readonly playersById: Map<PlayerId, SimPlayer>;

	private readonly remoteSamples: RemoteSample[] = [];
	private readonly explosions: Explosion[] = [];
	private readonly bursts: Burst[] = [];
	private readonly feed: FeedEntry[] = [];
	/** killer recorded from `hit` events so `death` can fill the kill feed. */
	private readonly pendingKiller = new Map<PlayerId, PlayerId>();

	/** Authoritative crate hit points (latest snapshot, else the local sim). */
	private displayCrates: number[] = [];
	private countdownValue = -1;
	private countdownAge = 99;
	private animFrame = 0;
	private prevSelfReload = 0;
	private lastFrameMs = nowMs();

	constructor(ctx: GameContext) {
		this.ctx = ctx;
		this.pixel = new PixelCanvas(ctx.canvas as unknown as CanvasSourceLike, {
			width: 480,
			height: 270
		});
		this.sim = createTankSim(ctx.seed, ctx.config, ctx.players);
		this.displayCrates = this.sim.crateHp.slice();
		this.playersById = new Map(ctx.players.map((p) => [p.id, p]));
		this.camera = new Camera({
			width: 480,
			height: 270,
			zoom: 1,
			lookAhead: 0,
			shakeScale: 7,
			shakeDecay: 1.6
		});
		this.camera.setPosition(
			(this.sim.arena.cols * TILE_SIZE) / 2,
			(this.sim.arena.rows * TILE_SIZE) / 2
		);
		this.particles = new ParticleSystem({ capacity: 256, rng: mulberry32(0xc0ffee) });
		this.loop = new FixedTimestepLoop({
			tickRate: ctx.config.tickRate,
			onTick: () => this.onTick(),
			onRender: (alpha) => this.onRender(alpha)
		});
	}

	start(): void {
		this.audio.unlock();
		this.input.attach();
		this.lastFrameMs = nowMs();
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
		this.input.detach();
		this.particles.clear();
	}

	resize(cssWidth: number, cssHeight: number): void {
		this.pixel.resize(cssWidth, cssHeight);
	}

	/** Server snapshots carry every tank + shell; we interpolate the remotes. */
	onSnapshot(patch: GameStatePatch): void {
		const snap = parseTankSnapshot(patch);
		if (!snap) return;
		const tanks = new Map<PlayerId, TankState>();
		for (const t of snap.tanks) tanks.set(t.id, t);
		const bullets = new Map<number, BulletState>();
		for (const b of snap.bullets) bullets.set(b.id, b);
		this.remoteSamples.push({ tick: snap.tick, tanks, bullets, crates: snap.crates });
		if (this.remoteSamples.length > MAX_REMOTE_SAMPLES) this.remoteSamples.shift();
	}

	onEvent(ev: GameEvent): void {
		switch (ev.kind) {
			case 'spawn': {
				const pos = this.displayTank(ev.player);
				if (pos) this.bursts.push({ x: pos.x, y: pos.y, age: 0, life: 0.5 });
				this.audio.sfx.click();
				break;
			}
			case 'hit': {
				this.pendingKiller.set(ev.player, ev.by);
				const pos = this.displayTank(ev.player);
				if (pos) {
					this.particles.emit({
						kind: 'spark',
						x: pos.x,
						y: pos.y,
						count: 6,
						speed: 110,
						color: '#ffd166'
					});
				}
				this.camera.addTrauma(0.1);
				this.audio.sfx.click();
				break;
			}
			case 'death': {
				const pos = this.displayTank(ev.player);
				if (pos) this.spawnExplosion(pos.x, pos.y, 0.35);
				const victim = this.playersById.get(ev.player);
				const killerId = this.pendingKiller.get(ev.player) ?? ev.player;
				const killer = this.playersById.get(killerId);
				this.feed.push({
					killer: (killer?.name ?? killerId).toUpperCase(),
					victim: (victim?.name ?? ev.player).toUpperCase(),
					age: 0
				});
				if (this.feed.length > 5) this.feed.shift();
				this.audio.sfx.death();
				break;
			}
			case 'collect': {
				const pos = this.displayTank(ev.player);
				if (ev.item === 'levelup') {
					if (pos) this.bursts.push({ x: pos.x, y: pos.y, age: 0, life: 0.7 });
					this.audio.sfx.boost();
				} else {
					this.audio.sfx.click();
				}
				break;
			}
			case 'countdown':
				this.countdownValue = ev.value;
				this.countdownAge = 0;
				this.audio.sfx.countdown();
				break;
			case 'finish':
			case 'match-end':
				this.audio.sfx.finish();
				break;
			default:
				break;
		}
	}

	// ---- fixed tick: sample input, send it, predict locally ----

	private onTick(): void {
		this.input.pollGamepads();
		const frame = this.input.sample();
		this.ctx.sendInput(frame);
		this.tickInputs.set(this.ctx.selfId, frame);
		this.sim.tickOnce(this.tickInputs);

		// Fire blip from the local prediction (firing is not a GameEvent).
		const self = this.sim.tanks.find((t) => t.id === this.ctx.selfId);
		if (self && self.reloadTimer > this.prevSelfReload) this.audio.sfx.jump();
		this.prevSelfReload = self ? self.reloadTimer : 0;
	}

	// ---- render ----

	private onRender(alpha: number): void {
		const now = nowMs();
		const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
		this.lastFrameMs = now;
		this.animFrame++;
		this.countdownAge += dt;
		this.particles.update(dt);
		this.camera.follow(
			(this.sim.arena.cols * TILE_SIZE) / 2,
			(this.sim.arena.rows * TILE_SIZE) / 2,
			dt
		);
		for (const e of this.explosions) e.age += dt;
		for (const b of this.bursts) b.age += dt;
		for (const f of this.feed) f.age += dt;
		this.removeExpired(this.explosions, (e) => e.age >= e.life);
		this.removeExpired(this.bursts, (b) => b.age >= b.life);
		this.removeExpired(this.feed, (f) => f.age >= FEED_SECONDS);
		this.syncCrates();

		const pixel = this.pixel;
		pixel.clear(BG);
		pixel.ctx.save();
		this.camera.applyTo(pixel.ctx);

		this.drawFloor();
		this.drawWater();
		this.drawCrates();
		this.drawWalls();
		this.drawShells(alpha);
		this.drawTanks(alpha);
		this.particles.draw(pixel.ctx);
		this.drawEffects();
		this.drawBushes();

		pixel.ctx.restore();
		this.drawHud();
	}

	private removeExpired<T>(list: T[], expired: (item: T) => boolean): void {
		for (let i = list.length - 1; i >= 0; i--) {
			if (expired(list[i])) list.splice(i, 1);
		}
	}

	/** Debris whenever a crate loses a hit point (works for remote shooters too). */
	private syncCrates(): void {
		const target = this.latestCrates();
		for (let i = 0; i < this.displayCrates.length && i < target.length; i++) {
			if (target[i] < this.displayCrates[i]) {
				const col = i % this.sim.arena.cols;
				const row = Math.floor(i / this.sim.arena.cols);
				const x = col * TILE_SIZE + TILE_SIZE / 2;
				const y = row * TILE_SIZE + TILE_SIZE / 2;
				this.particles.emit({
					kind: 'pop',
					x,
					y,
					count: target[i] === 0 ? 10 : 5,
					speed: 90,
					color: CRATE
				});
				if (target[i] === 0) this.spawnExplosion(x, y, 0.12, CRATE_LIGHT);
			}
		}
		this.displayCrates = target;
	}

	private latestCrates(): number[] {
		const last = this.remoteSamples[this.remoteSamples.length - 1];
		return last ? last.crates : this.sim.crateHp.slice();
	}

	private spawnExplosion(x: number, y: number, trauma: number, color = '#ff9f43'): void {
		this.explosions.push({ x, y, age: 0, life: 0.45, size: 16, color });
		this.particles.emit({ kind: 'ring', x, y, size: 22, life: 0.4, color: '#ffd166' });
		this.particles.emit({ kind: 'pop', x, y, count: 14, speed: 130, color });
		this.particles.emit({ kind: 'dust', x, y, count: 8, speed: 60, color: '#8b97b5' });
		this.camera.addTrauma(trauma);
	}

	/** Latest known state of a tank (snapshot first, local prediction fallback). */
	private displayTank(id: PlayerId): TankState | null {
		const last = this.remoteSamples[this.remoteSamples.length - 1];
		if (last) {
			const t = last.tanks.get(id);
			if (t) return t;
		}
		return this.sim.tanks.find((t) => t.id === id) ?? null;
	}

	// ---- arena drawing ----

	private drawFloor(): void {
		const arena = this.sim.arena;
		const pixel = this.pixel;
		for (let row = 0; row < arena.rows; row++) {
			for (let col = 0; col < arena.cols; col++) {
				if (tileAt(arena, col, row) !== 'floor' && tileAt(arena, col, row) !== 'bush') continue;
				pixel.fillRect(
					col * TILE_SIZE,
					row * TILE_SIZE,
					TILE_SIZE,
					TILE_SIZE,
					(row + col) % 2 === 0 ? FLOOR_A : FLOOR_B
				);
			}
		}
	}

	private drawWater(): void {
		const arena = this.sim.arena;
		const pixel = this.pixel;
		const phase = Math.floor(this.animFrame / 30) % 2;
		for (let row = 0; row < arena.rows; row++) {
			for (let col = 0; col < arena.cols; col++) {
				if (tileAt(arena, col, row) !== 'water') continue;
				const x = col * TILE_SIZE;
				const y = row * TILE_SIZE;
				pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, WATER_A);
				// 2-frame shimmer.
				const offset = (col + row + phase) % 2 === 0 ? 3 : 9;
				pixel.fillRect(x + offset, y + 4, 6, 2, WATER_B);
				pixel.fillRect(x + (offset === 3 ? 9 : 3), y + 11, 5, 2, WATER_B);
			}
		}
	}

	private drawCrates(): void {
		const arena = this.sim.arena;
		const pixel = this.pixel;
		for (let row = 0; row < arena.rows; row++) {
			for (let col = 0; col < arena.cols; col++) {
				if (tileAt(arena, col, row) !== 'crate') continue;
				const hp = this.displayCrates[row * arena.cols + col] ?? 0;
				if (hp <= 0) continue;
				const x = col * TILE_SIZE;
				const y = row * TILE_SIZE;
				pixel.fillRect(x + 1, y + 1, 14, 14, CRATE);
				pixel.fillRect(x + 1, y + 1, 14, 2, CRATE_LIGHT);
				pixel.fillRect(x + 1, y + 13, 14, 2, CRATE_DARK);
				pixel.rect(x + 1.5, y + 1.5, 13, 13, CRATE_DARK);
				// Cross braces.
				pixel.line(x + 2, y + 2, x + 14, y + 14, CRATE_DARK);
				pixel.line(x + 14, y + 2, x + 2, y + 14, CRATE_DARK);
				if (hp === 1) {
					// Damaged: cracks.
					pixel.line(x + 4, y + 3, x + 8, y + 8, CRATE_CRACK);
					pixel.line(x + 8, y + 8, x + 6, y + 13, CRATE_CRACK);
					pixel.line(x + 11, y + 5, x + 13, y + 10, CRATE_CRACK);
				}
			}
		}
	}

	private drawWalls(): void {
		const arena = this.sim.arena;
		const pixel = this.pixel;
		for (let row = 0; row < arena.rows; row++) {
			for (let col = 0; col < arena.cols; col++) {
				if (tileAt(arena, col, row) !== 'wall') continue;
				const x = col * TILE_SIZE;
				const y = row * TILE_SIZE;
				pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, WALL);
				pixel.fillRect(x, y, TILE_SIZE, 3, WALL_LIGHT);
				pixel.fillRect(x, y, 3, TILE_SIZE, WALL_LIGHT);
				pixel.fillRect(x, y + TILE_SIZE - 3, TILE_SIZE, 3, WALL_DARK);
				pixel.fillRect(x + TILE_SIZE - 3, y, 3, TILE_SIZE, WALL_DARK);
				pixel.fillRect(x + 5, y + 5, 6, 6, WALL_DARK);
			}
		}
	}

	private drawBushes(): void {
		const arena = this.sim.arena;
		const pixel = this.pixel;
		for (let row = 0; row < arena.rows; row++) {
			for (let col = 0; col < arena.cols; col++) {
				if (tileAt(arena, col, row) !== 'bush') continue;
				const x = col * TILE_SIZE;
				const y = row * TILE_SIZE;
				const jitter = (col * 7 + row * 13) % 5;
				pixel.fillRect(x + 1 + jitter, y + 2, 6, 5, BUSH_A);
				pixel.fillRect(x + 8, y + 6 + (jitter % 3), 6, 6, BUSH_B);
				pixel.fillRect(x + 3, y + 9, 5, 5, BUSH_A);
				pixel.fillRect(x + 10, y + 1, 4, 4, BUSH_B);
			}
		}
	}

	// ---- entities ----

	/**
	 * Local shells come from the prediction sim (immediate); remote shells come
	 * from the snapshot buffer. Muzzle flashes derive from young shells.
	 */
	private drawShells(alpha: number): void {
		for (const b of this.sim.bullets) {
			if (b.owner !== this.ctx.selfId) continue;
			this.drawShell(b);
		}
		const renderTick =
			this.sim.tick - Math.max(1, Math.round(this.ctx.config.tickRate * 0.1)) + alpha;
		for (const b of this.remoteBullets(renderTick)) {
			if (b.owner === this.ctx.selfId) continue;
			this.drawShell(b);
		}
	}

	private drawShell(b: BulletState): void {
		const pixel = this.pixel;
		pixel.line(b.x - b.vx * 1.5, b.y - b.vy * 1.5, b.x, b.y, BULLET_TRAIL);
		pixel.fillRect(b.x - 1, b.y - 1, 3, 3, BULLET_CORE);
		if (b.bounces > 0) pixel.fillRect(b.x - 2, b.y - 2, 5, 5, 'rgba(255,209,102,0.35)');
		if (b.life > BULLET_LIFE - 3) {
			pixel.fillRect(b.x - 3, b.y - 3, 7, 7, 'rgba(255,224,102,0.5)');
		}
	}

	private drawTanks(alpha: number): void {
		const renderTick =
			this.sim.tick - Math.max(1, Math.round(this.ctx.config.tickRate * 0.1)) + alpha;
		for (const player of this.ctx.players) {
			if (player.id === this.ctx.selfId) continue;
			const sample = this.nearestSample(renderTick, player.id);
			const pos = this.remoteTankPos(player.id, renderTick) ?? sample;
			if (!pos) continue;
			if (!pos.alive) {
				this.drawRespawnLabel(pos.x, pos.y, pos.respawnTimer);
				continue;
			}
			this.drawTank(pos, player.color);
		}
		const self = this.sim.tanks.find((t) => t.id === this.ctx.selfId);
		const meta = this.playersById.get(this.ctx.selfId);
		if (self && meta) {
			if (!self.alive) this.drawRespawnLabel(self.x, self.y, self.respawnTimer);
			else this.drawTank(self, meta.color);
		}
	}

	private drawTank(tank: TankState, color: string): void {
		const pixel = this.pixel;
		// Invulnerability blink: skip every other stretch of frames.
		if (tank.invulnTimer > 0 && Math.floor(this.animFrame / 3) % 2 === 0) return;
		const ctx = pixel.ctx;
		ctx.save();
		ctx.translate(Math.round(tank.x), Math.round(tank.y));
		ctx.rotate(tank.angle);
		// Tracks.
		pixel.fillRect(-7, -6, 14, 2, TRACK);
		pixel.fillRect(-7, 4, 14, 2, TRACK);
		if (tank.moveDir !== 0) {
			const off = Math.floor(this.animFrame / 4) % 2;
			for (let i = 0; i < 4; i++) {
				pixel.fillRect(-6 + i * 3 + off, -6, 1, 2, TRACK_LIGHT);
				pixel.fillRect(-6 + i * 3 + off, 4, 1, 2, TRACK_LIGHT);
			}
		}
		// Hull with top highlight / bottom shade.
		pixel.fillRect(-6, -4, 12, 8, color);
		pixel.fillRect(-6, -4, 12, 2, 'rgba(255,255,255,0.22)');
		pixel.fillRect(-6, 2, 12, 2, 'rgba(0,0,0,0.28)');
		// Turret + barrel.
		pixel.fillRect(-3, -3, 6, 6, color);
		pixel.fillRect(-3, -3, 6, 2, 'rgba(255,255,255,0.22)');
		pixel.fillRect(1, -1, 9, 2, BARREL);
		pixel.fillRect(9, -2, 3, 4, '#c9c9d6');
		ctx.restore();
		// Muzzle flash on the fire ticks.
		const justFired = tank.reloadTimer >= reloadTicks(tank.level) - 3;
		if (justFired) {
			const dx = Math.cos(tank.angle);
			const dy = Math.sin(tank.angle);
			const fx = tank.x + dx * (TANK_HALF + 7);
			const fy = tank.y + dy * (TANK_HALF + 7);
			pixel.fillRect(fx - 3, fy - 3, 6, 6, 'rgba(255,224,102,0.85)');
			pixel.fillRect(fx - 1, fy - 5, 2, 10, 'rgba(255,159,67,0.8)');
			pixel.fillRect(fx - 5, fy - 1, 10, 2, 'rgba(255,159,67,0.8)');
		}
		if (tank.invulnTimer > 0) {
			pixel.circle(tank.x, tank.y, TANK_HALF + 3, 'rgba(110,198,255,0.5)', false);
		}
	}

	private drawRespawnLabel(x: number, y: number, respawnTimer: number): void {
		const seconds = Math.max(1, Math.ceil(respawnTimer / 60));
		const label = `RESPAWNING ${seconds}`;
		this.pixel.text(label, x - this.pixel.textWidth(label, 1) / 2, y - 20, TEXT_DIM, 1);
	}

	private drawEffects(): void {
		const pixel = this.pixel;
		for (const e of this.explosions) {
			const t = e.age / e.life;
			pixel.ctx.globalAlpha = Math.max(0, 1 - t);
			const r = e.size * (0.3 + 0.7 * t);
			pixel.circle(e.x, e.y, r, e.color, false);
			pixel.fillRect(e.x - r * 0.4, e.y - r * 0.4, r * 0.8, r * 0.8, e.color);
			pixel.fillRect(e.x - 1, e.y - 1, 3, 3, '#ffe066');
			pixel.ctx.globalAlpha = 1;
		}
		for (const b of this.bursts) {
			const t = b.age / b.life;
			pixel.ctx.globalAlpha = Math.max(0, 1 - t);
			for (let i = 0; i < 6; i++) {
				const angle = (Math.PI * 2 * i) / 6 + t * 2;
				const r = 6 + 16 * t;
				const sx = b.x + Math.cos(angle) * r;
				const sy = b.y + Math.sin(angle) * r;
				pixel.fillRect(sx - 1, sy - 1, 3, 3, '#ffd166');
			}
			pixel.ctx.globalAlpha = 1;
		}
	}

	// ---- HUD ----

	private drawHud(): void {
		const pixel = this.pixel;
		const tanks = this.ctx.players
			.map((p) => ({ meta: p, state: this.displayTank(p.id) }))
			.filter((e): e is { meta: SimPlayer; state: TankState } => e.state !== null);
		const n = tanks.length;
		tanks.forEach((entry, i) => {
			let x: number;
			let y: number;
			if (n <= 4) {
				x = i % 2 === 0 ? 4 : 480 - 122;
				y = i < 2 ? 4 : 270 - 26;
			} else {
				x = 4 + (i % 4) * 118;
				y = i < 4 ? 4 : 270 - 26;
			}
			this.drawCard(x, y, entry.meta, entry.state);
		});

		// Kill feed, top right under the cards.
		const feedTop = n <= 4 ? 28 : 30;
		this.feed.forEach((f, i) => {
			const label = `${f.killer} > ${f.victim}`;
			const w = pixel.textWidth(label, 1);
			pixel.ctx.globalAlpha = Math.max(0, 1 - f.age / FEED_SECONDS);
			pixel.text(label, 476 - w, feedTop + i * 10, TEXT_DIM, 1);
			pixel.ctx.globalAlpha = 1;
		});

		// Match start countdown.
		if (this.countdownAge < 1 && this.countdownValue >= 0) {
			const label = this.countdownValue === 0 ? 'GO!' : String(this.countdownValue);
			const scale = 4;
			pixel.ctx.globalAlpha = Math.max(0, 1 - this.countdownAge);
			pixel.text(label, 240 - pixel.textWidth(label, scale) / 2, 110, TEXT, scale);
			pixel.ctx.globalAlpha = 1;
		}

		this.drawLocalOverlay();
	}

	private drawCard(x: number, y: number, meta: SimPlayer, state: TankState): void {
		const pixel = this.pixel;
		const isSelf = meta.id === this.ctx.selfId;
		pixel.fillRect(x, y, 118, 22, PANEL);
		pixel.rect(x + 0.5, y + 0.5, 117, 21, isSelf ? meta.color : PANEL_EDGE);
		pixel.fillRect(x + 3, y + 3, 5, 5, meta.color);
		pixel.text(meta.name.slice(0, 8).toUpperCase(), x + 11, y + 3, isSelf ? TEXT : TEXT_DIM, 1);
		pixel.text(`K${state.kills}`, x + 92, y + 3, TEXT_DIM, 1);
		// Level as stars.
		for (let i = 0; i < state.level; i++) this.drawStar(x + 11 + i * 5, y + 13, '#ffd166');
		// Lives as tank icons.
		for (let i = 0; i < Math.min(3, state.lives); i++) {
			pixel.fillRect(x + 40 + i * 7, y + 13, 5, 3, meta.color);
			pixel.fillRect(x + 44 + i * 7, y + 14, 2, 1, meta.color);
		}
		if (!state.alive) pixel.text('OUT', x + 66, y + 13, '#ff5c7a', 1);
	}

	private drawStar(x: number, y: number, color: string): void {
		const pixel = this.pixel;
		pixel.fillRect(x + 1, y, 1, 1, color);
		pixel.fillRect(x, y + 1, 3, 1, color);
		pixel.fillRect(x + 1, y + 2, 1, 1, color);
	}

	private drawLocalOverlay(): void {
		const self = this.sim.tanks.find((t) => t.id === this.ctx.selfId);
		if (!self || self.alive) return;
		const pixel = this.pixel;
		pixel.ctx.globalAlpha = 0.35;
		pixel.fillRect(0, 0, 480, 270, '#000000');
		pixel.ctx.globalAlpha = 1;
		if (self.lives > 0) {
			const label = 'RESPAWNING';
			pixel.text(label, 240 - pixel.textWidth(label, 2) / 2, 118, TEXT, 2);
			const n = String(Math.max(1, Math.ceil(self.respawnTimer / 60)));
			pixel.text(n, 240 - pixel.textWidth(n, 4) / 2, 136, TEXT, 4);
		} else {
			const label = 'ELIMINATED - WATCHING';
			pixel.text(label, 240 - pixel.textWidth(label, 2) / 2, 118, '#ff5c7a', 2);
			const place = this.sim.results().find((r) => r.player === self.id)?.placement ?? 0;
			const line = `PLACE ${place}`;
			pixel.text(line, 240 - pixel.textWidth(line, 2) / 2, 140, TEXT_DIM, 2);
		}
	}

	// ---- snapshot interpolation (~100ms buffer) ----

	private nearestSample(atTick: number, id: PlayerId): TankState | null {
		const buf = this.remoteSamples;
		if (buf.length === 0) return null;
		let best: RemoteSample | null = null;
		for (const sample of buf) {
			if (sample.tick <= atTick) best = sample;
			else break;
		}
		const use = best ?? buf[0];
		return use.tanks.get(id) ?? null;
	}

	private remoteTankPos(id: PlayerId, atTick: number): TankState | null {
		const buf = this.remoteSamples;
		if (buf.length === 0) {
			return this.sim.tanks.find((t) => t.id === id) ?? null;
		}
		const { prev, next } = this.samplePair(atTick);
		const a = prev?.tanks.get(id) ?? null;
		const b = next?.tanks.get(id) ?? null;
		if (!prev || !next || !a || !b) return a ?? b;
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		return {
			...a,
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
			angle: a.angle + (b.angle - a.angle) * t
		};
	}

	private remoteBullets(atTick: number): BulletState[] {
		const buf = this.remoteSamples;
		if (buf.length === 0) return [];
		const { prev, next } = this.samplePair(atTick);
		if (!prev) return next ? [...next.bullets.values()] : [];
		if (!next) return [...prev.bullets.values()];
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		const out: BulletState[] = [];
		for (const [id, a] of prev.bullets) {
			const b = next.bullets.get(id);
			out.push(b ? { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : a);
		}
		for (const [id, b] of next.bullets) {
			if (!prev.bullets.has(id)) out.push(b);
		}
		return out;
	}

	private samplePair(atTick: number): { prev: RemoteSample | null; next: RemoteSample | null } {
		const buf = this.remoteSamples;
		let prev: RemoteSample | null = null;
		let next: RemoteSample | null = null;
		for (const sample of buf) {
			if (sample.tick <= atTick) prev = sample;
			else {
				next = sample;
				break;
			}
		}
		return { prev, next };
	}
}

export function createTankClient(ctx: GameContext): TankClient {
	return new TankClientImpl(ctx);
}
