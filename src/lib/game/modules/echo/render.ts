/**
 * Echo Arena renderer/client. Draws the arena and players on a 480x270
 * PixelCanvas, predicts the local player through a private sim fed by local
 * input, and interpolates remote players from server snapshots buffered
 * ~100ms in the past. Proves the GameClient contract end to end.
 */
import type {
	GameClient,
	GameContext,
	GameEvent,
	GameStatePatch,
	InputFrame,
	PlayerId,
	SimPlayer
} from '../../types';
import { AudioManager } from '../../engine/audio';
import { PixelCanvas, type CanvasSourceLike } from '../../engine/gfx';
import { InputManager } from '../../engine/input';
import { FixedTimestepLoop } from '../../engine/loop';
import { TweenManager, easeOutBack } from '../../engine/tween';
import { nowMs } from '../../engine/fixed';
import {
	ECHO_ARENA_HEIGHT,
	ECHO_ARENA_WIDTH,
	ECHO_PLAYER_SIZE,
	createEchoSim,
	parseEchoSnapshot,
	type EchoSim
} from './sim';

const HALF = ECHO_PLAYER_SIZE / 2;
const GRID = 24;
const BG = '#14162b';
const GRID_COLOR = '#1d2140';
const BORDER = '#2d3366';
const TEXT = '#e8e8f0';
const TEXT_DIM = '#8b97b5';
const MAX_REMOTE_SAMPLES = 32;

type RemotePoint = { x: number; y: number };
type RemoteSample = { tick: number; points: Map<PlayerId, RemotePoint> };

export interface EchoClient extends GameClient {
	/** Fit the canvas backing store (internal resolution stays 480x270). */
	resize(cssWidth: number, cssHeight: number): void;
}

class EchoClientImpl implements EchoClient {
	private readonly ctx: GameContext;
	private readonly pixel: PixelCanvas;
	private readonly input = new InputManager();
	private readonly audio = new AudioManager();
	private readonly tweens = new TweenManager();
	private readonly loop: FixedTimestepLoop;

	/** Private prediction sim for the local player. */
	private readonly sim: EchoSim;
	private readonly tickInputs = new Map<PlayerId, InputFrame>();
	private readonly playersById: Map<PlayerId, SimPlayer>;

	private readonly remoteSamples: RemoteSample[] = [];
	private goProgress = 0;
	private lastFrameMs = nowMs();

	constructor(ctx: GameContext) {
		this.ctx = ctx;
		this.pixel = new PixelCanvas(ctx.canvas as unknown as CanvasSourceLike, {
			width: ECHO_ARENA_WIDTH,
			height: ECHO_ARENA_HEIGHT
		});
		this.sim = createEchoSim(ctx.seed, ctx.config, ctx.players);
		this.playersById = new Map(ctx.players.map((p) => [p.id, p]));
		this.loop = new FixedTimestepLoop({
			tickRate: ctx.config.tickRate,
			onTick: (tick) => this.onTick(tick),
			onRender: (alpha, tick) => this.onRender(alpha, tick)
		});
	}

	start(): void {
		this.audio.unlock();
		this.input.attach();
		this.goProgress = 0;
		this.tweens.to({
			from: 0,
			to: 1,
			duration: 0.9,
			ease: easeOutBack,
			onUpdate: (value) => {
				this.goProgress = value;
			}
		});
		this.lastFrameMs = nowMs();
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
		this.input.detach();
		this.tweens.clear();
	}

	resize(cssWidth: number, cssHeight: number): void {
		this.pixel.resize(cssWidth, cssHeight);
	}

	/** Server snapshots carry every player; we interpolate the remote ones. */
	onSnapshot(patch: GameStatePatch): void {
		const snap = parseEchoSnapshot(patch);
		if (!snap) return;
		const points = new Map<PlayerId, RemotePoint>();
		for (const p of snap.players) points.set(p.id, { x: p.x, y: p.y });
		this.remoteSamples.push({ tick: snap.tick, points });
		if (this.remoteSamples.length > MAX_REMOTE_SAMPLES) this.remoteSamples.shift();
	}

