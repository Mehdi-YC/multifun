/**
 * GeoDash renderer coverage tests (user report: "sometimes we don't see the
 * bg"). A recording fake draw backend tracks every painted backing-store
 * pixel; a rendered frame must cover the WHOLE backing store — letterbox bars
 * included — at every canvas size and at every camera extreme (level start,
 * max jump height, level end, out-of-range camera). The sky layer alone must
 * cover all 270 internal rows for any camera shift.
 */
import { describe, expect, it } from 'vitest';
import type { GameContext, SimPlayer } from '../types';
import { KEY } from '../types';
import type { Camera } from '../engine/camera';
import { PixelCanvas, type Canvas2DLike, type CanvasSourceLike } from '../engine/gfx';
import { blockSize } from './level-types';
import type { GeoDashLevel, GeoDashMode } from './level-types';
import { LEVELS } from './levels';
import { createGeodashClient, paletteForDifficulty, type GeoDashClient } from './render';
import type { GeoDashSim } from './sim';

// ---- recording fake draw backend (see engine/gfx.spec.ts for the full one) ----

type Matrix = [number, number, number, number, number, number];

class Recording2D implements Canvas2DLike {
	fillStyle = '#000000';
	strokeStyle = '#000000';
	lineWidth = 1;
	imageSmoothingEnabled = false;
	globalAlpha = 1;

	/** Every solid fillRect in device coords (for sprite assertions). */
	fillOps: { x0: number; y0: number; x1: number; y1: number; style: string }[] = [];

	private matrix: Matrix = [1, 0, 0, 1, 0, 0];
	private stack: Matrix[] = [];
	private painted!: Uint8Array;

	width = 0;
	height = 0;

	resetBacking(width: number, height: number): void {
		this.width = Math.max(0, Math.floor(width) || 0);
		this.height = Math.max(0, Math.floor(height) || 0);
		this.painted = new Uint8Array(this.width * this.height);
		this.matrix = [1, 0, 0, 1, 0, 0];
		this.stack = [];
		this.globalAlpha = 1;
		this.fillOps = [];
	}

	clearCoverage(): void {
		this.painted.fill(0);
		this.fillOps = [];
	}

	uncovered(): { x: number; y: number }[] {
		const out: { x: number; y: number }[] = [];
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				if (this.painted[y * this.width + x] === 0) out.push({ x, y });
			}
		}
		return out;
	}

	save(): void {
		this.stack.push([...this.matrix] as Matrix);
	}

	restore(): void {
		this.matrix = this.stack.pop() ?? this.matrix;
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.matrix = [a, b, c, d, e, f];
	}

	translate(x: number, y: number): void {
		this.concat([1, 0, 0, 1, x, y]);
	}

	scale(x: number, y: number): void {
		this.concat([x, 0, 0, y, 0, 0]);
	}

	rotate(angle: number): void {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		this.concat([c, s, -s, c, 0, 0]);
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		this.mark(x, y, w, h, 0);
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		if (this.globalAlpha > 0.5) {
			const rect = this.mark(x, y, w, h, 1);
			if (rect) this.fillOps.push({ ...rect, style: this.fillStyle });
		}
	}

	strokeRect(): void {}
	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	arc(): void {}
	fill(): void {}
	stroke(): void {}
	drawImage(): void {}

	private concat(m: Matrix): void {
		const [a, b, c, d, e, f] = this.matrix;
		const [na, nb, nc, nd, ne, nf] = m;
		this.matrix = [
			a * na + c * nb,
			b * na + d * nb,
			a * nc + c * nd,
			b * nc + d * nd,
			a * ne + c * nf + e,
			b * ne + d * nf + f
		];
	}

	private mark(
		x: number,
		y: number,
		w: number,
		h: number,
		value: 0 | 1
	): { x0: number; y0: number; x1: number; y1: number } | null {
		const [a, b, c, d, e, f] = this.matrix;
		const corners = [
			[a * x + c * y + e, b * x + d * y + f],
			[a * (x + w) + c * y + e, b * (x + w) + d * y + f],
			[a * x + c * (y + h) + e, b * x + d * (y + h) + f],
			[a * (x + w) + c * (y + h) + e, b * (x + w) + d * (y + h) + f]
		];
		const xs = corners.map((p) => p[0]);
		const ys = corners.map((p) => p[1]);
		const x0 = Math.max(0, Math.floor(Math.min(...xs)));
		const x1 = Math.min(this.width, Math.ceil(Math.max(...xs)));
		const y0 = Math.max(0, Math.floor(Math.min(...ys)));
		const y1 = Math.min(this.height, Math.ceil(Math.max(...ys)));
		for (let py = y0; py < y1; py++) {
			for (let px = x0; px < x1; px++) {
				this.painted[py * this.width + px] = value;
			}
		}
		return { x0, y0, x1, y1 };
	}
}

