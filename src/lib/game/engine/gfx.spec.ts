/**
 * PixelCanvas coverage/resize repro tests (user report: "sometimes we don't
 * see the bg"). A recording fake `Canvas2DLike` tracks every painted backing-
 * store pixel; each frame must paint EVERY pixel of the backing store — the
 * letterbox bars included — at any canvas size, and `resize()` must never
 * leave a stale or NaN backing store behind.
 */
import { describe, expect, it } from 'vitest';
import { PixelCanvas, type Canvas2DLike, type CanvasSourceLike } from './gfx';

// ---- recording fake draw backend ----

type Matrix = [number, number, number, number, number, number];

/**
 * Records which backing-store pixels are solidly painted (fillRect with
 * globalAlpha > 0.5; clearRect un-paints). Transformed rects are rasterized
 * by their transformed AABB, which only ever over-reports coverage — the
 * assertions below hunt for *gaps*, so that bias is the safe direction.
 */
export class Recording2D implements Canvas2DLike {
	fillStyle = '#000000';
	strokeStyle = '#000000';
	lineWidth = 1;
	imageSmoothingEnabled = false;
	globalAlpha = 1;

	private matrix: Matrix = [1, 0, 0, 1, 0, 0];
	private stack: Matrix[] = [];
	private painted!: Uint8Array;

	width = 0;
	height = 0;

	resetBacking(width: number, height: number): void {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
		this.painted = new Uint8Array(this.width * this.height);
		this.matrix = [1, 0, 0, 1, 0, 0];
		this.stack = [];
		this.globalAlpha = 1;
	}

	/** Forget coverage information (keep the backing store). */
	clearCoverage(): void {
		this.painted.fill(0);
	}

	paintedCount(): number {
		let n = 0;
		for (const v of this.painted) if (v !== 0) n++;
		return n;
	}

	isPainted(x: number, y: number): boolean {
		return this.painted[y * this.width + x] !== 0;
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
		if (this.globalAlpha > 0.5) this.mark(x, y, w, h, 1);
	}

	strokeRect(): void {
		/* outlines are not coverage */
	}

	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	arc(): void {}

	fill(): void {
		/* path fills are approximated as non-coverage (safe under-report) */
	}

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

	private mark(x: number, y: number, w: number, h: number, value: 0 | 1): void {
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
	}
}

/** Canvas element fake: setting width/height resets + clears the backing store. */
export class FakeCanvas implements CanvasSourceLike {
	readonly ctx: Recording2D = new Recording2D();
	private w: number;
	private h: number;

