/**
 * Pixel Tanks renderer/client. Draws the arena, tanks, shells and HUD on the
 * fixed 480x270 PixelCanvas, predicts the local tank through a private sim fed
 * by local input, and interpolates remote tanks/bullets from server snapshots
 * buffered ~100ms in the past. The camera is pinned to the arena (the whole
 * 30x17 map is visible) and only shakes on explosions.
 *
 * Desync hardening (see `interp.ts` for the buffer details):
 * - All world drawing happens in internal 480x270 pixel coordinates; the
 *   PixelCanvas letterbox scale/offset is never read here, so two browsers
 *   with wildly different window sizes draw every entity at identical
 *   internal coordinates.
 * - Remote entities are rendered at a render tick derived from the SNAPSHOT
 *   stream's own ticks (not the local loop's tick count), so a browser that
 *   drops ticks under render load still shows the same world position as one
 *   that keeps up. The interpolation buffer snaps (never slides) across
 *   respawns/deaths and rebase-style corrections.
 * - The local prediction is reconciled against every authoritative snapshot
 *   (`sim.restore` + local-input replay). Small corrections blend (with
 *   shortest-path angle blending), big jumps snap; see `reconcile()`.
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
import { clamp, nowMs } from '../engine/fixed';
import { mulberry32 } from '../engine/rng';
import { TILE_SIZE, tileAt } from './arena';
import {
	BULLET_LIFE,
	EFFECT_TICKS,
	TRIPLE_SHOTS,
	TRIPLE_SPREAD,
	TANK_HALF,
	createTankSim,
	parseTankSnapshot,
	rapidReloadTicks,
	reloadTicks,
	type BulletState,
	type PowerupKind,
	type PowerupState,
	type TankSim,
	type TankSnapshot,
	type TankState
} from './sim';
import { RemoteBuffer, SNAP_DISTANCE, angleDelta, wrapAngle } from './interp';

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

const FEED_SECONDS = 4.5;
/** Bounded local-input history used to replay prediction after a restore. */
const MAX_INPUT_LOG = 120;
/** Exponential smoothing rate (per second) for prediction-correction blending. */
const CORRECTION_DECAY = 14;

/** Colors for the four power-up pickups (shared by map icons and HUD). */
const POWERUP_COLORS: Record<PowerupKind, string> = {
	shield: '#6ec6ff',
	triple: '#ffd166',
	rapid: '#ffe066',
	speed: '#57e389'
};

/** GameClient plus canvas fitting and deterministic driving (tests + loop). */
export interface TankClient extends GameClient {
	/** Tank snapshots always carry remote state — required, not optional. */
	onSnapshot(patch: GameStatePatch): void;
	/** Server events drive shared VFX/SFX on every client. */
	onEvent(ev: GameEvent): void;
	/** Fit the canvas backing store (internal resolution stays 480x270). */
	resize(cssWidth: number, cssHeight: number): void;
	/**
	 * Advance the local prediction by one fixed tick (what the game loop calls;
	 * pass `keys` to override input sampling in deterministic tests).
	 */
	stepTick(keys?: number): void;
	/** Render one frame at interpolation alpha (what the game loop calls). */
	renderFrame(alpha: number): void;
}

type Explosion = { x: number; y: number; age: number; life: number; size: number; color: string };
type Burst = { x: number; y: number; age: number; life: number };
type FeedEntry = { killer: string; victim: string; age: number };

