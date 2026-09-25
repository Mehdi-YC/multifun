/**
 * GeoDash Party renderer/client. Draws the level on a 480x270 PixelCanvas
 * (sky bands, parallax, beat glow, procedural obstacles, cubes, particles,
 * HUD), predicts the local cube through a private sim fed by local input, and
 * interpolates remote players ("ghosts") from server snapshots buffered
 * ~100ms in the past.
 *
 * COORDINATE CONVENTION (see level-types.ts): y grows downward, the ground
 * surface is y = 0, and the cube's state (x, y) is its top-left corner.
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
import { KEY } from '../types';
import { AudioManager } from '../engine/audio';
import { Camera } from '../engine/camera';
import { nowMs } from '../engine/fixed';
import { PixelCanvas, type CanvasSourceLike } from '../engine/gfx';
import { InputManager } from '../engine/input';
import { FixedTimestepLoop } from '../engine/loop';
import { ParticleSystem } from '../engine/particles';
import { TweenManager, easeOutQuad } from '../engine/tween';
import { CUBE_SIZE, blockSize, padRect, portalGate } from './level-types';
import type { GeoDashLevel, GeoDashMode } from './level-types';
import {
	COUNTDOWN_TICKS,
	createGeodashSim,
	parseGeoDashSnapshot,
	type GeoDashPlayerState,
	type GeoDashSim
} from './sim';

const VIEW_W = 480;
const VIEW_H = 270;
const HALF_CUBE = CUBE_SIZE / 2;
const GHOST_ALPHA = 0.7;
const REMOTE_DELAY_SECONDS = 0.1;
const MAX_REMOTE_SAMPLES = 32;

// ---- palettes: 3 neon looks keyed by level difficulty ----

export interface GeoDashPalette {
	sky: string[];
	glow: string;
	ground: string;
	groundTop: string;
	groundDark: string;
	block: string;
	blockLight: string;
	blockDark: string;
	spike: string;
	spikeDark: string;
	spikeTip: string;
	saw: string;
	sawBlade: string;
	pad: string;
	orb: string;
	portal: string;
	finish: string;
}

const PALETTES: GeoDashPalette[] = [
	{
		// difficulty 1-2: midnight cyan
		sky: ['#0b1030', '#121a4a', '#1b2668', '#27358c', '#3547ad'],
		glow: '#57e3ff',
		ground: '#202a5e',
		groundTop: '#57e3ff',
		groundDark: '#141b40',
		block: '#3b4a9e',
		blockLight: '#6f83e0',
		blockDark: '#232c66',
		spike: '#8b97d5',
		spikeDark: '#4a569c',
		spikeTip: '#e8f4ff',
		saw: '#2a3160',
		sawBlade: '#aab6ef',
		pad: '#ffd166',
		orb: '#57e3ff',
		portal: '#57ffb0',
		finish: '#ffffff'
	},
	{
		// difficulty 3-4: neon magenta
		sky: ['#26093c', '#3a1160', '#541a86', '#7626ab', '#9b34cf'],
		glow: '#ff5c7a',
		ground: '#3c1466',
		groundTop: '#ff6ee0',
		groundDark: '#280b46',
		block: '#7a2ea8',
		blockLight: '#c163e8',
		blockDark: '#4c1a6e',
		spike: '#e08ef0',
		spikeDark: '#8a3fae',
		spikeTip: '#ffe8fb',
		saw: '#341152',
		sawBlade: '#e6a6ff',
		pad: '#ffd166',
		orb: '#ff6ee0',
		portal: '#ffe14d',
		finish: '#ffffff'
	},
	{
		// difficulty 5: vortex orange/red
		sky: ['#330a1c', '#5c1226', '#8a1c2c', '#b8292c', '#e04a2a'],
		glow: '#ffb03a',
		ground: '#5c1626',
		groundTop: '#ffb03a',
		groundDark: '#3a0c18',
		block: '#a83c3c',
		blockLight: '#ef7a4a',
		blockDark: '#6c2020',
		spike: '#ff9a6a',
		spikeDark: '#b04a2c',
		spikeTip: '#fff0d8',
		saw: '#4a1220',
		sawBlade: '#ffb03a',
		pad: '#ffe14d',
		orb: '#ff7a3a',
		portal: '#57ffb0',
		finish: '#ffffff'
	}
];

export function paletteForDifficulty(difficulty: number): GeoDashPalette {
	if (difficulty <= 2) return PALETTES[0];
	if (difficulty <= 4) return PALETTES[1];
	return PALETTES[2];
}

// ---- small pure helpers ----

function shade(hex: string, amount: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const clamp = (v: number) => Math.max(0, Math.min(255, v));
	const r = clamp((n >> 16) + amount);
	const g = clamp(((n >> 8) & 0xff) + amount);
	const b = clamp((n & 0xff) + amount);
	return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/** Deterministic per-index jitter for parallax scenery (rendering only). */
function hashNoise(i: number): number {
	const n = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
	return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
}

/** One sine cycle per beat; levels drive pulses from bpm. */
function beatPulse(tick: number, bpm: number): number {
	return Math.sin((tick * bpm * Math.PI * 2) / 3600);
}

