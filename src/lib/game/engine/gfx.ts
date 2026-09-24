/**
 * Pixel-art drawing. `PixelCanvas` renders into a small fixed internal
 * resolution (default 480x270) and scales it to the canvas backing store with
 * integer scaling + letterboxing. Text uses a built-in 5x7 bitmap font: no DOM
 * font rendering, so it looks identical everywhere.
 *
 * Drawing backends are injectable (`Canvas2DLike`) for node tests.
 */

/** The subset of CanvasRenderingContext2D the engine draws with. */
export interface Canvas2DLike {
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	imageSmoothingEnabled: boolean;
	globalAlpha: number;
	save(): void;
	restore(): void;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	translate(x: number, y: number): void;
	scale(x: number, y: number): void;
	rotate(angle: number): void;
	clearRect(x: number, y: number, w: number, h: number): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	strokeRect(x: number, y: number, w: number, h: number): void;
	beginPath(): void;
	closePath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	arc(x: number, y: number, r: number, start: number, end: number): void;
	fill(): void;
	stroke(): void;
	drawImage(image: object, ...args: number[]): void;
}

/** Anything we can blit as a sprite (image, canvas, bitmap...). */
export type SpriteSource = object;

/** A canvas element we can size and get a 2D context from. */
export interface CanvasSourceLike {
	width: number;
	height: number;
	getContext(type: '2d'): Canvas2DLike | null;
}

export const FONT_WIDTH = 5;
export const FONT_HEIGHT = 7;
const GLYPH_ADVANCE = FONT_WIDTH + 1;

/**
 * Built-in 5x7 bitmap font. Each glyph is 7 rows of 5 cells separated by '/',
 * '1' = pixel on. Covers A-Z, 0-9 and `. , : ! ? ' - + / % ( ) < >` + space.
 */
const FONT: Record<string, string> = {
	A: '01110/10001/10001/11111/10001/10001/10001',
	B: '11110/10001/10001/11110/10001/10001/11110',
	C: '01110/10001/10000/10000/10000/10001/01110',
	D: '11110/10001/10001/10001/10001/10001/11110',
	E: '11111/10000/10000/11110/10000/10000/11111',
	F: '11111/10000/10000/11110/10000/10000/10000',
	G: '01110/10001/10000/10111/10001/10001/01111',
	H: '10001/10001/10001/11111/10001/10001/10001',
	I: '01110/00100/00100/00100/00100/00100/01110',
	J: '00111/00010/00010/00010/00010/10010/01100',
	K: '10001/10010/10100/11000/10100/10010/10001',
	L: '10000/10000/10000/10000/10000/10000/11111',
	M: '10001/11011/10101/10101/10001/10001/10001',
	N: '10001/11001/10101/10011/10001/10001/10001',
	O: '01110/10001/10001/10001/10001/10001/01110',
	P: '11110/10001/10001/11110/10000/10000/10000',
	Q: '01110/10001/10001/10001/10101/10010/01101',
	R: '11110/10001/10001/11110/10100/10010/10001',
	S: '01111/10000/10000/01110/00001/00001/11110',
	T: '11111/00100/00100/00100/00100/00100/00100',
	U: '10001/10001/10001/10001/10001/10001/01110',
	V: '10001/10001/10001/10001/10001/01010/00100',
	W: '10001/10001/10001/10101/10101/11011/10001',
	X: '10001/10001/01010/00100/01010/10001/10001',
	Y: '10001/10001/01010/00100/00100/00100/00100',
	Z: '11111/00001/00010/00100/01000/10000/11111',
	'0': '01110/10001/10011/10101/11001/10001/01110',
	'1': '00100/01100/00100/00100/00100/00100/01110',
	'2': '01110/10001/00001/00010/00100/01000/11111',
	'3': '11111/00010/00100/00010/00001/10001/01110',
	'4': '00010/00110/01010/10010/11111/00010/00010',
	'5': '11111/10000/11110/00001/00001/10001/01110',
	'6': '00110/01000/10000/11110/10001/10001/01110',
	'7': '11111/00001/00010/00100/01000/01000/01000',
	'8': '01110/10001/10001/01110/10001/10001/01110',
	'9': '01110/10001/10001/01111/00001/00010/01100',
	'.': '00000/00000/00000/00000/00000/01100/01100',
	',': '00000/00000/00000/00000/00110/00110/01100',
	':': '00000/01100/01100/00000/01100/01100/00000',
	'!': '00100/00100/00100/00100/00100/00000/00100',
	'?': '01110/10001/00001/00010/00100/00000/00100',
	"'": '00100/00100/01000/00000/00000/00000/00000',
	'-': '00000/00000/00000/11111/00000/00000/00000',
	'+': '00000/00100/00100/11111/00100/00100/00000',
	'/': '00001/00010/00010/00100/01000/01000/10000',
	'%': '11001/11010/00010/00100/01000/01011/10011',
	'(': '00010/00100/01000/01000/01000/00100/00010',
	')': '01000/00100/00010/00010/00010/00100/01000',
	'<': '00010/00100/01000/10000/01000/00100/00010',
	'>': '01000/00100/00010/00001/00010/00100/01000',
	' ': '00000/00000/00000/00000/00000/00000/00000'
};