class FakeCanvas implements CanvasSourceLike {
	readonly ctx: Recording2D = new Recording2D();
	private w: number;
	private h: number;

	constructor(width = 900, height = 700) {
		this.w = width;
		this.h = height;
		this.ctx.resetBacking(width, height);
	}

	get width(): number {
		return this.w;
	}

	set width(value: number) {
		this.w = value;
		this.ctx.resetBacking(this.w, this.h);
	}

	get height(): number {
		return this.h;
	}

	set height(value: number) {
		this.h = value;
		this.ctx.resetBacking(this.w, this.h);
	}

	getContext(type: '2d'): Canvas2DLike | null {
		return type === '2d' ? this.ctx : null;
	}
}

// ---- helpers ----

const PLAYERS: SimPlayer[] = [{ id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 }];

interface ClientInternals {
	pixel: PixelCanvas;
	camera: Camera;
	sim: GeoDashSim;
	onRender(alpha: number): void;
	drawSky(pulse: number): void;
	handleLocalEvent(ev: { kind: string; player: string; mode: GeoDashMode }): void;
}

function makeClient(
	canvas: CanvasSourceLike,
	levelId = 'level-1',
	level?: Record<string, unknown>
): { client: GeoDashClient; internals: ClientInternals } {
	const options: Record<string, unknown> = { countdownTicks: 0, levelId };
	if (level) options['level'] = level;
	const ctx: GameContext = {
		canvas: canvas as unknown as HTMLCanvasElement,
		selfId: 'p1',
		players: PLAYERS,
		seed: 1,
		config: { tickRate: 60, durationTicks: 7200, options },
		sendInput: () => {},
		onEnd: () => {}
	};
	const client = createGeodashClient(ctx);
	return { client, internals: client as unknown as ClientInternals };
}

function expectFullyPainted(rec: Recording2D, what: string): void {
	const gaps = rec.uncovered();
	expect(
		gaps.length,
		`${what}: ${gaps.length} unpainted px, first: ${JSON.stringify(gaps.slice(0, 8))}`
	).toBe(0);
}

const SIZES: [number, number][] = [
	[960, 540],
	[800, 600],
	[320, 900],
	[200, 120],
	[480, 270]
];

/** Camera extremes: spawn, max jump height, level end, plus out-of-range y. */
function cameraExtremes(internals: ClientInternals): { name: string; x: number; y: number }[] {
	const length = internals.sim.level.lengthPx;
	return [
		{ name: 'level start', x: 220, y: 0 },
		{ name: 'max jump height', x: 900, y: -110 },
		{ name: 'level end', x: length, y: 0 },
		{ name: 'camera far below', x: 1200, y: 800 },
		{ name: 'camera far above', x: 1200, y: -800 }
	];
}

// ---- full-frame coverage ----

describe('geodash frames paint the whole backing store', () => {
	for (const [w, h] of SIZES) {
		it(`covers every pixel at ${w}x${h} at every camera extreme`, () => {
			const canvas = new FakeCanvas(w, h);
			const { client, internals } = makeClient(canvas);
			client.resize(w, h);
			for (const cam of cameraExtremes(internals)) {
				internals.camera.setPosition(cam.x, cam.y);
				canvas.ctx.clearCoverage();
				internals.onRender(0);
				expectFullyPainted(canvas.ctx, `frame at ${w}x${h} (${cam.name})`);
			}
			client.stop();
		});
	}

	it('covers every pixel on the first frame even before resize is called', () => {
		// The shell may render before its ResizeObserver fires: the client must
		// lazily fit itself to the backing store it was given.
		const canvas = new FakeCanvas(900, 700);
		const { client, internals } = makeClient(canvas);
		canvas.ctx.clearCoverage();
		internals.onRender(0);
		expectFullyPainted(canvas.ctx, 'first frame before resize');
		client.stop();
	});

	it('resize() then frame stays fully painted and consistent', () => {
		const canvas = new FakeCanvas(300, 150);
		const { client, internals } = makeClient(canvas);
		for (const [w, h] of SIZES) {
			client.resize(w, h);
			canvas.ctx.clearCoverage();
			internals.onRender(0);
			expectFullyPainted(canvas.ctx, `frame after resize to ${w}x${h}`);
		}
		client.stop();
	});
});