/**
 * Draw the sky gradient in SCREEN space so it covers every row of the
 * viewport (0..VIEW_H) for any camera position. `shift` slides the gradient
 * with the camera; band rects are clamped to the viewport and the band list
 * is extended past both edges so no row is ever left uncovered.
 */
export function drawSkyBands(
	fill: (x: number, y: number, w: number, h: number, color: string) => void,
	sky: string[],
	cameraY: number
): void {
	const bands = Math.max(1, sky.length);
	const bandH = Math.ceil(VIEW_H / bands);
	const shift = Math.round(cameraY * 0.06);
	// Start at (or above) the band covering row 0, run past row VIEW_H.
	const first = Math.floor(-shift / bandH) - 1;
	for (let i = first; i < first + bands + 2; i++) {
		const top = i * bandH + shift;
		const y0 = Math.max(0, top);
		const y1 = Math.min(VIEW_H, top + bandH + 1);
		if (y1 <= y0) continue;
		const color = sky[Math.min(bands - 1, Math.max(0, i))];
		fill(0, y0, VIEW_W, y1 - y0, color);
	}
}

type RemotePoint = {
	x: number;
	y: number;
	vy: number;
	onGround: boolean;
	mode: GeoDashMode;
	thrusting: boolean;
};
type RemoteSample = { tick: number; points: Map<PlayerId, RemotePoint> };

/** What the sprite renderer needs to know about a player. */
type PlayerDrawInfo = {
	vy: number;
	onGround: boolean;
	mode: GeoDashMode;
	thrusting: boolean;
};

export interface GeoDashClient extends GameClient {
	/** Fit the canvas backing store (internal resolution stays 480x270). */
	resize(cssWidth: number, cssHeight: number): void;
}

class GeoDashClientImpl implements GeoDashClient {
	private readonly ctx: GameContext;
	private readonly pixel: PixelCanvas;
	private readonly input = new InputManager();
	private readonly audio = new AudioManager();
	private readonly tweens = new TweenManager();
	private readonly particles: ParticleSystem;
	private readonly camera: Camera;
	private readonly loop: FixedTimestepLoop;

	private readonly level: GeoDashLevel;
	private readonly palette: GeoDashPalette;
	private readonly reducedMotion: boolean;

	/** Private prediction sim for the local player. */
	private readonly sim: GeoDashSim;
	private readonly tickInputs = new Map<PlayerId, InputFrame>();
	private readonly playersById: Map<PlayerId, SimPlayer>;

	private readonly remoteSamples: RemoteSample[] = [];
	private readonly rotations = new Map<PlayerId, number>();
	private resizeApplied = false;
	private lastFrameMs = nowMs();

	// juice state
	private deathFlash = 0;
	private transformFlash = 0;
	private transformColor = '#ffffff';
	private splashText = '';
	private splashAlpha = 0;
	private bestPercent = 0;
	private prevSelfOnGround = true;
	private prevDrawnSelfOnGround = true;

	constructor(ctx: GameContext) {
		this.ctx = ctx;
		this.pixel = new PixelCanvas(ctx.canvas as unknown as CanvasSourceLike, {
			width: VIEW_W,
			height: VIEW_H
		});
		this.sim = createGeodashSim(ctx.seed, ctx.config, ctx.players);
		this.level = this.sim.level;
		this.palette = paletteForDifficulty(this.level.difficulty);
		// Letterbox bars get the darkest sky tone so they always read as part
		// of the scene instead of showing the page through.
		this.pixel.letterbox = this.palette.sky[0];
		this.playersById = new Map(ctx.players.map((p) => [p.id, p]));
		this.particles = new ParticleSystem({ capacity: 256 });
		this.camera = new Camera({ width: VIEW_W, height: VIEW_H, smoothing: 6, lookAhead: 0 });
		this.reducedMotion =
			ctx.config.options['reducedMotion'] === true ||
			(typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches);
		this.loop = new FixedTimestepLoop({
			tickRate: ctx.config.tickRate,
			onTick: () => this.onTick(),
			onRender: (alpha) => this.onRender(alpha)
		});
	}

	start(): void {
		this.audio.unlock();
		this.input.attach();
		this.deathFlash = 0;
		this.lastFrameMs = nowMs();
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
		this.input.detach();
		this.tweens.clear();
		this.particles.clear();
	}

	resize(cssWidth: number, cssHeight: number): void {
		this.resizeApplied = true;
		const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
		this.pixel.resize(cssWidth, cssHeight, dpr);
	}

	/** Server snapshots carry every player; we interpolate the remote ones. */
	onSnapshot(patch: GameStatePatch): void {
		const snap = parseGeoDashSnapshot(patch);
		if (!snap) return;
		const points = new Map<PlayerId, RemotePoint>();
		for (const p of snap.players) {
			points.set(p.id, {
				x: p.x,
				y: p.y,
				vy: p.vy,
				onGround: p.onGround,
				mode: p.mode,
				thrusting: (p.lastKeys & KEY.JUMP) !== 0
			});
		}
		this.remoteSamples.push({ tick: snap.tick, points });
		if (this.remoteSamples.length > MAX_REMOTE_SAMPLES) this.remoteSamples.shift();
	}