	onEvent(ev: GameEvent): void {
		switch (ev.kind) {
			case 'spawn':
				this.audio.sfx.click();
				break;
			case 'boost':
				this.audio.sfx.boost();
				break;
			case 'death':
				this.audio.sfx.death();
				break;
			case 'countdown':
				this.audio.sfx.countdown();
				break;
			case 'hit':
				this.audio.sfx.click();
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

	private onTick(_tick: number): void {
		this.input.pollGamepads();
		const frame = this.input.sample();
		this.ctx.sendInput(frame);
		this.tickInputs.set(this.ctx.selfId, frame);
		this.sim.tickOnce(this.tickInputs);
	}

	// ---- render ----

	private onRender(alpha: number, _tick: number): void {
		const now = nowMs();
		const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameMs) / 1000));
		this.lastFrameMs = now;
		this.tweens.update(dt);

		const pixel = this.pixel;
		pixel.clear(BG);
		this.drawGrid();

		// Remotes render ~100ms in the past, between two buffered snapshots.
		const delayTicks = Math.max(1, Math.round(this.ctx.config.tickRate * 0.1));
		const renderTick = this.sim.tick - delayTicks + alpha;
		for (const player of this.ctx.players) {
			if (player.id === this.ctx.selfId) continue;
			const pos = this.remotePos(player.id, renderTick);
			if (pos) this.drawPlayer(pos.x, pos.y, player);
		}

		// Local player is predicted from local input through the private sim.
		const self = this.sim.players.find((p) => p.id === this.ctx.selfId);
		if (self) {
			const meta = this.playersById.get(this.ctx.selfId);
			if (meta) this.drawPlayer(self.x, self.y, meta);
		}

		this.drawHud();
		this.drawGoPop();
	}

	private drawGrid(): void {
		const pixel = this.pixel;
		for (let x = 0; x <= ECHO_ARENA_WIDTH; x += GRID) {
			pixel.line(x, 0, x, ECHO_ARENA_HEIGHT, GRID_COLOR);
		}
		for (let y = 0; y <= ECHO_ARENA_HEIGHT; y += GRID) {
			pixel.line(0, y, ECHO_ARENA_WIDTH, y, GRID_COLOR);
		}
		pixel.rect(0.5, 0.5, ECHO_ARENA_WIDTH - 1, ECHO_ARENA_HEIGHT - 1, BORDER);
	}

	private drawPlayer(x: number, y: number, player: SimPlayer): void {
		const pixel = this.pixel;
		pixel.fillRect(x - HALF, y - HALF, ECHO_PLAYER_SIZE, ECHO_PLAYER_SIZE, player.color);
		pixel.rect(
			x - HALF + 0.5,
			y - HALF + 0.5,
			ECHO_PLAYER_SIZE - 1,
			ECHO_PLAYER_SIZE - 1,
			'#1a1c2c'
		);
		const name = player.name.toUpperCase();
		pixel.text(name, x - pixel.textWidth(name, 1) / 2, y - HALF - 10, TEXT, 1);
	}

	private drawHud(): void {
		const pixel = this.pixel;
		const ranked = this.sim.players
			.slice()
			.sort((a, b) => b.distance - a.distance || (a.id < b.id ? -1 : 1));
		pixel.text('DISTANCE', 6, 6, TEXT_DIM, 1);
		ranked.forEach((p, i) => {
			const meta = this.playersById.get(p.id);
			const isSelf = p.id === this.ctx.selfId;
			const label = (meta?.name ?? p.id).toUpperCase();
			pixel.text(label, 6, 16 + i * 10, isSelf ? (meta?.color ?? TEXT) : TEXT_DIM, 1);
			pixel.text(String(Math.round(p.distance)), 120, 16 + i * 10, isSelf ? TEXT : TEXT_DIM, 1);
		});
	}

	private drawGoPop(): void {
		if (this.goProgress >= 1) return;
		const pixel = this.pixel;
		const scale = 2 + Math.round(2 * Math.max(0, 1 - this.goProgress));
		const label = 'GO!';
		pixel.ctx.globalAlpha = Math.max(0, 1 - this.goProgress);
		pixel.text(
			label,
			ECHO_ARENA_WIDTH / 2 - pixel.textWidth(label, scale) / 2,
			ECHO_ARENA_HEIGHT / 2 - 20,
			TEXT,
			scale
		);
		pixel.ctx.globalAlpha = 1;
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
		return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
	}
}

export function createEchoClient(ctx: GameContext): EchoClient {
	return new EchoClientImpl(ctx);
}
