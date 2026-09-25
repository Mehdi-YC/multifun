/**
 * Turbo Kart renderer/client. Draws the circuit, karts, items and HUD on the
 * fixed 480x270 PixelCanvas, predicts the local kart through a private sim fed
 * by local input, and interpolates remote karts/missiles/slicks from server
 * snapshots buffered ~100ms in the past. The camera follows the local kart
 * smoothly with a velocity lead.
 *
 * 16-DIRECTION KARTS: karts are drawn procedurally in a rotated frame with the
 * heading QUANTIZED to 16 directions (22.5deg steps) — the chunky SNES
 * pre-rotated-sprite look without an offscreen atlas. Procedural drawing keeps
 * everything injectable (`Canvas2DLike`), so the whole scene renders headlessly
 * in node tests exactly as it does in the browser.
 *
 * Desync hardening (see `interp.ts` for the buffer details):
 * - All world drawing happens in internal 480x270 pixel coordinates; the
 *   PixelCanvas letterbox scale/offset is never read here, so two browsers with
 *   wildly different window sizes draw every entity at identical internal
 *   coordinates.
 * - Remote entities render at a render tick derived from the SNAPSHOT stream's
 *   own ticks (never the local loop's tick count), and the interpolation buffer
 *   snaps (never slides) across respawns, spin-outs and lightning shocks.
 * - The local kart is predicted instantly (zero display lag) and reconciled
 *   against every authoritative snapshot: small corrections blend out with
 *   shortest-path angle blending, big jumps snap.
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
import { TILE_SIZE, hazardAt, tileAtPx, type Track, type TrackPoint } from './track';
import {
	BASE_MAX_SPEED,
	DRIFT_TIER_TICKS,
	ITEM_BOX_RESPAWN_TICKS,
	KART_HALF,
	SLICK_LIFE,
	createKartSim,
	driftTier,
	parseKartSnapshot,
	type ItemBoxState,
	type ItemKind,
	type KartSim,
	type KartSnapshot,
	type KartState,
	type MissileState,
	type SlickState
} from './sim';
import { aiMeta } from './ai';
import { RemoteBuffer, SNAP_DISTANCE, angleDelta, wrapAngle } from './interp';

// ---- palette (per-track palettes live in track.ts) ----

const TEXT = '#e8e8f0';
const TEXT_DIM = '#8b97b5';
const PANEL = '#22263a';
const PANEL_EDGE = '#1a1c2c';
const TIRE = '#1c1f2a';
const DRIVER = '#f2d2b0';
const VISOR = '#2a2d3c';
const SHIELD_COLOR = '#6ec6ff';
const SLICK_COLOR = '#1d2230';
const MISSILE_BODY = '#d8d8e0';
const MISSILE_FIRE = '#ff9f43';

/** Drift spark colors per tier (1 = blue, 2 = orange, 3 = purple). */
export const DRIFT_SPARK_COLORS = ['#6ec6ff', '#ff9f43', '#c792ea'] as const;

const ITEM_COLORS: Record<ItemKind, string> = {
	mushroom: '#ff5c7a',
	oil: '#3a3f52',
	missile: '#ff9f43',
	shield: '#6ec6ff',
	lightning: '#ffd166'
};

/** Exponential smoothing rate (per second) for prediction-correction blending. */
const CORRECTION_DECAY = 14;
/** Bounded local-input history used to replay prediction after a restore. */
const MAX_INPUT_LOG = 240;
/** Seconds a lap-split popup stays on screen. */
const SPLIT_POPUP_SECONDS = 3;
/** 16 kart directions (the quantized "sprite rotation" step). */
const KART_DIRECTIONS = 16;
const KART_DIR_STEP = (Math.PI * 2) / KART_DIRECTIONS;

/** GameClient plus canvas fitting and deterministic driving (tests + loop). */
export interface KartClient extends GameClient {
	/** Kart snapshots always carry remote state — required, not optional. */
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

type SplitPopup = { lap: number; timeMs: number; best: boolean; age: number };
type Burst = { x: number; y: number; age: number; life: number };

/** Display-only correction of the predicted self kart toward snapshot truth. */
type SelfOffset = { x: number; y: number; angle: number };

class KartClientImpl implements KartClient {
	private readonly ctx: GameContext;
	private readonly pixel: PixelCanvas;
	private readonly input = new InputManager();
	private readonly audio = new AudioManager();
	private readonly loop: FixedTimestepLoop;
	private readonly camera: Camera;
	private readonly particles: ParticleSystem;
	private readonly track: Track;

	/** Private prediction sim: only the local player drives it. */
	private readonly sim: KartSim;
	private readonly tickInputs = new Map<PlayerId, InputFrame>();
	private readonly racers: SimPlayer[];
	private readonly racersById: Map<PlayerId, SimPlayer>;