	/** Shared SFX/VFX for other players (our own come from the local sim). */
	onEvent(ev: GameEvent): void {
		const self = this.ctx.selfId;
		switch (ev.kind) {
			case 'death':
				if (ev.player === self) return;
				this.audio.sfx.death();
				this.burstAtRemote(ev.player, '#ffffff');
				break;
			case 'finish':
				if (ev.player === self) return;
				this.audio.sfx.finish();
				break;
			case 'collect':
				if (ev.player === self) return;
				this.audio.sfx.jump();
				break;
			case 'boost':
				if (ev.player === self) return;
				this.audio.sfx.boost();
				break;
			case 'transform':
				if (ev.player === self) return;
				this.audio.sfx.boost();
				this.burstAtRemote(ev.player, this.modeColor(ev.mode));
				break;
			default:
				break;
		}
	}

	// ---- fixed tick: sample input, send it, predict locally ----

	private onTick(): void {
		this.input.pollGamepads();
		const frame = this.input.sample();
		this.ctx.sendInput({ keys: frame.keys & KEY.JUMP });
		this.tickInputs.set(this.ctx.selfId, { keys: frame.keys & KEY.JUMP });
		this.sim.tickOnce(this.tickInputs);

		// Local juice driven by our own prediction sim (never stops, even on
		// death: the sim auto-respawns and input keeps flowing).
		const self = this.selfState();
		for (const ev of this.sim.drainEvents()) {
			if ('player' in ev && ev.player !== this.ctx.selfId) continue;
			this.handleLocalEvent(ev);
		}
		if (self) {
			if (self.maxProgress * 100 > this.bestPercent) {
				this.bestPercent = Math.round(self.maxProgress * 100);
			}
			if (!self.onGround && self.vy < -1 && this.prevSelfOnGround) this.audio.sfx.jump();
			this.prevSelfOnGround = self.onGround;
		}
	}

	private handleLocalEvent(ev: GameEvent): void {
		switch (ev.kind) {
			case 'death': {
				this.audio.sfx.death();
				this.camera.addTrauma(0.45);
				if (!this.reducedMotion) this.deathFlash = 2;
				const self = this.selfState();
				if (self) {
					this.particles.emit({
						kind: 'pop',
						x: self.x + HALF_CUBE,
						y: self.y + HALF_CUBE,
						count: 14,
						color: this.playersById.get(this.ctx.selfId)?.color ?? '#ffffff'
					});
				}
				break;
			}
			case 'respawn': {
				const self = this.selfState();
				this.splashText = `ATTEMPT ${self ? self.attempts : 1}`;
				this.splashAlpha = 1;
				this.tweens.to({
					from: 1,
					to: 0,
					duration: 1.1,
					ease: easeOutQuad,
					onUpdate: (value) => {
						this.splashAlpha = value;
					}
				});
				break;
			}
			case 'boost':
				this.audio.sfx.boost();
				this.camera.addTrauma(0.2);
				break;
			case 'transform': {
				this.audio.sfx.boost();
				this.camera.addTrauma(0.15);
				this.transformFlash = 3;
				this.transformColor = this.modeColor(ev.mode);
				const self = this.selfState();
				this.particles.emit({
					kind: 'ring',
					x: (self?.x ?? 0) + HALF_CUBE,
					y: (self?.y ?? 0) + HALF_CUBE,
					color: this.transformColor,
					size: 42
				});
				break;
			}
			case 'collect':
				this.audio.sfx.jump();
				this.particles.emit({
					kind: 'ring',
					x: (this.selfState()?.x ?? 0) + HALF_CUBE,
					y: (this.selfState()?.y ?? 0) + HALF_CUBE,
					color: this.palette.orb,
					size: 26
				});
				break;
			case 'finish':
				this.audio.sfx.finish();
				break;
			case 'countdown':
				this.audio.sfx.countdown();
				break;
			default:
				break;
		}
	}

	private selfState(): GeoDashPlayerState | undefined {
		return this.sim.players.find((p) => p.id === this.ctx.selfId);
	}

	/** Per-form portal/flame accent color. */
	private modeColor(mode: GeoDashMode): string {
		if (mode === 'ship') return '#6ec6ff';
		if (mode === 'ball') return '#ffd166';
		return this.palette.portal;
	}

	// ---- render ----