// ---- sky layer coverage at camera extremes ----

describe('geodash sky covers all viewport rows', () => {
	const cameraYs = [-800, -110, -80, -5, 0, 60, 110, 800];

	for (const cameraY of cameraYs) {
		it(`sky bands cover rows 0..269 at camera y = ${cameraY}`, () => {
			const canvas = new FakeCanvas(480, 270);
			const { client, internals } = makeClient(canvas);
			client.resize(480, 270);
			// Isolate the sky layer: full clear first, then only drawSky.
			internals.pixel.clear('#000000');
			canvas.ctx.clearCoverage();
			internals.camera.setPosition(400, cameraY);
			internals.drawSky(0);
			const gaps = canvas.ctx.uncovered();
			expect(
				gaps.length,
				`sky at camera.y=${cameraY}: ${gaps.length} uncovered rows, first: ${JSON.stringify(
					gaps.slice(0, 8)
				)}`
			).toBe(0);
			client.stop();
		});
	}
});

// ---- form sprites + mode portals ----

/** Floor + ceiling with one portal per form, for sprite coverage. */
const FORMS_LEVEL: Record<string, unknown> = {
	id: 'forms',
	name: 'Forms',
	difficulty: 3,
	bpm: 140,
	lengthPx: 4000,
	objects: [
		{ type: 'block', x: 0, y: 0, w: 4000, h: 80 },
		{ type: 'block', x: 0, y: -240, w: 4000, h: 40 },
		{ type: 'spike', x: 800, y: -200, flip: true },
		{ type: 'portal', x: 1000, mode: 'ship' },
		{ type: 'saw', x: 1400, y: -168, r: 22, spin: -1 },
		{ type: 'portal', x: 2000, mode: 'ball' },
		{ type: 'pad', x: 2400, y: -8, power: 1.4 },
		{ type: 'speed', x: 2800, y: -140, mult: 1.3 },
		{ type: 'portal', x: 3200, mode: 'cube' }
	]
};