	constructor(width = 300, height = 150) {
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

const SIZES: [number, number][] = [
	[960, 540], // 16:9 exact multiple
	[800, 600], // 4:3 letterboxed
	[320, 900], // tall + narrow
	[200, 120], // tiny (smaller than the internal viewport)
	[480, 270], // 1:1 internal size
	[1366, 768] // odd 16:9-ish, leaves slivers
];

function expectFullyPainted(rec: Recording2D, what: string): void {
	const gaps = rec.uncovered();
	expect(
		gaps.length,
		`${what}: ${gaps.length} unpainted px, first: ${JSON.stringify(gaps.slice(0, 8))}`
	).toBe(0);
}

// ---- the repro: clear() must paint the WHOLE backing store ----

describe('PixelCanvas.clear paints the entire backing store', () => {
	for (const [w, h] of SIZES) {
		it(`covers every pixel at ${w}x${h} (letterbox bars included)`, () => {
			const canvas = new FakeCanvas(w, h);
			const pixel = new PixelCanvas(canvas);
			pixel.resize(w, h);
			pixel.clear('#123456');
			expect(canvas.ctx.width).toBe(w);
			expect(canvas.ctx.height).toBe(h);
			expectFullyPainted(canvas.ctx, `clear at ${w}x${h}`);
		});
	}

	it('covers every pixel again after an arbitrary resize sequence', () => {
		const canvas = new FakeCanvas(640, 480);
		const pixel = new PixelCanvas(canvas);
		for (const [w, h] of SIZES) {
			pixel.resize(w, h);
			pixel.clear('#123456');
			expectFullyPainted(canvas.ctx, `clear after resize to ${w}x${h}`);
		}
	});

	it('covers every pixel even when resize was never called', () => {
		// The container may not have laid out yet when the first frame draws:
		// PixelCanvas must derive scale/offsets from the backing store itself.
		const canvas = new FakeCanvas(900, 700);
		const pixel = new PixelCanvas(canvas);
		pixel.clear('#123456');
		expectFullyPainted(canvas.ctx, 'clear without resize');
		expect(pixel.scale).toBeGreaterThanOrEqual(1);
		expect(Number.isInteger(pixel.offsetX)).toBe(true);
		expect(Number.isInteger(pixel.offsetY)).toBe(true);
	});
});

describe('PixelCanvas.resize guards and consistency', () => {
	it('never produces NaN/invalid scale or offsets for 0/NaN/negative input', () => {
		const canvas = new FakeCanvas(800, 600);
		const pixel = new PixelCanvas(canvas);
		pixel.resize(800, 600);

		// Each axis falls back to the last good value independently.
		const cases: { input: [number, number]; backing: [number, number] }[] = [
			{ input: [0, 0], backing: [800, 600] },
			{ input: [NaN, NaN], backing: [800, 600] },
			{ input: [-100, 50], backing: [800, 50] },
			{ input: [Infinity, 2], backing: [800, 2] },
			{ input: [NaN, 400], backing: [800, 400] }
		];
		for (const { input, backing } of cases) {
			const [w, h] = input;
			pixel.resize(w, h);
			expect(Number.isFinite(pixel.scale), `scale after resize(${w}, ${h})`).toBe(true);
			expect(Number.isFinite(pixel.offsetX), `offsetX after resize(${w}, ${h})`).toBe(true);
			expect(Number.isFinite(pixel.offsetY), `offsetY after resize(${w}, ${h})`).toBe(true);
			expect(pixel.scale).toBeGreaterThanOrEqual(1);
			expect([canvas.width, canvas.height], `backing after resize(${w}, ${h})`).toEqual(backing);
			pixel.clear('#112233');
			expectFullyPainted(canvas.ctx, `clear after resize(${w}, ${h})`);
		}
	});

	it('keeps canvas backing store and derived scale/offsets consistent', () => {
		const canvas = new FakeCanvas(300, 150);
		const pixel = new PixelCanvas(canvas);
		for (const [w, h] of [...SIZES, [3, 3] as [number, number], [5000, 120] as [number, number]]) {
			pixel.resize(w, h);
			const { scale, offsetX, offsetY } = pixel;
			expect(scale).toBeGreaterThanOrEqual(1);
			expect(offsetX).toBe(Math.floor((canvas.width - pixel.width * scale) / 2));
			expect(offsetY).toBe(Math.floor((canvas.height - pixel.height * scale) / 2));
			pixel.clear('#abcdef');
			expectFullyPainted(canvas.ctx, `consistency at ${w}x${h}`);
		}
	});

	it('scales the backing store by an explicit devicePixelRatio', () => {
		const canvas = new FakeCanvas(300, 150);
		const pixel = new PixelCanvas(canvas);
		pixel.resize(800, 600, 2);
		expect(canvas.width).toBe(1600);
		expect(canvas.height).toBe(1200);
		expect(pixel.scale).toBe(Math.floor(Math.min(1600 / pixel.width, 1200 / pixel.height)));
		pixel.clear('#101010');
		expectFullyPainted(canvas.ctx, 'clear at dpr 2');

		// Garbage dpr falls back to 1.
		pixel.resize(800, 600, 0);
		expect(canvas.width).toBe(800);
		expect(canvas.height).toBe(600);
		pixel.clear('#101010');
		expectFullyPainted(canvas.ctx, 'clear at dpr 0 -> 1');
	});
});

describe('PixelCanvas.begin transform', () => {
	it('maps internal (0,0) to the letterbox offset and leaves the store painted', () => {
		const canvas = new FakeCanvas(800, 600);
		const pixel = new PixelCanvas(canvas);
		pixel.resize(800, 600);
		pixel.clear('#202020');
		canvas.ctx.clearCoverage();
		pixel.begin();
		pixel.fillRect(0, 0, 1, 1, '#ffffff');
		expect(canvas.ctx.isPainted(pixel.offsetX, pixel.offsetY)).toBe(true);
		expect(canvas.ctx.paintedCount()).toBe(1);
	});
});