	private onRender(alpha: number): void {
		// If the shell never got a ResizeObserver callback before the first
		// frame (container not laid out yet), fit to the backing store now.
		if (!this.resizeApplied) {
			this.pixel.resize(this.pixel.canvas.width, this.pixel.canvas.height, 1);
		}
		const now = nowMs();
		const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
		this.lastFrameMs = now;
		this.tweens.update(dt);
		this.particles.update(dt);

		const self = this.selfState();
		if (self) {
			// Camera holds the cube at ~35% from the left, gentle vertical
			// follow with enough range to see ship corridors and ball ceilings.
			const targetX = self.x + HALF_CUBE + VIEW_W * 0.15;
			const targetY = Math.max(-115, Math.min(65, (self.y + HALF_CUBE) * 0.5));
			this.camera.follow(targetX, targetY, dt, self.speedMult * 8.5, self.vy);
		}

		const pixel = this.pixel;
		const pulse = beatPulse(this.sim.tick, this.level.bpm);
		pixel.clear(this.palette.sky[this.palette.sky.length - 1]);
		this.drawSky(pulse);
		this.drawParallax();

		pixel.ctx.save();
		this.camera.applyTo(pixel.ctx);
		this.drawWorld(pulse);
		this.particles.draw(pixel.ctx);
		this.drawPlayers(alpha);
		pixel.ctx.restore();

		this.drawSpeedLines();
		this.drawHud();
		this.drawCountdown();
		if (this.transformFlash > 0) {
			// Portal-entry flash: a tinted veil that fades over 3 frames.
			pixel.ctx.globalAlpha = 0.18 * this.transformFlash;
			pixel.fillRect(0, 0, VIEW_W, VIEW_H, this.transformColor);
			pixel.ctx.globalAlpha = 1;
			this.transformFlash--;
		}
		if (this.deathFlash > 0) {
			pixel.ctx.globalAlpha = 0.75;
			pixel.fillRect(0, 0, VIEW_W, VIEW_H, '#ffffff');
			pixel.ctx.globalAlpha = 1;
			this.deathFlash--;
		}
	}

	// ---- background layers (screen space) ----

	private drawSky(pulse: number): void {
		const pixel = this.pixel;
		const sky = this.palette.sky;
		// Screen-space bands: full coverage of every viewport row at any camera y.
		drawSkyBands((x, y, w, h, color) => pixel.fillRect(x, y, w, h, color), sky, this.camera.y);
		// pulsing glow rings on the beat
		const glow = this.palette.glow;
		for (let i = 0; i < 3; i++) {
			const base = 60 + i * 70;
			const r = base + (pulse * 0.5 + 0.5) * 18;
			pixel.ctx.globalAlpha = 0.06 + (pulse * 0.5 + 0.5) * 0.07;
			pixel.circle(VIEW_W / 2, VIEW_H * 0.62, r, glow, false);
		}
		pixel.ctx.globalAlpha = 1;
	}

	private drawParallax(): void {
		const pixel = this.pixel;
		// far pillars (depth 1)
		const far = this.palette.groundDark;
		for (const p of this.parallaxItems(0.3, 240, 1)) {
			const h = 60 + Math.floor(p.noise * 90);
			pixel.fillRect(p.screenX - 14, VIEW_H - 90 - h + p.noise * 30, 28, h + 90, far);
		}
		// near clouds (depth 2)
		const cloud = shade(this.palette.sky[2], 26);
		for (const p of this.parallaxItems(0.55, 320, 2)) {
			const y = 30 + p.noise * 70;
			pixel.ctx.globalAlpha = 0.5;
			pixel.circle(p.screenX, y, 14, cloud, true);
			pixel.circle(p.screenX + 16, y + 4, 11, cloud, true);
			pixel.circle(p.screenX - 16, y + 5, 10, cloud, true);
			pixel.ctx.globalAlpha = 1;
		}
	}

	private parallaxItems(
		factor: number,
		spacing: number,
		salt: number
	): { screenX: number; noise: number }[] {
		const out: { screenX: number; noise: number }[] = [];
		const center = this.camera.x * factor;
		const first = Math.floor((center - VIEW_W) / spacing) - 1;
		const last = Math.ceil((center + VIEW_W) / spacing) + 1;
		for (let i = first; i <= last; i++) {
			const worldX = i * spacing;
			out.push({
				screenX: worldX - center + VIEW_W / 2 + 40,
				noise: hashNoise(i * 7 + salt)
			});
		}
		return out;
	}

	// ---- world layer ----

	private drawWorld(pulse: number): void {
		const camLeft = this.camera.x - VIEW_W;
		const camRight = this.camera.x + VIEW_W;
		const objects = this.level.objects;

		// decorative scenery first (behind gameplay)
		for (const obj of objects) {
			if (obj.type !== 'deco') continue;
			if (obj.x < camLeft || obj.x > camRight) continue;
			this.drawDeco(obj.x, obj.y, obj.kind);
		}

		for (const obj of objects) {
			if (obj.x < camLeft || obj.x > camRight) continue;
			switch (obj.type) {
				case 'block': {
					const { w, h } = blockSize(obj);
					this.drawBlock(obj.x, obj.y, w, h);
					break;
				}
				case 'spike':
					this.drawSpike(obj.x, obj.y, obj.flip === true);
					break;
				case 'saw':
					this.drawSaw(obj.x, obj.y, obj.r ?? 22, obj.spin ?? 1);
					break;
				case 'pad':
					this.drawPad(obj.x, obj.y, obj.power);
					break;
				case 'orb':
					this.drawOrb(obj.x, obj.y, pulse);
					break;
				case 'speed':
				case 'gravity':
					this.drawPortal(obj.x, obj.y, obj.type === 'gravity');
					break;
				case 'portal':
					this.drawModePortal(obj.x, obj.mode);
					break;
				default:
					break;
			}
		}

		// finish line
		const fx = this.level.lengthPx;
		if (fx > camLeft && fx < camRight) this.drawFinish(fx);
	}