/** Pre-split glyph rows; unknown characters render as blanks. */
const GLYPHS: Record<string, string[]> = {};
for (const ch of Object.keys(FONT)) {
	GLYPHS[ch] = FONT[ch].split('/');
}
const BLANK_GLYPH = GLYPHS[' '];

/** Width in internal pixels of `text` drawn at `scale`. */
export function measureText(text: string, scale = 1): number {
	if (text.length === 0) return 0;
	return text.length * GLYPH_ADVANCE * scale - scale;
}

export interface PixelCanvasOptions {
	/** Fixed internal resolution (default 480x270). */
	width?: number;
	height?: number;
}

export class PixelCanvas {
	readonly canvas: CanvasSourceLike;
	readonly ctx: Canvas2DLike;
	readonly width: number;
	readonly height: number;

	/** Integer scale factor and letterbox offsets applied to every draw. */
	scale = 1;
	offsetX = 0;
	offsetY = 0;

	constructor(canvas: CanvasSourceLike, options: PixelCanvasOptions = {}) {
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('PixelCanvas: 2d context unavailable');
		this.canvas = canvas;
		this.ctx = ctx;
		this.width = options.width ?? 480;
		this.height = options.height ?? 270;
	}

	/**
	 * Fit the fixed internal resolution into `cssWidth x cssHeight` using the
	 * largest integer scale that fits, centered with letterboxing. The caller
	 * owns CSS sizing; pass device-pixel-ratio-adjusted sizes if desired.
	 */
	resize(cssWidth: number, cssHeight: number): void {
		const w = Math.max(1, Math.round(cssWidth));
		const h = Math.max(1, Math.round(cssHeight));
		this.canvas.width = w;
		this.canvas.height = h;
		this.scale = Math.max(1, Math.floor(Math.min(w / this.width, h / this.height)));
		this.offsetX = Math.floor((w - this.width * this.scale) / 2);
		this.offsetY = Math.floor((h - this.height * this.scale) / 2);
	}

	/** Reset the transform so draws land in internal resolution coordinates. */
	begin(): void {
		this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
		this.ctx.imageSmoothingEnabled = false;
	}

	/** Clear the whole backing store (letterbox included) and begin drawing. */
	clear(color?: string): void {
		this.ctx.setTransform(1, 0, 0, 1, 0, 0);
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.begin();
		if (color !== undefined) {
			this.ctx.fillStyle = color;
			this.ctx.fillRect(0, 0, this.width, this.height);
		}
	}

	/** Stroked rectangle outline. */
	rect(x: number, y: number, w: number, h: number, color: string, width = 1): void {
		this.ctx.strokeStyle = color;
		this.ctx.lineWidth = width;
		this.ctx.strokeRect(x, y, w, h);
	}

	fillRect(x: number, y: number, w: number, h: number, color: string): void {
		this.ctx.fillStyle = color;
		this.ctx.fillRect(x, y, w, h);
	}

	circle(x: number, y: number, r: number, color: string, filled = true): void {
		this.ctx.beginPath();
		this.ctx.arc(x, y, r, 0, Math.PI * 2);
		if (filled) {
			this.ctx.fillStyle = color;
			this.ctx.fill();
		} else {
			this.ctx.strokeStyle = color;
			this.ctx.lineWidth = 1;
			this.ctx.stroke();
		}
	}

	line(x1: number, y1: number, x2: number, y2: number, color: string, width = 1): void {
		this.ctx.strokeStyle = color;
		this.ctx.lineWidth = width;
		this.ctx.beginPath();
		this.ctx.moveTo(x1, y1);
		this.ctx.lineTo(x2, y2);
		this.ctx.stroke();
	}

	/**
	 * Blit a sprite region (or the whole image when sh/sw are omitted).
	 * `flipX` mirrors horizontally around the destination center.
	 */
	sprite(
		img: SpriteSource,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw = sw,
		dh = sh,
		flipX = false
	): void {
		if (!flipX) {
			this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
			return;
		}
		this.ctx.save();
		this.ctx.translate(dx + dw, dy);
		this.ctx.scale(-1, 1);
		this.ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
		this.ctx.restore();
	}

	/** Draw a string with the built-in 5x7 font. Lowercase maps to uppercase. */
	text(str: string, x: number, y: number, color: string, scale = 1): void {
		const s = Math.max(1, Math.round(scale));
		this.ctx.fillStyle = color;
		let penX = x;
		const upper = str.toUpperCase();
		for (let i = 0; i < upper.length; i++) {
			const glyph = GLYPHS[upper[i]] ?? BLANK_GLYPH;
			for (let row = 0; row < FONT_HEIGHT; row++) {
				const cells = glyph[row];
				for (let col = 0; col < FONT_WIDTH; col++) {
					if (cells[col] === '1') {
						this.ctx.fillRect(penX + col * s, y + row * s, s, s);
					}
				}
			}
			penX += GLYPH_ADVANCE * s;
		}
	}

	/** Width in internal pixels of `str` drawn at `scale`. */
	textWidth(str: string, scale = 1): number {
		return measureText(str, scale);
	}
}