	/** Authoritative snapshot stream driving all remote-entity rendering. */
	private readonly buffer = new RemoteBuffer();
	/** Local input history (keys per prediction tick) for restore replay. */
	private readonly inputLog: number[] = [];
	/** Display-only smoothing of prediction corrections (see `reconcile`). */
	private selfOffset: SelfOffset = { x: 0, y: 0, angle: 0 };
	/** nowMs() when the newest snapshot was applied (render clock anchor). */
	private lastSnapMs = nowMs();

	private readonly bursts: Burst[] = [];
	private readonly splits: SplitPopup[] = [];
	private countdownValue = -1;
	private countdownAge = 99;
	private animFrame = 0;
	private lastFrameMs = nowMs();
	private prevSelfSpeed = 0;
	private prevSelfZ = 0;
	private matchOver = false;

	/** Minimap transform derived from the spline bounds. */
	private readonly mini: {
		x: number;
		y: number;
		w: number;
		h: number;
		scale: number;
		minX: number;
		minY: number;
	};

	constructor(ctx: GameContext) {
		this.ctx = ctx;
		this.pixel = new PixelCanvas(ctx.canvas as unknown as CanvasSourceLike, {
			width: 480,
			height: 270
		});
		this.sim = createKartSim(ctx.seed, ctx.config, ctx.players);
		this.track = this.sim.track;
		// Display roster: humans from the lobby plus sim-owned AI karts.
		this.racers = [
			...ctx.players,
			...this.sim.karts
				.filter((k) => k.id.startsWith('ai-'))
				.map((k) => {
					const meta = aiMeta(k.id);
					return { id: k.id, name: meta.name, color: meta.color, slot: -1 };
				})
		];
		this.racersById = new Map(this.racers.map((p) => [p.id, p]));
		this.camera = new Camera({
			width: 480,
			height: 270,
			zoom: 1,
			smoothing: 7,
			lookAhead: 0.12,
			maxLookAhead: 44,
			shakeScale: 6,
			shakeDecay: 1.6
		});
		const self = this.sim.karts.find((k) => k.id === ctx.selfId);
		if (self) this.camera.setPosition(self.x, self.y);
		this.particles = new ParticleSystem({ capacity: 256, rng: mulberry32(0xc0ffee) });

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const p of this.track.spline) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
		const miniW = 74;
		const miniH = 52;
		this.mini = {
			x: 480 - miniW - 6,
			y: 6,
			w: miniW,
			h: miniH,
			scale: Math.min(
				(miniW - 8) / Math.max(1, maxX - minX),
				(miniH - 8) / Math.max(1, maxY - minY)
			),
			minX,
			minY
		};

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
	 * Server snapshots carry every kart, missile, slick, box and wall. They
	 * feed the interpolation buffer (whose continuity flags snap across
	 * respawns/spins/shocks) and reconcile the local prediction against
	 * authority.
	 */
	onSnapshot(patch: GameStatePatch): void {
		const snap = parseKartSnapshot(patch);
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
	 * while a teleport, respawn or spin snaps instantly — a correction must
	 * never slide the kart across the map either.
	 */
	private reconcile(snap: KartSnapshot): void {
		const selfBefore = this.sim.karts.find((k) => k.id === this.ctx.selfId) ?? null;
		const before = selfBefore
			? {
					x: selfBefore.x,
					y: selfBefore.y,
					angle: selfBefore.angle,
					finished: selfBefore.finished,
					spinTimer: selfBefore.spinTimer
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

		const selfAfter = this.sim.karts.find((k) => k.id === this.ctx.selfId) ?? null;
		if (!before || !selfAfter) return;
		const jump = Math.hypot(selfAfter.x - before.x, selfAfter.y - before.y);
		const rebased =
			jump > SNAP_DISTANCE ||
			selfAfter.finished !== before.finished ||
			selfAfter.spinTimer > 0 !== before.spinTimer > 0;
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
				const pos = this.displayKart(ev.player);
				if (pos) this.bursts.push({ x: pos.x, y: pos.y, age: 0, life: 0.5 });
				this.audio.sfx.click();
				break;
			}
			case 'boost':
				this.audio.sfx.boost();
				break;
			case 'collect':
				this.audio.sfx.click();
				break;
			case 'hit': {
				const pos = this.displayKart(ev.player);
				if (ev.force <= 0) {
					// force 0 = the shield bubble absorbed the hit: pop it, no spin.
					if (pos) {
						this.particles.emit({
							kind: 'ring',
							x: pos.x,
							y: pos.y,
							size: 18,
							life: 0.3,
							color: SHIELD_COLOR
						});
					}
					this.audio.sfx.click();
					break;
				}
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
				this.camera.addTrauma(0.12);
				this.audio.sfx.death();
				break;
			}
			case 'respawn': {
				const pos = this.displayKart(ev.player);
				if (pos) this.bursts.push({ x: pos.x, y: pos.y, age: 0, life: 0.6 });
				this.audio.sfx.click();
				break;
			}
			case 'lap': {
				const self = this.sim.karts.find((k) => k.id === this.ctx.selfId);
				const best = self ? ev.timeMs > 0 && ev.timeMs <= self.bestLapMs : false;
				if (ev.player === this.ctx.selfId) {
					this.splits.push({ lap: ev.lap, timeMs: ev.timeMs, best, age: 0 });
					if (this.splits.length > 3) this.splits.shift();
				}
				this.audio.sfx.finish();
				break;
			}
			case 'finish':
				if (ev.player === this.ctx.selfId) this.audio.sfx.finish();
				break;
			case 'countdown':
				this.countdownValue = ev.value;
				this.countdownAge = 0;
				this.audio.sfx.countdown();
				break;
			case 'match-end':
				this.matchOver = true;
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

		// Local-only audio cues from the prediction (engine rev + hop blips).
		const self = this.sim.karts.find((k) => k.id === this.ctx.selfId);
		if (self) {
			if (self.z > 0 && this.prevSelfZ <= 0) this.audio.sfx.jump();
			if (self.speed > 2 && self.speed > this.prevSelfSpeed + 0.02 && this.animFrame % 30 === 0) {
				this.audio.sfx.jump();
			}
			this.prevSelfZ = self.z;
			this.prevSelfSpeed = self.speed;
		}
		// Prediction events are display noise; the server's events own the VFX.
		this.sim.drainEvents();
	}

	// ---- render ----

	/**
	 * World time in snapshot ticks for remote entities: one ~100ms delay behind
	 * the newest snapshot, advanced by wall time since that snapshot arrived.
	 * Derived from the SNAPSHOT stream (not the local tick counter), so a
	 * browser that drops ticks under render load still renders every remote
	 * entity at the same world time as a browser that keeps up. Falls back to
	 * the local tick before the first snapshot arrives.
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
		for (const b of this.bursts) b.age += dt;
		for (const s of this.splits) s.age += dt;
		for (let i = this.bursts.length - 1; i >= 0; i--) {
			if (this.bursts[i].age >= this.bursts[i].life) this.bursts.splice(i, 1);
		}
		for (let i = this.splits.length - 1; i >= 0; i--) {
			if (this.splits[i].age >= SPLIT_POPUP_SECONDS) this.splits.splice(i, 1);
		}

		// Camera: smooth follow with a velocity lead, rumble on off-road.
		const self = this.displaySelf();
		if (self) {
			const followX = self.x + this.selfOffset.x;
			const followY = self.y + this.selfOffset.y;
			const fx = Math.cos(self.angle);
			const fy = Math.sin(self.angle);
			this.camera.follow(followX, followY, dt, fx * self.speed * 60, fy * self.speed * 60);
			if (self.z <= 0 && isOffRoadAt(this.track, followX, followY)) {
				this.camera.addTrauma(0.02);
			}
		}

		// World time for everything the buffer interpolates; `alpha` only
		// refines the pre-snapshot fallback where no snapshot clock exists.
		const renderTick = this.renderTick() + (this.buffer.latestTick === null ? alpha : 0);

		const pixel = this.pixel;
		pixel.clear(this.track.palette.bg);
		pixel.ctx.save();
		this.camera.applyTo(pixel.ctx);

		this.drawTiles();
		this.drawItemBoxes(renderTick);
		this.drawSlicks(renderTick);
		this.drawMissiles(renderTick);
		this.drawHazards(renderTick);
		this.drawKarts(renderTick);
		this.particles.draw(pixel.ctx);
		this.drawBursts();

		pixel.ctx.restore();
		this.drawHud();
	}

	/** Latest known state of a kart (snapshot first, local prediction fallback). */
	private displayKart(id: PlayerId): KartState | null {
		return this.buffer.latestKart(id) ?? this.sim.karts.find((k) => k.id === id) ?? null;
	}

	/** The local kart: instant prediction plus its correction offset. */
	private displaySelf(): KartState | null {
		const self = this.sim.karts.find((k) => k.id === this.ctx.selfId);
		if (!self) return null;
		return {
			...self,
			x: self.x + this.selfOffset.x,
			y: self.y + this.selfOffset.y,
			angle: wrapAngle(self.angle + this.selfOffset.angle)
		};
	}

	// ---- circuit drawing ----

	private drawTiles(): void {
		const track = this.track;
		const pal = track.palette;
		const pixel = this.pixel;
		const halfW = 240 + TILE_SIZE * 2;
		const halfH = 135 + TILE_SIZE * 2;
		const minCol = Math.max(0, Math.floor((this.camera.x - halfW) / TILE_SIZE));
		const maxCol = Math.min(track.cols - 1, Math.floor((this.camera.x + halfW) / TILE_SIZE));
		const minRow = Math.max(0, Math.floor((this.camera.y - halfH) / TILE_SIZE));
		const maxRow = Math.min(track.rows - 1, Math.floor((this.camera.y + halfH) / TILE_SIZE));
		const phase = Math.floor(this.animFrame / 12) % 2;

		for (let row = minRow; row <= maxRow; row++) {
			for (let col = minCol; col <= maxCol; col++) {
				const index = row * track.cols + col;
				const tile = track.tiles[index];
				const x = col * TILE_SIZE;
				const y = row * TILE_SIZE;
				switch (tile) {
					case 'road':
					case 'itembox':
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.road);
						if ((col + row) % 2 === 0) pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.roadAlt);
						break;
					case 'curb':
						// Rumble strip: alternating light/dark blocks.
						pixel.fillRect(
							x,
							y,
							TILE_SIZE,
							TILE_SIZE,
							(col + row) % 2 === 0 ? pal.curb : pal.curbAlt
						);
						break;
					case 'grass':
					case 'decor':
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.grass);
						if ((col * 3 + row * 5) % 4 === 0) {
							pixel.fillRect(x + 3, y + 4, 4, 3, pal.grassAlt);
							pixel.fillRect(x + 10, y + 9, 3, 3, pal.grassAlt);
						}
						if (tile === 'decor') {
							pixel.fillRect(x + 4, y + 3, 8, 8, pal.decor);
							pixel.fillRect(x + 6, y + 11, 4, 3, pal.wallDark);
						}
						break;
					case 'ice':
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.ice);
						pixel.fillRect(x + 2, y + 3, 6, 1, '#ffffff');
						pixel.fillRect(x + 8, y + 10, 5, 1, '#ffffff');
						break;
					case 'boost': {
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.roadAlt);
						// Animated chevrons marching along the strip.
						const off = (Math.floor(this.animFrame / 6) + row) % 4;
						pixel.fillRect(x + 2, y + off * 4, 12, 2, pal.boost);
						pixel.fillRect(x + 4, y + off * 4 + 2, 8, 1, pal.accent);
						break;
					}
					case 'ramp':
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.ramp);
						pixel.fillRect(x, y + 2, TILE_SIZE, 2, pal.wallLight);
						pixel.fillRect(x, y + 8, TILE_SIZE, 2, pal.wallLight);
						break;
					case 'wall': {
						// Smashed breakable walls render as broken rubble.
						const slot = index;
						if (track.breakables.includes(slot) && this.breakableHpAtRender(slot) <= 0) {
							pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.roadAlt);
							pixel.fillRect(x + 2, y + 3, 5, 4, pal.wallDark);
							pixel.fillRect(x + 9, y + 8, 5, 5, pal.wallDark);
							break;
						}
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.wall);
						pixel.fillRect(x, y, TILE_SIZE, 3, pal.wallLight);
						pixel.fillRect(x, y, 3, TILE_SIZE, pal.wallLight);
						pixel.fillRect(x, y + TILE_SIZE - 3, TILE_SIZE, 3, pal.wallDark);
						pixel.fillRect(x + TILE_SIZE - 3, y, 3, TILE_SIZE, pal.wallDark);
						pixel.fillRect(x + 5, y + 5, 6, 6, pal.wallDark);
						break;
					}
					case 'water':
						pixel.fillRect(x, y, TILE_SIZE, TILE_SIZE, pal.water);
						if ((col + row + phase) % 2 === 0) {
							pixel.fillRect(x + 3, y + 5, 6, 2, pal.ice);
							pixel.fillRect(x + 8, y + 11, 5, 1, pal.ice);
						}
						break;
					default:
						break;
				}
			}
		}
		// Start/finish line: checker band across the road at s = 0.
		this.drawStartLine();
	}

	private drawStartLine(): void {
		const pixel = this.pixel;
		const start = this.track.checkpoints[0];
		const px = -start.ty;
		const py = start.tx;
		for (let i = -3; i <= 3; i++) {
			const cx = start.x + px * i * 6;
			const cy = start.y + py * i * 6;
			pixel.fillRect(cx - 3, cy - 3, 6, 6, i % 2 === 0 ? TEXT : PANEL_EDGE);
		}
	}

	/** Breakable wall hp at render time (snapshot stream first, sim fallback). */
	private breakableHpAtRender(slot: number): number {
		const hp = this.buffer.length > 0 ? this.buffer.breakableHpAt(this.renderTick()) : null;
		return hp && slot < hp.length ? hp[slot] : (this.sim.breakableHp[slot] ?? 1);
	}

	private drawItemBoxes(renderTick: number): void {
		const boxes: ItemBoxState[] | null =
			this.buffer.length > 0 ? this.buffer.boxesAt(renderTick) : [...this.sim.boxes];
		if (!boxes) return;
		const pixel = this.pixel;
		for (const box of boxes) {
			if (box.respawn > 0) {
				// Respawn shimmer: a fading outline while the box recharges.
				const t = box.respawn / ITEM_BOX_RESPAWN_TICKS;
				pixel.ctx.globalAlpha = 0.3 * t + 0.1;
				pixel.rect(box.x - 7, box.y - 7, 14, 14, this.track.palette.accent);
				pixel.ctx.globalAlpha = 1;
				continue;
			}
			// Spinning box: width pulses like a rotating cube.
			const spin = Math.abs(Math.cos(this.animFrame * 0.06 + box.x * 0.03));
			const w = Math.max(3, Math.round(12 * spin));
			pixel.fillRect(box.x - w / 2 - 1, box.y - 7, w + 2, 14, this.track.palette.accent);
			pixel.fillRect(box.x - w / 2, box.y - 6, w, 12, '#4a90d9');
			pixel.fillRect(box.x - w / 2, box.y - 6, w, 2, '#7bc0ff');
			if (w > 6) pixel.text('?', box.x - 2, box.y - 3, TEXT, 1);
		}
	}

	private drawSlicks(renderTick: number): void {
		const slicks: SlickState[] =
			this.buffer.length > 0 ? this.buffer.slicksAt(renderTick) : [...this.sim.slicks];
		const pixel = this.pixel;
		for (const slick of slicks) {
			const fade = Math.min(1, slick.life / (SLICK_LIFE * 0.25));
			pixel.ctx.globalAlpha = 0.85 * fade;
			pixel.fillRect(slick.x - 8, slick.y - 5, 16, 10, SLICK_COLOR);
			pixel.fillRect(slick.x - 5, slick.y - 7, 10, 14, SLICK_COLOR);
			pixel.fillRect(slick.x - 4, slick.y - 3, 5, 2, '#2d3448');
			pixel.ctx.globalAlpha = 1;
		}
	}

	private drawMissiles(renderTick: number): void {
		const missiles: MissileState[] =
			this.buffer.length > 0 ? this.buffer.missilesAt(renderTick) : [...this.sim.missiles];
		const pixel = this.pixel;
		for (const missile of missiles) {
			// Flame trail.
			pixel.line(
				missile.x - Math.cos(missile.angle) * 14,
				missile.y - Math.sin(missile.angle) * 14,
				missile.x,
				missile.y,
				MISSILE_FIRE
			);
			const ctx = pixel.ctx;
			ctx.save();
			ctx.translate(Math.round(missile.x), Math.round(missile.y));
			ctx.rotate(missile.angle);
			pixel.fillRect(-4, -2, 8, 4, MISSILE_BODY);
			pixel.fillRect(3, -1, 4, 2, MISSILE_FIRE);
			pixel.fillRect(-4, -2, 2, 1, '#ffffff');
			ctx.restore();
		}
	}

	private drawHazards(renderTick: number): void {
		const pixel = this.pixel;
		const pal = this.track.palette;
		for (const hazard of this.track.hazards) {
			const pos = hazardAt(hazard, renderTick);
			const pulse = Math.floor(this.animFrame / 8) % 2;
			pixel.fillRect(
				pos.x - hazard.radius,
				pos.y - hazard.radius,
				hazard.radius * 2,
				hazard.radius * 2,
				pal.wall
			);
			pixel.fillRect(
				pos.x - hazard.radius + 2,
				pos.y - hazard.radius + 2,
				hazard.radius * 2 - 4,
				4,
				pal.wallLight
			);
			pixel.fillRect(pos.x - 3, pos.y - 3, 6, 6, pulse === 0 ? pal.accent : pal.wallDark);
		}
	}

	// ---- karts ----

	/**
	 * Remote karts render from interpolated snapshot state (snapped across
	 * respawns/spins), the self kart from local prediction plus its correction
	 * offset — so the LOCAL kart is never delayed by the interpolation buffer.
	 */
	private drawKarts(renderTick: number): void {
		for (const racer of this.racers) {
			if (racer.id === this.ctx.selfId) continue;
			const pos =
				this.buffer.kartAt(racer.id, renderTick) ??
				this.sim.karts.find((k) => k.id === racer.id) ??
				null;
			if (!pos) continue;
			this.drawKart(pos, racer.color);
		}
		const self = this.displaySelf();
		const meta = this.racersById.get(this.ctx.selfId);
		if (self && meta) this.drawKart(self, meta.color);
	}

	private drawKart(kart: KartState, color: string): void {
		const pixel = this.pixel;
		// Ground shadow (offset by hop/ramp height) keeps airborne reads clear.
		const lift = kart.z * 0.9;
		pixel.ctx.globalAlpha = 0.35;
		pixel.fillRect(kart.x - 6, kart.y - 4, 12, 8, '#000000');
		pixel.ctx.globalAlpha = 1;

		const tier = kart.drifting ? driftTier(kart.driftCharge) : 0;
		const ctx = pixel.ctx;
		ctx.save();
		ctx.translate(Math.round(kart.x), Math.round(kart.y - lift));
		// 16-direction "sprite" rotation: quantized heading, procedural pixels.
		ctx.rotate(Math.round(kart.angle / KART_DIR_STEP) * KART_DIR_STEP);
		if (kart.shrinkTimer > 0) ctx.scale(0.7, 0.7);

		// Tires.
		pixel.fillRect(-6, -6, 4, 3, TIRE);
		pixel.fillRect(3, -6, 4, 3, TIRE);
		pixel.fillRect(-6, 3, 4, 3, TIRE);
		pixel.fillRect(3, 3, 4, 3, TIRE);
		// Hull (top highlight / bottom shade) + spoiler.
		pixel.fillRect(-6, -4, 12, 8, color);
		pixel.fillRect(-6, -4, 12, 2, 'rgba(255,255,255,0.22)');
		pixel.fillRect(-6, 2, 12, 2, 'rgba(0,0,0,0.28)');
		pixel.fillRect(-7, -3, 2, 6, color);
		// Driver: helmet + visor.
		pixel.fillRect(-2, -2, 4, 4, DRIVER);
		pixel.fillRect(-1, -2, 3, 2, VISOR);
		// Nose cone.
		pixel.fillRect(5, -2, 2, 4, '#ffffff');

		// Drift sparks by tier (blue/orange/purple) at the rear corners.
		if (tier > 0 && kart.z <= 0) {
			const spark = DRIFT_SPARK_COLORS[tier - 1];
			const jitter = Math.floor(this.animFrame / 2) % 2;
			pixel.fillRect(-9 - jitter, -6, 3, 2, spark);
			pixel.fillRect(-9 - jitter, 4, 3, 2, spark);
			if (tier >= 2) {
				pixel.fillRect(-11 - jitter, -4, 2, 2, spark);
				pixel.fillRect(-11 - jitter, 3, 2, 2, spark);
			}
			if (tier >= 3) {
				pixel.fillRect(-12, -2 - jitter, 2, 2, spark);
				pixel.fillRect(-12, 1 + jitter, 2, 2, spark);
			}
		}
		// Boost flames.
		if (kart.boostTimer > 0) {
			const flame = Math.floor(this.animFrame / 2) % 2;
			pixel.fillRect(-10 - flame * 2, -3, 5, 2, MISSILE_FIRE);
			pixel.fillRect(-10 - flame * 2, 1, 5, 2, MISSILE_FIRE);
			pixel.fillRect(-8 - flame, -1, 4, 2, '#ffd166');
		}
		ctx.restore();

		// Shield bubble.
		if (kart.shieldTimer > 0) {
			const pulse = Math.floor(this.animFrame / 6) % 2;
			pixel.circle(kart.x, kart.y - lift, KART_HALF + 5 + pulse, 'rgba(110,198,255,0.5)', false);
		}
	}

	private drawBursts(): void {
		const pixel = this.pixel;
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

	// ---- HUD (always internal 480x270 coordinates) ----

	private drawHud(): void {
		const pixel = this.pixel;
		const self = this.displaySelf();
		if (self) {
			this.drawPositionBadge(self);
			this.drawSpeedBar(self);
			this.drawItemSlot(self);
			this.drawDriftMeter(self);
		}
		this.drawMinimap();
		this.drawSplits();
		this.drawSpeedLines(self);

		if (this.countdownAge < 1 && this.countdownValue >= 0) {
			const label = this.countdownValue === 0 ? 'GO!' : String(this.countdownValue);
			const scale = 4;
			pixel.ctx.globalAlpha = Math.max(0, 1 - this.countdownAge);
			pixel.text(label, 240 - pixel.textWidth(label, scale) / 2, 110, TEXT, scale);
			pixel.ctx.globalAlpha = 1;
		}

		// Results-ready states.
		if (self?.finished) {
			const place = this.sim.results().find((r) => r.player === self.id)?.placement ?? self.place;
			const label = `FINISHED ${ordinal(place)}`;
			pixel.fillRect(120, 40, 240, 30, PANEL);
			pixel.rect(120.5, 40.5, 239, 29, this.racersById.get(self.id)?.color ?? TEXT);
			pixel.text(label, 240 - pixel.textWidth(label, 2) / 2, 50, TEXT, 2);
		} else if (this.matchOver) {
			const label = 'RACE COMPLETE';
			pixel.text(label, 240 - pixel.textWidth(label, 2) / 2, 50, TEXT, 2);
		}
	}

	private drawPositionBadge(self: KartState): void {
		const pixel = this.pixel;
		const label = `${self.place}${ordinal(self.place)}`;
		pixel.fillRect(6, 6, 58, 22, PANEL);
		pixel.rect(6.5, 6.5, 57, 21, this.racersById.get(self.id)?.color ?? TEXT);
		pixel.text(label, 12, 11, TEXT, 2);
		const lapLabel = `LAP ${Math.min(self.lap + 1, this.sim.laps)}/${this.sim.laps}`;
		pixel.fillRect(6, 30, 58, 12, PANEL);
		pixel.text(lapLabel, 10, 33, TEXT_DIM, 1);
	}

	private drawSpeedBar(self: KartState): void {
		const pixel = this.pixel;
		const x = 6;
		const y = 248;
		const w = 96;
		const frac = clamp(Math.abs(self.speed) / (BASE_MAX_SPEED * 1.4), 0, 1);
		pixel.fillRect(x, y, w, 8, PANEL);
		pixel.fillRect(x, y, Math.round(w * frac), 8, frac > 0.75 ? '#ff9f43' : '#57e389');
		pixel.rect(x + 0.5, y + 0.5, w - 1, 7, PANEL_EDGE);
		pixel.text('SPEED', x, y - 9, TEXT_DIM, 1);
	}

	private drawItemSlot(self: KartState): void {
		const pixel = this.pixel;
		const x = 70;
		const y = 46;
		pixel.fillRect(x, y, 24, 24, PANEL);
		pixel.rect(x + 0.5, y + 0.5, 23, 23, PANEL_EDGE);
		if (self.item) this.drawItemIcon(x + 4, y + 4, self.item);
		if (self.shieldTimer > 0) {
			pixel.circle(x + 12, y + 12, 13, 'rgba(110,198,255,0.5)', false);
		}
	}

	private drawItemIcon(x: number, y: number, item: ItemKind): void {
		const pixel = this.pixel;
		const color = ITEM_COLORS[item];
		switch (item) {
			case 'mushroom':
				pixel.fillRect(x + 1, y + 1, 14, 6, color);
				pixel.fillRect(x + 3, y, 10, 2, color);
				pixel.fillRect(x + 5, y + 7, 6, 7, '#f2d2b0');
				pixel.fillRect(x + 3, y + 2, 3, 2, '#ffffff');
				break;
			case 'oil':
				pixel.fillRect(x + 3, y + 5, 10, 8, color);
				pixel.fillRect(x + 5, y + 2, 6, 4, color);
				pixel.fillRect(x + 6, y + 6, 3, 2, '#5a6480');
				break;
			case 'missile':
				pixel.fillRect(x + 2, y + 6, 11, 4, MISSILE_BODY);
				pixel.fillRect(x + 12, y + 7, 3, 2, color);
				pixel.fillRect(x + 1, y + 5, 3, 6, color);
				break;
			case 'shield':
				pixel.circle(x + 8, y + 8, 7, 'rgba(110,198,255,0.4)', true);
				pixel.circle(x + 8, y + 8, 7, color, false);
				pixel.fillRect(x + 4, y + 4, 2, 2, '#bfe9ff');
				break;
			case 'lightning':
				pixel.fillRect(x + 8, y, 4, 5, color);
				pixel.fillRect(x + 5, y + 4, 6, 3, color);
				pixel.fillRect(x + 5, y + 7, 4, 4, color);
				pixel.fillRect(x + 3, y + 11, 5, 3, color);
				break;
		}
	}

	private drawDriftMeter(self: KartState): void {
		const pixel = this.pixel;
		const tier = driftTier(self.driftCharge);
		const x = 210;
		const y = 252;
		for (let i = 0; i < 3; i++) {
			const lit = tier >= i + 1;
			const partial =
				!lit && tier === i
					? clamp((self.driftCharge % DRIFT_TIER_TICKS) / DRIFT_TIER_TICKS, 0, 1)
					: 0;
			pixel.fillRect(x + i * 22, y, 18, 6, PANEL);
			if (lit) pixel.fillRect(x + i * 22, y, 18, 6, DRIFT_SPARK_COLORS[i]);
			else if (partial > 0)
				pixel.fillRect(x + i * 22, y, Math.round(18 * partial), 6, DRIFT_SPARK_COLORS[i]);
		}
		if (self.drifting) pixel.text('DRIFT', x, y - 9, DRIFT_SPARK_COLORS[Math.max(0, tier - 1)], 1);
	}

	private drawMinimap(): void {
		const pixel = this.pixel;
		const mini = this.mini;
		pixel.fillRect(mini.x, mini.y, mini.w, mini.h, PANEL);
		pixel.rect(mini.x + 0.5, mini.y + 0.5, mini.w - 1, mini.h - 1, PANEL_EDGE);
		const project = (p: TrackPoint | { x: number; y: number }): [number, number] => [
			mini.x + 4 + (p.x - mini.minX) * mini.scale,
			mini.y + 4 + (p.y - mini.minY) * mini.scale
		];
		// Racing line.
		const spline = this.track.spline;
		for (let i = 0; i < spline.length; i += 6) {
			const a = project(spline[i]);
			const b = project(spline[(i + 6) % spline.length]);
			pixel.line(a[0], a[1], b[0], b[1], TEXT_DIM);
		}
		// Item boxes as accent dots.
		for (const box of this.sim.boxes) {
			if (box.respawn > 0) continue;
			const [bx, by] = project(box);
			pixel.fillRect(bx - 1, by - 1, 2, 2, this.track.palette.accent);
		}
		// Kart dots (local kart highlighted).
		for (const racer of this.racers) {
			const kart = this.displayKart(racer.id);
			if (!kart) continue;
			const [kx, ky] = project(kart);
			if (racer.id === this.ctx.selfId) {
				pixel.fillRect(kx - 2, ky - 2, 5, 5, racer.color);
			} else {
				pixel.fillRect(kx - 1, ky - 1, 3, 3, racer.color);
			}
		}
	}

	private drawSplits(): void {
		const pixel = this.pixel;
		this.splits.forEach((split, i) => {
			const label = `LAP ${split.lap} - ${formatLapMs(split.timeMs)}`;
			const alpha =
				split.age < SPLIT_POPUP_SECONDS - 1 ? 1 : Math.max(0, SPLIT_POPUP_SECONDS - split.age);
			const y = 92 + i * 22;
			pixel.ctx.globalAlpha = alpha;
			pixel.fillRect(150, y - 4, 180, 18, PANEL);
			pixel.text(label, 158, y, split.best ? this.track.palette.accent : TEXT, 1);
			if (split.best) pixel.text('BEST LAP!', 268, y, this.track.palette.accent, 1);
			pixel.ctx.globalAlpha = 1;
		});
	}

	/** Streaking vignette lines at high speed (+speed feedback). */
	private drawSpeedLines(self: KartState | null): void {
		if (!self) return;
		const frac = Math.abs(self.speed) / (BASE_MAX_SPEED * 1.4);
		if (frac < 0.72) return;
		const pixel = this.pixel;
		const alpha = clamp((frac - 0.72) / 0.28, 0, 1) * 0.5;
		pixel.ctx.globalAlpha = alpha;
		const shift = (this.animFrame * 2) % 40;
		for (let i = 0; i < 3; i++) {
			const y = 40 + i * 80 + shift;
			pixel.fillRect(2, y, 14, 1, TEXT);
			pixel.fillRect(464, y + 20, 14, 1, TEXT);
		}
		pixel.ctx.globalAlpha = 1;
	}
}

function isOffRoadAt(track: Track, x: number, y: number): boolean {
	const tile = tileAtPx(track, x, y);
	return tile === 'grass' || tile === 'decor';
}

function ordinal(place: number): string {
	if (place % 100 >= 11 && place % 100 <= 13) return 'TH';
	switch (place % 10) {
		case 1:
			return 'ST';
		case 2:
			return 'ND';
		case 3:
			return 'RD';
		default:
			return 'TH';
	}
}

function formatLapMs(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const minutes = Math.floor(total / 60000);
	const seconds = Math.floor((total % 60000) / 1000);
	const tenths = Math.floor((total % 1000) / 100);
	return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function createKartClient(ctx: GameContext): KartClient {
	return new KartClientImpl(ctx);
}

// Exported so test harnesses can find hull draws the same way the tank tests
// do (the 12x8 fill in the racer's color is the kart hull).
export const KART_HULL_WIDTH = 12;
export const KART_HULL_HEIGHT = 8;