	private drawBlock(x: number, y: number, w: number, h: number): void {
		const pixel = this.pixel;
		if (y >= 0) {
			// ground slab with a glowing top line
			pixel.fillRect(x, y, w, h, this.palette.ground);
			pixel.fillRect(x, y, w, 2, this.palette.groundTop);
			pixel.fillRect(x, y + 2, w, 3, this.palette.groundDark);
			for (let sx = x + 20; sx < x + w; sx += 40) {
				pixel.line(sx, y + 6, sx, y + h, this.palette.groundDark);
			}
			return;
		}
		pixel.fillRect(x, y, w, h, this.palette.block);
		pixel.fillRect(x, y, w, 2, this.palette.blockLight);
		pixel.fillRect(x, y, 2, h, this.palette.blockLight);
		pixel.fillRect(x, y + h - 2, w, 2, this.palette.blockDark);
		pixel.fillRect(x + w - 2, y, 2, h, this.palette.blockDark);
		for (let sx = x + 10; sx < x + w - 8; sx += 20) {
			pixel.fillRect(sx, y + 10, 4, 4, this.palette.blockDark);
		}
	}

	private drawSpike(x: number, y: number, flip: boolean): void {
		const pixel = this.pixel;
		const w = 40;
		const h = 40;
		// stacked rows make a crisp triangle; two tones + bright tip.
		// flip = hanging spike pointing DOWN (narrow at the bottom).
		for (let row = 0; row < h; row += 2) {
			const half = (w / 2) * (1 - row / h);
			const ry = flip ? y + row : y + h - row - 2;
			pixel.fillRect(x + w / 2 - half, ry, half * 2, 2, this.palette.spike);
			pixel.fillRect(x + w / 2 - half, ry, half, 2, this.palette.spikeDark);
		}
		const tipY = flip ? y + h - 4 : y;
		pixel.fillRect(x + w / 2 - 2, tipY, 4, 4, this.palette.spikeTip);
	}

	private drawSaw(cx: number, cy: number, r: number, spin: number): void {
		const pixel = this.pixel;
		const angle = this.sim.tick * 0.22 * spin + cx * 0.01;
		pixel.circle(cx, cy, r, this.palette.saw, true);
		pixel.ctx.save();
		pixel.ctx.translate(cx, cy);
		pixel.ctx.rotate(angle);
		for (let i = 0; i < 6; i++) {
			pixel.ctx.rotate(Math.PI / 3);
			pixel.fillRect(-3, -r - 5, 6, 9, this.palette.sawBlade);
		}
		pixel.ctx.restore();
		pixel.circle(cx, cy, r * 0.45, this.palette.sawBlade, true);
		pixel.circle(cx, cy, r * 0.18, this.palette.saw, true);
	}