/** Same color math as render.ts shade() for exact sprite-paint assertions. */
function shade(hex: string, amount: number): string {
	const n = parseInt(hex.slice(1), 16);
	const clamp = (v: number) => Math.max(0, Math.min(255, v));
	const r = clamp((n >> 16) + amount);
	const g = clamp(((n >> 8) & 0xff) + amount);
	const b = clamp((n & 0xff) + amount);
	return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

describe('geodash form sprites and mode portals', () => {
	const color = PLAYERS[0].color;

	function frameAt(
		internals: ClientInternals,
		state: {
			mode: GeoDashMode;
			x: number;
			y: number;
			vy: number;
			keys: number;
			onGround?: boolean;
		},
		cam: { x: number; y: number }
	): { sx: number; sy: number; ops: Recording2D['fillOps'] } {
		const p = internals.sim.players[0];
		p.mode = state.mode;
		p.x = state.x;
		p.y = state.y;
		p.vy = state.vy;
		p.lastKeys = state.keys;
		p.onGround = state.onGround ?? false;
		internals.camera.setPosition(cam.x, cam.y);
		const rec = internals.pixel.canvas as unknown as FakeCanvas;
		rec.ctx.clearCoverage();
		internals.onRender(0);
		const { pixel } = internals;
		// camera.follow() runs inside onRender: use the post-frame camera to
		// compute where the player's center was drawn.
		const cx = internals.camera.x;
		const cy = internals.camera.y;
		const sx = Math.round((state.x + 15 - cx + 240) * pixel.scale + pixel.offsetX);
		const sy = Math.round((state.y + 15 - cy + 135) * pixel.scale + pixel.offsetY);
		return { sx, sy, ops: rec.ctx.fillOps };
	}

	function hits(ops: Recording2D['fillOps'], sx: number, sy: number, style: string): boolean {
		return ops.some((o) => o.style === style && o.x0 <= sx && sx < o.x1 && o.y0 <= sy && sy < o.y1);
	}

	it('draws the ship hull (flame only while thrusting) and covers the frame', () => {
		const canvas = new FakeCanvas(800, 600);
		const { client, internals } = makeClient(canvas, 'forms', FORMS_LEVEL);
		client.resize(800, 600);

		const thrust = frameAt(
			internals,
			{ mode: 'ship', x: 1300, y: -110, vy: -3, keys: KEY.JUMP },
			{ x: 1400, y: -60 }
		);
		expect(
			thrust.ops.some((o) => o.style === color),
			'hull in player color'
		).toBe(true);
		expect(
			thrust.ops.some((o) => o.style === '#ff8a3a'),
			'thrust flame while holding'
		).toBe(true);
		expectFullyPainted(canvas.ctx, 'ship frame');

		const glide = frameAt(
			internals,
			{ mode: 'ship', x: 1700, y: -80, vy: 4, keys: 0 },
			{ x: 1800, y: -60 }
		);
		expect(
			glide.ops.some((o) => o.style === '#ff8a3a'),
			'no flame without thrust'
		).toBe(false);
		expectFullyPainted(canvas.ctx, 'gliding ship frame');
		client.stop();
	});

	it('draws the rolling ball on floor and ceiling', () => {
		const canvas = new FakeCanvas(800, 600);
		const { client, internals } = makeClient(canvas, 'forms', FORMS_LEVEL);
		client.resize(800, 600);
		const spinColor = shade(color, -35);

		for (const [y, camY] of [
			[-30, 0],
			[-200, -100]
		] as [number, number][]) {
			const frame = frameAt(
				internals,
				{ mode: 'ball', x: 2200, y, vy: 0, keys: 0, onGround: true },
				{ x: 2300, y: camY }
			);
			expect(
				frame.ops.some((o) => o.style === spinColor),
				`ball spin marks at y=${y}`
			).toBe(true);
			expectFullyPainted(canvas.ctx, `ball frame at y=${y}`);
		}
		client.stop();
	});

	it('draws the cube sprite airborne', () => {
		const canvas = new FakeCanvas(800, 600);
		const { client, internals } = makeClient(canvas, 'forms', FORMS_LEVEL);
		client.resize(800, 600);
		const frame = frameAt(
			internals,
			{ mode: 'cube', x: 900, y: -150, vy: -5, keys: 0 },
			{ x: 1000, y: -60 }
		);
		expect(hits(frame.ops, frame.sx, frame.sy, color), 'cube body at player center').toBe(true);
		expectFullyPainted(canvas.ctx, 'cube frame');
		client.stop();
	});

	it('draws mode portals with per-form colors', () => {
		const canvas = new FakeCanvas(480, 270);
		const { client, internals } = makeClient(canvas, 'forms', FORMS_LEVEL);
		client.resize(480, 270);
		const gates: [number, string][] = [
			[1000, '#6ec6ff'], // ship
			[2000, '#ffd166'], // ball
			[3200, '#ffe14d'] // cube (palette portal for difficulty 3)
		];
		for (const [portalX, style] of gates) {
			internals.camera.setPosition(portalX, -80);
			canvas.ctx.clearCoverage();
			internals.onRender(0);
			// the gate's left rail sits at world x = portalX - 8, mid-height y = -80
			const cx = internals.camera.x;
			const cy = internals.camera.y;
			const sx = Math.round(
				(portalX - 7 - cx + 240) * internals.pixel.scale + internals.pixel.offsetX
			);
			const sy = Math.round((-80 - cy + 135) * internals.pixel.scale + internals.pixel.offsetY);
			expect(
				canvas.ctx.fillOps.some(
					(o) => o.style === style && o.x0 <= sx && sx < o.x1 && o.y0 <= sy && sy < o.y1
				),
				`gate rails for portal at ${portalX}`
			).toBe(true);
			expectFullyPainted(canvas.ctx, `portal frame at ${portalX}`);
		}
		client.stop();
	});

	it('renders the transform flash on portal entry', () => {
		const canvas = new FakeCanvas(800, 600);
		const { client, internals } = makeClient(canvas, 'forms', FORMS_LEVEL);
		client.resize(800, 600);
		internals.handleLocalEvent({ kind: 'transform', player: 'p1', mode: 'ship' });
		internals.camera.setPosition(1000, -80);
		internals.onRender(0);
		const veil = canvas.ctx.fillOps.filter((o) => o.style === '#6ec6ff');
		expect(veil.length, 'tinted veil drawn').toBeGreaterThan(0);
		expectFullyPainted(canvas.ctx, 'transform flash frame');
		client.stop();
	});
});

// ---- floor slabs stay painted at every camera x ----
// (user report: "the platform floor disappears sometimes"). Floor slabs are
// single blocks thousands of pixels wide; draw culling must keep them for the
// whole visible x range at any camera position/zoom and any canvas size. The
// recording backend below tracks only fills of the floor-slab color and is
// cheap enough to sweep every ~20 world px of every level.

/** Records transformed rects of ONE fill style; everything else is ignored. */
class FloorRecorder2D implements Canvas2DLike {
	fillStyle = '#000000';
	strokeStyle = '#000000';
	lineWidth = 1;
	imageSmoothingEnabled = false;
	globalAlpha = 1;

	/** Device-space rects painted in the watched style. */
	fills: { x0: number; y0: number; x1: number; y1: number }[] = [];

	private readonly watch: string;
	private matrix: Matrix = [1, 0, 0, 1, 0, 0];
	private stack: Matrix[] = [];

	constructor(watch: string) {
		this.watch = watch;
	}

	clearFills(): void {
		this.fills = [];
	}

	save(): void {
		this.stack.push([...this.matrix] as Matrix);
	}

	restore(): void {
		this.matrix = this.stack.pop() ?? this.matrix;
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.matrix = [a, b, c, d, e, f];
	}

	translate(x: number, y: number): void {
		this.concat([1, 0, 0, 1, x, y]);
	}

	scale(x: number, y: number): void {
		this.concat([x, 0, 0, y, 0, 0]);
	}

	rotate(angle: number): void {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		this.concat([c, s, -s, c, 0, 0]);
	}

	clearRect(): void {}

	fillRect(x: number, y: number, w: number, h: number): void {
		if (this.fillStyle !== this.watch) return;
		const [a, b, c, d, e, f] = this.matrix;
		const xs = [
			a * x + c * y + e,
			a * (x + w) + c * y + e,
			a * x + c * (y + h) + e,
			a * (x + w) + c * (y + h) + e
		];
		const ys = [
			b * x + d * y + f,
			b * (x + w) + d * y + f,
			b * x + d * (y + h) + f,
			b * (x + w) + d * (y + h) + f
		];
		this.fills.push({
			x0: Math.min(...xs),
			y0: Math.min(...ys),
			x1: Math.max(...xs),
			y1: Math.max(...ys)
		});
	}

	strokeRect(): void {}
	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	arc(): void {}
	fill(): void {}
	stroke(): void {}
	drawImage(): void {}

	private concat(m: Matrix): void {
		const [a, b, c, d, e, f] = this.matrix;
		const [na, nb, nc, nd, ne, nf] = m;
		this.matrix = [
			a * na + c * nb,
			b * na + d * nb,
			a * nc + c * nd,
			b * nc + d * nd,
			a * ne + c * nf + e,
			b * ne + d * nf + f
		];
	}
}

class FloorCanvas implements CanvasSourceLike {
	readonly ctx: FloorRecorder2D;
	width: number;
	height: number;

	constructor(width: number, height: number, watch: string) {
		this.width = width;
		this.height = height;
		this.ctx = new FloorRecorder2D(watch);
	}

	getContext(type: '2d'): Canvas2DLike | null {
		return type === '2d' ? this.ctx : null;
	}
}

/** Every floor block (ground slab) in the level, as rects. */
function floorBlocks(level: GeoDashLevel): { x: number; y: number; w: number; h: number }[] {
	const out: { x: number; y: number; w: number; h: number }[] = [];
	for (const obj of level.objects) {
		if (obj.type === 'block' && obj.y >= 0) out.push({ x: obj.x, y: obj.y, ...blockSize(obj) });
	}
	return out;
}

/**
 * Every floor tile visible in the frame must be painted with the slab fill.
 * Visibility is judged against the internal viewport rect (letterbox offsets
 * included) using the POST-follow camera the frame was actually drawn with.
 * Returns how many tiles were checked (callers guard against vacuous frames).
 */
function expectFloorTiles(
	rec: FloorRecorder2D,
	internals: ClientInternals,
	level: GeoDashLevel,
	at: string
): number {
	const pixel = internals.pixel;
	const cam = internals.camera;
	const zoom = cam.zoom * pixel.scale;
	const viewLeft = pixel.offsetX;
	const viewTop = pixel.offsetY;
	const viewRight = pixel.offsetX + 480 * pixel.scale;
	const viewBottom = pixel.offsetY + 270 * pixel.scale;
	const floors = floorBlocks(level);
	// Sample the whole visible x range (zoom-aware) densely, every 20px.
	const reach = Math.ceil(280 / cam.zoom);
	let checked = 0;
	for (let wx = Math.floor(cam.x - reach); wx <= cam.x + reach; wx += 20) {
		const slab = floors.find((b) => wx >= b.x && wx < b.x + b.w);
		if (!slab) continue; // a pit: intentionally no floor here
		const wy = slab.y + Math.min(20, slab.h / 2);
		const sx = (wx - cam.x) * zoom + 240 * pixel.scale + pixel.offsetX;
		const sy = (wy - cam.y) * zoom + 135 * pixel.scale + pixel.offsetY;
		if (sx < viewLeft || sx >= viewRight || sy < viewTop || sy >= viewBottom) continue;
		checked++;
		// The fill rect and the probe point are computed through different
		// float paths; allow a hair of rounding at the edges.
		const eps = 0.01;
		const painted = rec.fills.some(
			(f) => f.x0 - eps <= sx && sx < f.x1 + eps && f.y0 - eps <= sy && sy < f.y1 + eps
		);
		expect(
			painted,
			`${at}: floor tile at world x=${wx} not painted (screen ${sx.toFixed(1)},${sy.toFixed(1)})`
		).toBe(true);
	}
	return checked;
}

const FLOOR_SIZES: [number, number][] = [
	[480, 270],
	[960, 540],
	[200, 120],
	[320, 900]
];

const FLOOR_CAMERA_YS = [0, -110, 65];

describe('geodash floor slabs paint every visible tile at every camera x', () => {
	for (const level of LEVELS) {
		for (const [w, h] of FLOOR_SIZES) {
			it(`${level.id} "${level.name}" at ${w}x${h}`, () => {
				const ground = paletteForDifficulty(level.difficulty).ground;
				const canvas = new FloorCanvas(w, h, ground);
				const { client, internals } = makeClient(canvas, level.id);
				client.resize(w, h);
				let sample = 0;
				let checked = 0;
				for (let cx = -300; cx <= level.lengthPx + 300; cx += 20) {
					const camY = FLOOR_CAMERA_YS[sample++ % FLOOR_CAMERA_YS.length];
					internals.camera.setPosition(cx, camY);
					canvas.ctx.clearFills();
					internals.onRender(0);
					checked += expectFloorTiles(
						canvas.ctx,
						internals,
						level,
						`${level.id} @${w}x${h} camera(${cx},${camY})`
					);
				}
				expect(checked, `${level.id} @${w}x${h}: sweep was vacuous`).toBeGreaterThan(20);
				client.stop();
			});
		}
	}

	it('the floor stays painted through zoom-out and zoom-in', () => {
		const level = LEVELS[2];
		const ground = paletteForDifficulty(level.difficulty).ground;
		const canvas = new FloorCanvas(800, 600, ground);
		const { client, internals } = makeClient(canvas, level.id);
		client.resize(800, 600);
		let checked = 0;
		for (const zoom of [0.5, 0.75, 1, 1.4]) {
			internals.camera.zoom = zoom;
			for (let cx = -400; cx <= level.lengthPx + 400; cx += 60) {
				internals.camera.setPosition(cx, 0);
				canvas.ctx.clearFills();
				internals.onRender(0);
				checked += expectFloorTiles(
					canvas.ctx,
					internals,
					level,
					`${level.id} zoom ${zoom} @${cx}`
				);
			}
		}
		expect(checked, `${level.id} zoom sweep was vacuous`).toBeGreaterThan(20);
		client.stop();
	});
});