/** Display-only correction of the predicted self tank toward snapshot truth. */
type SelfOffset = { x: number; y: number; angle: number };

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

	/** Authoritative snapshot stream driving all remote-entity rendering. */
	private readonly buffer = new RemoteBuffer();
	/** Local input history (keys per prediction tick) for restore replay. */
	private readonly inputLog: number[] = [];
	/** Display-only smoothing of prediction corrections (see `reconcile`). */
	private selfOffset: SelfOffset = { x: 0, y: 0, angle: 0 };
	/** nowMs() when the newest snapshot was applied (render clock anchor). */
	private lastSnapMs = nowMs();

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
			onTick: () => this.stepTick(),
			onRender: (alpha) => this.renderFrame(alpha)
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

	/**
	 * Server snapshots carry every tank, shell and power-up. They feed the
	 * interpolation buffer (whose continuity flags snap across respawns and
	 * teleports) and reconcile the local prediction against authority.
	 */
	onSnapshot(patch: GameStatePatch): void {
		const snap = parseTankSnapshot(patch);
		if (!snap) return;
		this.buffer.push(snap);
		this.lastSnapMs = nowMs();
		this.reconcile(snap);
	}

	/**
	 * Prediction reconciliation: restore the private sim to the authoritative
	 * snapshot, then replay the local inputs recorded since. Applying the
	 * snapshot REBASES both the sim and the interpolation display: small
	 * corrections blend out over ~150ms (angles always the short way around),
	 * while a teleport, death, respawn or lives change snaps instantly — a
	 * correction must never slide the tank across the map either.
	 */
	private reconcile(snap: TankSnapshot): void {
		const selfBefore = this.sim.tanks.find((t) => t.id === this.ctx.selfId) ?? null;
		const before = selfBefore
			? {
					x: selfBefore.x,
					y: selfBefore.y,
					angle: selfBefore.angle,
					alive: selfBefore.alive,
					lives: selfBefore.lives
				}
			: null;
		const steps = Math.max(0, Math.min(this.sim.tick - snap.tick, this.inputLog.length));
		this.sim.restore(snap);
		for (let i = this.inputLog.length - steps; i < this.inputLog.length; i++) {
			this.tickInputs.set(this.ctx.selfId, { keys: this.inputLog[i] });
			this.sim.tickOnce(this.tickInputs);
		}
		// Prediction events are display noise; the server's event stream owns VFX.
		this.sim.drainEvents();

		const selfAfter = this.sim.tanks.find((t) => t.id === this.ctx.selfId) ?? null;
		if (!before || !selfAfter) return;
		const jump = Math.hypot(selfAfter.x - before.x, selfAfter.y - before.y);
		const rebased =
			jump > SNAP_DISTANCE || selfAfter.alive !== before.alive || selfAfter.lives !== before.lives;
		if (rebased) {
			this.selfOffset = { x: 0, y: 0, angle: 0 };
			return;
		}
		this.selfOffset.x += before.x - selfAfter.x;
		this.selfOffset.y += before.y - selfAfter.y;
		this.selfOffset.angle = wrapAngle(
			this.selfOffset.angle + angleDelta(selfAfter.angle, before.angle)
		);
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
				const pos = this.displayTank(ev.player);
				if (ev.force <= 0) {
					// force 0 = shield absorbed the shell: pop the bubble, no kill.
					if (pos) {
						this.particles.emit({
							kind: 'ring',
							x: pos.x,
							y: pos.y,
							size: 16,
							life: 0.3,
							color: POWERUP_COLORS.shield
						});
					}
					this.audio.sfx.click();
					break;
				}
				this.pendingKiller.set(ev.player, ev.by);
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
				} else if (ev.item.startsWith('powerup:')) {
					// Pickup pop: colored ring + sparkle burst + boost jingle.
					const kind = ev.item.slice('powerup:'.length) as PowerupKind;
					const color = POWERUP_COLORS[kind] ?? '#ffd166';
					if (pos) {
						this.bursts.push({ x: pos.x, y: pos.y, age: 0, life: 0.6 });
						this.particles.emit({
							kind: 'ring',
							x: pos.x,
							y: pos.y,
							size: 18,
							life: 0.35,
							color
						});
					}
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

	stepTick(keys?: number): void {
		if (keys === undefined) this.input.pollGamepads();
		const frame = keys === undefined ? this.input.sample() : { keys };
		this.ctx.sendInput(frame);
		this.tickInputs.set(this.ctx.selfId, frame);
		// Keep the input history so snapshot restores can replay the local
		// prediction forward instead of freezing it at snapshot time.
		this.inputLog.push(frame.keys);
		if (this.inputLog.length > MAX_INPUT_LOG) this.inputLog.shift();
		this.sim.tickOnce(this.tickInputs);

		// Fire blip from the local prediction (firing is not a GameEvent).
		const self = this.sim.tanks.find((t) => t.id === this.ctx.selfId);
		if (self && self.reloadTimer > this.prevSelfReload) this.audio.sfx.jump();
		this.prevSelfReload = self ? self.reloadTimer : 0;
		// Prediction events are display noise; the server's events own the VFX.
		this.sim.drainEvents();
	}

	// ---- render ----

	/**
	 * World time in snapshot ticks for remote entities: one ~100ms delay
	 * behind the newest snapshot, advanced by wall time since that snapshot
	 * arrived. Derived from the SNAPSHOT stream (not the local tick counter),
	 * so a browser that drops ticks under render load — bigger canvas, slower
	 * machine — still renders every remote entity at the same world time as a
	 * browser that keeps up. Falls back to the local tick before the first
	 * snapshot arrives.
	 */
	private renderTick(): number {
		const tickRate = this.ctx.config.tickRate > 0 ? this.ctx.config.tickRate : 60;
		const delay = Math.max(1, Math.round(tickRate * 0.1));
		const latest = this.buffer.latestTick;
		if (latest === null) return this.sim.tick - delay;
		const oldest = this.buffer.oldestTick ?? latest;
		const sinceSnap = Math.max(0, (nowMs() - this.lastSnapMs) / (1000 / tickRate));
		return clamp(latest - delay + sinceSnap, oldest, latest);
	}

	renderFrame(alpha: number): void {
		const now = nowMs();
		const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
		this.lastFrameMs = now;
		this.animFrame++;
		this.countdownAge += dt;
		this.particles.update(dt);
		// Prediction corrections blend out (shortest-path angle, see reconcile).
		const keep = Math.exp(-CORRECTION_DECAY * dt);
		this.selfOffset.x *= keep;
		this.selfOffset.y *= keep;
		this.selfOffset.angle *= keep;
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

		// World time for everything the buffer interpolates; `alpha` only
		// refines the pre-snapshot fallback where no snapshot clock exists.
		const renderTick = this.renderTick() + (this.buffer.latestTick === null ? alpha : 0);

		const pixel = this.pixel;
		pixel.clear(BG);
		pixel.ctx.save();
		this.camera.applyTo(pixel.ctx);

		this.drawFloor();
		this.drawWater();
		this.drawCrates();
		this.drawPowerups(renderTick);
		this.drawWalls();
		this.drawShells(renderTick);
		this.drawTanks(renderTick);
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
		return this.buffer.latestCrates() ?? this.sim.crateHp.slice();
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
		return this.buffer.latestTank(id) ?? this.sim.tanks.find((t) => t.id === id) ?? null;
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
	private drawShells(renderTick: number): void {
		for (const b of this.sim.bullets) {
			if (b.owner !== this.ctx.selfId) continue;
			this.drawShell(b);
		}
		for (const b of this.buffer.bulletsAt(renderTick)) {
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

	/**
	 * Remote tanks render from interpolated snapshot state (snapped across
	 * respawns), the self tank from local prediction plus its correction
	 * offset. While dead the wreck/ghost stays hidden — only the respawn
	 * countdown shows — and an eliminated tank shows nothing at all.
	 */
	private drawTanks(renderTick: number): void {
		for (const player of this.ctx.players) {
			if (player.id === this.ctx.selfId) continue;
			const pos =
				this.buffer.tankAt(player.id, renderTick) ??
				this.sim.tanks.find((t) => t.id === player.id) ??
				null;
			if (!pos) continue;
			if (!pos.alive) {
				if (pos.lives > 0 && pos.respawnTimer > 0) {
					this.drawRespawnLabel(pos.x, pos.y, pos.respawnTimer);
				}
				continue;
			}
			this.drawTank(pos, player.color);
		}
		const self = this.sim.tanks.find((t) => t.id === this.ctx.selfId);
		const meta = this.playersById.get(this.ctx.selfId);
		if (self && meta) {
			if (!self.alive) {
				if (self.lives > 0 && self.respawnTimer > 0) {
					this.drawRespawnLabel(self.x, self.y, self.respawnTimer);
				}
				return;
			}
			this.drawTank(
				{
					...self,
					x: self.x + this.selfOffset.x,
					y: self.y + this.selfOffset.y,
					angle: wrapAngle(self.angle + this.selfOffset.angle)
				},
				meta.color
			);
		}
	}

	private drawTank(tank: TankState, color: string): void {
		const pixel = this.pixel;
		// Invulnerability blink: skip every other stretch of frames.
		if (tank.invulnTimer > 0 && Math.floor(this.animFrame / 3) % 2 === 0) return;
		// Shield bubble (one shell hit pops it — see sim.hitTank).
		if (tank.shield > 0) {
			const pulse = (Math.floor(this.animFrame / 6) + 1) % 2 === 0 ? 1 : 0;
			pixel.circle(tank.x, tank.y, TANK_HALF + 4 + pulse, 'rgba(110,198,255,0.55)', false);
			pixel.fillRect(tank.x - TANK_HALF - 4, tank.y - TANK_HALF - 5, 3, 1, '#bfe9ff');
		}
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
		// Speed lines trail the hull while the `speed` boost drives it.
		if (tank.speedTimer > 0 && tank.moveDir !== 0) {
			pixel.fillRect(-12, -5, 4, 1, 'rgba(87,227,137,0.7)');
			pixel.fillRect(-13, 4, 5, 1, 'rgba(87,227,137,0.7)');
			pixel.fillRect(-11, -1, 3, 1, 'rgba(87,227,137,0.5)');
		}
		ctx.restore();
		// Muzzle flash on the fire ticks — three-way while `triple` has shots.
		const effectiveReload =
			tank.rapidTimer > 0 ? rapidReloadTicks(tank.level) : reloadTicks(tank.level);
		const justFired = tank.reloadTimer >= effectiveReload - 3;
		if (justFired) {
			const angles =
				tank.triple > 0
					? [tank.angle - TRIPLE_SPREAD, tank.angle, tank.angle + TRIPLE_SPREAD]
					: [tank.angle];
			for (const angle of angles) {
				const dx = Math.cos(angle);
				const dy = Math.sin(angle);
				const fx = tank.x + dx * (TANK_HALF + 7);
				const fy = tank.y + dy * (TANK_HALF + 7);
				pixel.fillRect(fx - 3, fy - 3, 6, 6, 'rgba(255,224,102,0.85)');
				pixel.fillRect(fx - 1, fy - 5, 2, 10, 'rgba(255,159,67,0.8)');
				pixel.fillRect(fx - 5, fy - 1, 10, 2, 'rgba(255,159,67,0.8)');
			}
			// Rapid-fire smoke: hot barrel, lots of shells.
			if (tank.rapidTimer > 0) {
				const dx = Math.cos(tank.angle);
				const dy = Math.sin(tank.angle);
				const jitter = (Math.floor(this.animFrame / 2) % 2) * 2;
				const sx = tank.x + dx * (TANK_HALF + 9 + jitter);
				const sy = tank.y + dy * (TANK_HALF + 9 + jitter);
				pixel.fillRect(sx - 2, sy - 2, 4, 4, 'rgba(139,151,181,0.45)');
				pixel.fillRect(sx - 4, sy - 4, 3, 3, 'rgba(139,151,181,0.3)');
			}
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

	// ---- power-up pickups ----

	/**
	 * Glowing pickup icons (no crate sprite, so they never read as cover):
	 * bubble = shield, 3 bullets = triple, lightning = rapid, arrows = speed.
	 * Positions come from the snapshot clock like every other remote entity.
	 */
	private drawPowerups(renderTick: number): void {
		const list =
			this.buffer.length > 0 ? this.buffer.powerupsAt(renderTick) : [...this.sim.powerups];
		for (const powerup of list) this.drawPowerup(powerup);
	}

	private drawPowerup(powerup: PowerupState): void {
		const pixel = this.pixel;
		const color = POWERUP_COLORS[powerup.kind];
		const bob = Math.sin((this.animFrame + powerup.id * 24) * 0.08) * 1.5;
		const x = powerup.x;
		const y = powerup.y + bob;
		// Pulsing glow ring (two-frame sparkle keeps the pixel-art feel).
		const pulse = (Math.floor(this.animFrame / 10) + powerup.id) % 2;
		pixel.circle(x, y, 9 + pulse, 'rgba(255,255,255,0.12)', true);
		pixel.circle(x, y, 8, `${color}55`, false);
		switch (powerup.kind) {
			case 'shield':
				// Bubble with a highlight crescent.
				pixel.circle(x, y, 5, 'rgba(110,198,255,0.35)', true);
				pixel.circle(x, y, 5, color, false);
				pixel.fillRect(x - 3, y - 3, 2, 1, '#bfe9ff');
				pixel.fillRect(x - 4, y - 2, 1, 2, '#bfe9ff');
				break;
			case 'triple': {
				// Three shells fanned forward.
				for (const [ox, oy] of [
					[-5, 1],
					[-1, -1],
					[3, 1]
				] as const) {
					pixel.fillRect(x + ox - 1, y + oy - 1, 3, 3, BULLET_CORE);
					pixel.fillRect(x + ox - 3, y + oy, 2, 1, BULLET_TRAIL);
				}
				break;
			}
			case 'rapid':
				// Lightning bolt.
				pixel.fillRect(x + 1, y - 6, 3, 4, color);
				pixel.fillRect(x - 1, y - 2, 4, 2, color);
				pixel.fillRect(x - 1, y, 3, 4, color);
				pixel.fillRect(x - 3, y + 4, 3, 2, color);
				break;
			case 'speed':
				// Three chevrons pointing right.
				for (let i = 0; i < 3; i++) {
					const cx = x - 6 + i * 4;
					pixel.fillRect(cx, y - 3, 2, 1, color);
					pixel.fillRect(cx + 1, y - 2, 2, 1, color);
					pixel.fillRect(cx + 2, y - 1, 1, 2, color);
					pixel.fillRect(cx + 1, y + 1, 2, 1, color);
					pixel.fillRect(cx, y + 2, 2, 1, color);
				}
				break;
		}
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
		// Dead vs eliminated, straight from snapshot state.
		if (!state.alive) pixel.text(state.lives > 0 ? 'DEAD' : 'OUT', x + 62, y + 13, '#ff5c7a', 1);
		// Active effects: tiny icons + remaining-time bars.
		const effects: Array<{ kind: PowerupKind; t: number }> = [];
		if (state.shield > 0) effects.push({ kind: 'shield', t: 1 });
		if (state.triple > 0) effects.push({ kind: 'triple', t: state.triple / TRIPLE_SHOTS });
		if (state.rapidTimer > 0) effects.push({ kind: 'rapid', t: state.rapidTimer / EFFECT_TICKS });
		if (state.speedTimer > 0) effects.push({ kind: 'speed', t: state.speedTimer / EFFECT_TICKS });
		effects.slice(0, 4).forEach((effect, i) => {
			const ex = x + 74 + i * 8;
			this.drawEffectIcon(ex, y + 11, effect.kind);
			pixel.fillRect(ex, y + 18, 5, 1, PANEL_EDGE);
			pixel.fillRect(ex, y + 18, Math.max(1, Math.round(5 * effect.t)), 1, meta.color);
		});
	}

	private drawStar(x: number, y: number, color: string): void {
		const pixel = this.pixel;
		pixel.fillRect(x + 1, y, 1, 1, color);
		pixel.fillRect(x, y + 1, 3, 1, color);
		pixel.fillRect(x + 1, y + 2, 1, 1, color);
	}

	/** 5x5 effect glyph for the HUD cards (same shapes as the map pickups). */
	private drawEffectIcon(x: number, y: number, kind: PowerupKind): void {
		const pixel = this.pixel;
		const color = POWERUP_COLORS[kind];
		switch (kind) {
			case 'shield':
				pixel.fillRect(x + 1, y, 3, 1, color);
				pixel.fillRect(x, y + 1, 5, 2, color);
				pixel.fillRect(x + 1, y + 3, 3, 1, color);
				pixel.fillRect(x + 2, y + 4, 1, 1, color);
				break;
			case 'triple':
				for (let i = 0; i < 3; i++) pixel.fillRect(x + i * 2, y + 1, 1, 3, color);
				break;
			case 'rapid':
				pixel.fillRect(x + 2, y, 2, 2, color);
				pixel.fillRect(x + 1, y + 2, 2, 1, color);
				pixel.fillRect(x + 1, y + 3, 2, 2, color);
				break;
			case 'speed':
				pixel.fillRect(x, y, 3, 1, color);
				pixel.fillRect(x + 1, y + 1, 2, 1, color);
				pixel.fillRect(x + 2, y + 2, 1, 1, color);
				pixel.fillRect(x + 1, y + 3, 2, 1, color);
				pixel.fillRect(x, y + 4, 3, 1, color);
				break;
		}
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

	// ---- snapshot interpolation lives in `interp.ts` (RemoteBuffer) ----
}

export function createTankClient(ctx: GameContext): TankClient {
	return new TankClientImpl(ctx);
}