	private drawPad(x: number, y: number, power: number): void {
		const pixel = this.pixel;
		const rect = padRect({ x, y });
		const color = power >= 1.8 ? '#ff5c7a' : this.palette.pad;
		pixel.fillRect(rect.x, rect.y, rect.w, rect.h, this.palette.groundDark);
		pixel.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 3, color);
		// chevron
		pixel.line(rect.x + 12, rect.y + 6, rect.x + 20, rect.y + 2, '#ffffff');
		pixel.line(rect.x + 20, rect.y + 2, rect.x + 28, rect.y + 6, '#ffffff');
	}

	private drawOrb(x: number, y: number, pulse: number): void {
		const pixel = this.pixel;
		const r = 15 + pulse * 2;
		pixel.circle(x, y, r, this.palette.orb, false);
		pixel.ctx.globalAlpha = 0.5;
		pixel.circle(x, y, r * 0.55, this.palette.orb, true);
		pixel.ctx.globalAlpha = 1;
		for (let i = 0; i < 4; i++) {
			const a = this.sim.tick * 0.06 + (i * Math.PI) / 2;
			pixel.fillRect(x + Math.cos(a) * (r + 6) - 1, y + Math.sin(a) * (r + 6) - 1, 3, 3, '#ffffff');
		}
	}

	private drawPortal(x: number, y: number, gravity: boolean): void {
		const pixel = this.pixel;
		const color = gravity ? '#c163e8' : this.palette.portal;
		const top = y;
		const h = 120;
		pixel.fillRect(x - 2, top, 4, h, color);
		pixel.fillRect(x + 10, top, 4, h, color);
		for (let sy = top + 4; sy < top + h - 4; sy += 12) {
			const shimmer = (sy + this.sim.tick * 3) % 24 < 12 ? 0.35 : 0.15;
			pixel.ctx.globalAlpha = shimmer;
			pixel.fillRect(x, sy, 12, 8, color);
		}
		pixel.ctx.globalAlpha = 1;
	}

	/** Mode portal: shimmering gate with a form glyph (cube / rocket / ball). */
	private drawModePortal(x: number, mode: GeoDashMode): void {
		const pixel = this.pixel;
		const color = this.modeColor(mode);
		const gate = portalGate({ x });
		pixel.fillRect(gate.x, gate.y, 3, gate.h, color);
		pixel.fillRect(gate.x + gate.w - 3, gate.y, 3, gate.h, color);
		for (let sy = gate.y + 4; sy < gate.y + gate.h - 4; sy += 12) {
			const shimmer = (sy + this.sim.tick * 3) % 24 < 12 ? 0.3 : 0.12;
			pixel.ctx.globalAlpha = shimmer;
			pixel.fillRect(gate.x + 3, sy, gate.w - 6, 8, color);
		}
		pixel.ctx.globalAlpha = 1;
		// Form glyph at mid-height, so the player can read the portal early.
		const gx = x + 4;
		const gy = gate.y + gate.h / 2;
		if (mode === 'cube') {
			pixel.fillRect(gx - 8, gy - 8, 16, 16, color);
			pixel.fillRect(gx - 5, gy - 5, 10, 10, '#1a1c2c');
		} else if (mode === 'ship') {
			pixel.fillRect(gx - 4, gy - 10, 8, 16, color);
			pixel.fillRect(gx - 8, gy + 2, 16, 6, color);
			pixel.fillRect(gx - 2, gy - 14, 4, 4, '#ffffff');
		} else {
			pixel.circle(gx, gy, 9, color, true);
			pixel.circle(gx, gy, 4, '#1a1c2c', true);
		}
	}

	private drawFinish(x: number): void {
		const pixel = this.pixel;
		for (let row = 0; row < 14; row++) {
			for (let col = 0; col < 2; col++) {
				const dark = (row + col) % 2 === 0;
				pixel.fillRect(
					x + col * 10,
					-140 + row * 10,
					10,
					10,
					dark ? '#1a1c2c' : this.palette.finish
				);
			}
		}
		pixel.ctx.globalAlpha = 0.25;
		pixel.fillRect(x - 2, -140, 24, 140, this.palette.glow);
		pixel.ctx.globalAlpha = 1;
	}

	private drawDeco(x: number, y: number, kind: 'pillar' | 'tree' | 'cloud'): void {
		const pixel = this.pixel;
		const dark = this.palette.groundDark;
		if (kind === 'pillar') {
			pixel.fillRect(x, y, 24, 200, dark);
			pixel.fillRect(x - 6, y, 36, 12, shade(dark, 18));
		} else if (kind === 'tree') {
			pixel.fillRect(x - 4, y, 8, 50, shade(dark, -10));
			pixel.ctx.globalAlpha = 0.85;
			pixel.circle(x, y - 8, 22, shade(dark, 24), true);
			pixel.circle(x - 16, y + 2, 16, shade(dark, 18), true);
			pixel.circle(x + 16, y + 2, 16, shade(dark, 18), true);
			pixel.ctx.globalAlpha = 1;
		} else {
			pixel.ctx.globalAlpha = 0.6;
			pixel.circle(x, y, 16, shade(this.palette.sky[3], 24), true);
			pixel.circle(x + 18, y + 5, 12, shade(this.palette.sky[3], 24), true);
			pixel.circle(x - 18, y + 6, 11, shade(this.palette.sky[3], 24), true);
			pixel.ctx.globalAlpha = 1;
		}
	}

	// ---- players ----

	private drawPlayers(alpha: number): void {
		const delayTicks = Math.max(1, Math.round(this.ctx.config.tickRate * REMOTE_DELAY_SECONDS));
		const renderTick = this.sim.tick - delayTicks + alpha;
		for (const player of this.ctx.players) {
			if (player.id === this.ctx.selfId) continue;
			const pos = this.remotePos(player.id, renderTick);
			if (!pos) continue;
			this.drawPlayer(pos.x, pos.y, player, pos, GHOST_ALPHA, player.name);
		}
		const self = this.selfState();
		if (self) {
			const meta = this.playersById.get(this.ctx.selfId);
			if (meta) {
				const info: PlayerDrawInfo = {
					vy: self.vy,
					onGround: self.onGround,
					mode: self.mode,
					thrusting: (self.lastKeys & KEY.JUMP) !== 0
				};
				this.drawPlayer(self.x, self.y, meta, info, 1, null);
				this.particles.emit({
					kind: 'trail',
					x: self.x - 2,
					y: self.y + HALF_CUBE,
					count: 1,
					speed: 12,
					life: 0.22,
					size: 3,
					color: meta.color
				});
				if (self.onGround && !this.prevDrawnSelfOnGround) {
					this.particles.emit({
						kind: 'dust',
						x: self.x + HALF_CUBE,
						y: self.y + CUBE_SIZE,
						count: 5,
						speed: 30,
						color: this.palette.groundTop
					});
				}
				this.prevDrawnSelfOnGround = self.onGround;
			}
		}
	}

	private drawPlayer(
		x: number,
		y: number,
		player: SimPlayer,
		info: PlayerDrawInfo,
		alpha: number,
		name: string | null
	): void {
		if (info.mode === 'ship') this.drawShip(x, y, player, info.vy, info.thrusting, alpha);
		else if (info.mode === 'ball') this.drawBall(x, y, player, alpha);
		else this.drawCube(x, y, player, info.vy, info.onGround, alpha);

		if (name) {
			const cx = x + HALF_CUBE;
			const label = name.toUpperCase().slice(0, 8);
			this.pixel.ctx.globalAlpha = alpha;
			this.pixel.text(label, cx - this.pixel.textWidth(label, 1) / 2, y - 12, '#ffffff', 1);
			this.pixel.ctx.globalAlpha = 1;
		}
	}

	private drawCube(
		x: number,
		y: number,
		player: SimPlayer,
		vy: number,
		onGround: boolean,
		alpha: number
	): void {
		const pixel = this.pixel;
		const cx = x + HALF_CUBE;
		const cy = y + HALF_CUBE;

		// visual-only rotation: 90deg per jump arc, snaps flat on landing
		const prev = this.rotations.get(player.id) ?? 0;
		const angle = onGround ? 0 : prev + 0.055 + Math.max(0, -vy) * 0.0015;
		this.rotations.set(player.id, angle);

		pixel.ctx.save();
		pixel.ctx.globalAlpha = alpha;
		pixel.ctx.translate(cx, cy);
		pixel.ctx.rotate(angle);
		const half = HALF_CUBE;
		pixel.fillRect(-half, -half, CUBE_SIZE, CUBE_SIZE, player.color);
		pixel.fillRect(-half, -half, CUBE_SIZE, 3, shade(player.color, 42));
		pixel.fillRect(-half, -half, 3, CUBE_SIZE, shade(player.color, 42));
		pixel.fillRect(-half, half - 3, CUBE_SIZE, 3, shade(player.color, -42));
		pixel.fillRect(half - 3, -half, 3, CUBE_SIZE, shade(player.color, -42));
		pixel.fillRect(-half + 4, -half + 4, CUBE_SIZE - 8, CUBE_SIZE - 8, shade(player.color, -18));
		// simple face
		pixel.fillRect(-7, -5, 4, 5, '#1a1c2c');
		pixel.fillRect(3, -5, 4, 5, '#1a1c2c');
		pixel.fillRect(-6, -4, 2, 2, '#ffffff');
		pixel.fillRect(4, -4, 2, 2, '#ffffff');
		pixel.fillRect(-5, 5, 10, 2, '#1a1c2c');
		pixel.ctx.restore();
	}

	/** Ship: little rocket, nose tilted toward vertical velocity, thrust flame. */
	private drawShip(
		x: number,
		y: number,
		player: SimPlayer,
		vy: number,
		thrusting: boolean,
		alpha: number
	): void {
		const pixel = this.pixel;
		const cx = x + HALF_CUBE;
		const cy = y + HALF_CUBE;
		const angle = Math.max(-0.5, Math.min(0.5, vy * 0.055));

		pixel.ctx.save();
		pixel.ctx.globalAlpha = alpha;
		pixel.ctx.translate(cx, cy);
		pixel.ctx.rotate(angle);
		// hull
		pixel.fillRect(-13, -6, 26, 12, player.color);
		pixel.fillRect(-13, -6, 26, 3, shade(player.color, 42));
		pixel.fillRect(-13, 3, 26, 3, shade(player.color, -42));
		// nose cone + tip
		pixel.fillRect(13, -4, 5, 8, shade(player.color, 30));
		pixel.fillRect(18, -2, 3, 4, '#ffffff');
		// fins
		pixel.fillRect(-11, -10, 8, 4, shade(player.color, -25));
		pixel.fillRect(-11, 6, 8, 4, shade(player.color, -25));
		// cockpit
		pixel.fillRect(1, -5, 7, 6, '#1a1c2c');
		pixel.fillRect(2, -4, 3, 2, '#ffffff');
		if (thrusting) {
			// deterministic flame flicker
			const flick = this.sim.tick % 3;
			pixel.fillRect(-22 - flick, -3, 9 + flick * 2, 6, '#ffd166');
			pixel.fillRect(-18 - flick, -2, 5 + flick, 4, '#ff8a3a');
			pixel.fillRect(-15, -1, 4, 2, '#fff6d8');
		}
		pixel.ctx.restore();
	}

	/** Ball: rolling orb with a spin cross + face. */
	private drawBall(x: number, y: number, player: SimPlayer, alpha: number): void {
		const pixel = this.pixel;
		const cx = x + HALF_CUBE;
		const cy = y + HALF_CUBE;
		const spin = x * 0.075;

		pixel.ctx.save();
		pixel.ctx.globalAlpha = alpha;
		pixel.ctx.translate(cx, cy);
		pixel.circle(0, 0, 15, player.color, true);
		pixel.ctx.rotate(spin);
		pixel.fillRect(-3, -13, 6, 26, shade(player.color, -35));
		pixel.fillRect(-13, -3, 26, 6, shade(player.color, -35));
		pixel.ctx.rotate(-spin);
		pixel.circle(-5, -6, 4, shade(player.color, 45), true);
		pixel.fillRect(-8, -1, 3, 4, '#1a1c2c');
		pixel.fillRect(4, -1, 3, 4, '#1a1c2c');
		pixel.fillRect(-7, 0, 1, 1, '#ffffff');
		pixel.fillRect(5, 0, 1, 1, '#ffffff');
		pixel.ctx.restore();
	}

	// ---- screen-space juice + HUD ----

	private drawSpeedLines(): void {
		const self = this.selfState();
		if (!self || self.speedMult < 1.3 || this.reducedMotion) return;
		const pixel = this.pixel;
		const t = this.sim.tick;
		pixel.ctx.globalAlpha = 0.18 + (self.speedMult - 1.3) * 0.25;
		for (let i = 0; i < 8; i++) {
			const y = ((i * 71 + ((t * (3 + (i % 3))) % VIEW_H)) % VIEW_H) | 0;
			const x = (((i * 131 - t * 14) % (VIEW_W + 80)) + VIEW_W + 80) % (VIEW_W + 80);
			pixel.fillRect(x - 60, y, 60, 2, '#ffffff');
		}
		pixel.ctx.globalAlpha = 1;
	}

	private drawHud(): void {
		const pixel = this.pixel;
		const self = this.selfState();
		const progress = self ? Math.round(self.maxProgress * 100) : 0;

		// top strip: level name + difficulty pips
		pixel.fillRect(0, 0, VIEW_W, 22, '#000000');
		pixel.ctx.globalAlpha = 0.45;
		pixel.fillRect(0, 0, VIEW_W, 22, '#1a1c2c');
		pixel.ctx.globalAlpha = 1;
		pixel.text(this.level.name.toUpperCase().slice(0, 14), 6, 4, '#ffffff', 1);
		for (let i = 0; i < 5; i++) {
			pixel.fillRect(
				6 + i * 8,
				14,
				6,
				5,
				i < this.level.difficulty ? this.palette.glow : '#3a4066'
			);
		}

		// progress bar with ghost markers
		const barX = 120;
		const barW = 200;
		pixel.fillRect(barX, 8, barW, 6, '#0d1024');
		pixel.fillRect(barX + 1, 9, Math.round((barW - 2) * (progress / 100)), 4, this.palette.glow);
		for (const player of this.ctx.players) {
			if (player.id === this.ctx.selfId) continue;
			const pos = this.remotePos(player.id, this.sim.tick);
			if (!pos) continue;
			const pct = Math.max(0, Math.min(1, pos.x / this.level.lengthPx));
			pixel.fillRect(barX + Math.round(pct * (barW - 3)), 6, 3, 10, player.color);
		}

		pixel.text(`${progress}%`, barX + barW + 8, 8, '#ffffff', 1);
		pixel.text(
			`ATTEMPT ${self ? self.attempts : 1}`,
			VIEW_W - 6 - pixel.textWidth(`ATTEMPT ${self ? self.attempts : 1}`, 1),
			4,
			'#ffffff',
			1
		);
		pixel.text(
			`BEST ${this.bestPercent}%`,
			VIEW_W - 6 - pixel.textWidth(`BEST ${this.bestPercent}%`, 1),
			13,
			'#8b97b5',
			1
		);

		// attempt splash (tweened fade)
		if (this.splashAlpha > 0.02 && this.splashText) {
			pixel.ctx.globalAlpha = Math.max(0, this.splashAlpha);
			const w = pixel.textWidth(this.splashText, 2);
			pixel.text(this.splashText, VIEW_W / 2 - w / 2, 64, '#ffffff', 2);
			pixel.ctx.globalAlpha = 1;
		}
	}

	private drawCountdown(): void {
		const tick = this.sim.tick;
		const countdownTicks = this.countdownTicks;
		if (countdownTicks <= 0 || tick > countdownTicks + 30) return;
		const pixel = this.pixel;
		let label: string;
		if (tick < countdownTicks) {
			label = String(Math.max(1, 3 - Math.floor(tick / (countdownTicks / 3))));
		} else {
			label = 'GO!';
		}
		const w = pixel.textWidth(label, 6);
		pixel.ctx.globalAlpha = 0.85;
		pixel.text(label, VIEW_W / 2 - w / 2, VIEW_H / 2 - 40, '#ffffff', 6);
		pixel.ctx.globalAlpha = 1;
	}

	private get countdownTicks(): number {
		const v = this.ctx.config.options['countdownTicks'];
		return typeof v === 'number' && Number.isFinite(v) ? v : COUNTDOWN_TICKS;
	}

	private burstAtRemote(id: PlayerId, color: string): void {
		const pos = this.remotePos(id, this.sim.tick);
		if (!pos) return;
		this.particles.emit({
			kind: 'pop',
			x: pos.x + HALF_CUBE,
			y: pos.y + HALF_CUBE,
			count: 10,
			color
		});
	}

	/** Interpolate a remote player between the two nearest snapshots. */
	private remotePos(id: PlayerId, atTick: number): RemotePoint | null {
		const buf = this.remoteSamples;
		if (buf.length === 0) return null;
		let prev: RemoteSample | null = null;
		let next: RemoteSample | null = null;
		for (const sample of buf) {
			if (sample.tick <= atTick) prev = sample;
			else {
				next = sample;
				break;
			}
		}
		if (!prev) return next?.points.get(id) ?? null;
		const a = prev.points.get(id);
		if (!next) return a ?? null;
		const b = next.points.get(id);
		if (!a || !b) return a ?? b ?? null;
		const span = next.tick - prev.tick;
		const t = span > 0 ? (atTick - prev.tick) / span : 1;
		return {
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
			vy: b.vy,
			onGround: b.onGround,
			mode: b.mode,
			thrusting: b.thrusting
		};
	}
}

export function createGeodashClient(ctx: GameContext): GeoDashClient {
	return new GeoDashClientImpl(ctx);
}
