/**
 * Procedural pixel avatar renderer. Pure + deterministic: an AvatarConfig maps to
 * a 16x16 pixel grid of palette keys, so avatars render identically on canvas,
 * in tests, or (later) in sprite atlases.
 */

export interface AvatarConfig {
	version: 1;
	seed: number;
	skin: string;
	hair: string;
	eyes: string;
	outfit: string;
	bg: string;
	style: 'square' | 'round' | 'visor' | 'ghost';
	hairStyle: 'spiky' | 'bob' | 'cap' | 'bald' | 'ponytail';
}

export const AVATAR_SIZE = 16;

/** Palette keys used in the pixel grid. */
export type PixelKey = '.' | 'S' | 's' | 'H' | 'h' | 'E' | 'W' | 'O' | 'o' | 'X';

export function avatarPalette(config: AvatarConfig): Record<PixelKey, string> {
	const robot = config.style === 'visor';
	return {
		'.': config.bg,
		S: robot ? '#c8d2e8' : config.skin,
		s: robot ? '#8b97b5' : shade(config.skin, -28),
		H: config.hair,
		h: shade(config.hair, -30),
		E: config.eyes,
		W: '#ffffff',
		O: config.outfit,
		o: shade(config.outfit, -30),
		X: '#1a1c2c'
	};
}

function shade(hex: string, amount: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const clamp = (v: number) => Math.max(0, Math.min(255, v));
	const r = clamp(((n >> 16) & 255) + amount);
	const g = clamp(((n >> 8) & 255) + amount);
	const b = clamp((n & 255) + amount);
	return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

const EMPTY_ROW = '................';

/** Build the 16x16 avatar grid. Row 0 is the top. */
export function avatarPixels(config: AvatarConfig): string[] {
	const grid: string[] = Array.from({ length: AVATAR_SIZE }, () => EMPTY_ROW);
	const set = (x: number, y: number, key: PixelKey) => {
		if (x < 0 || x > 15 || y < 0 || y > 15) return;
		const row = grid[y];
		grid[y] = row.slice(0, x) + key + row.slice(x + 1);
	};
	const fill = (x0: number, y0: number, x1: number, y1: number, key: PixelKey) => {
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, key);
	};

	// ---- head base shape ----
	const { style } = config;
	if (style === 'ghost') {
		fill(3, 2, 12, 11, 'S');
		// wavy bottom
		for (let x = 3; x <= 12; x++) set(x, 12, (x - 3) % 2 === 0 ? 'S' : '.');
		// outline sides
		for (let y = 2; y <= 11; y++) {
			set(3, y, 's');
			set(12, y, 's');
		}
	} else {
		fill(3, 2, 12, 12, 'S');
		for (let y = 2; y <= 12; y++) {
			set(3, y, 's');
			set(12, y, 's');
		}
		set(3, 2, style === 'round' ? 's' : 'S');
		set(12, 2, style === 'round' ? 's' : 'S');
		if (style === 'round') {
			set(3, 12, 's');
			set(12, 12, 's');
		}
	}

	// ---- hair ----
	switch (config.hairStyle) {
		case 'spiky':
			fill(3, 1, 12, 1, 'H');
			for (let x = 3; x <= 12; x += 2) set(x, 0, 'H');
			fill(3, 2, 12, 2, 'H');
			set(3, 3, 'h');
			set(12, 3, 'h');
			break;
		case 'bob':
			fill(2, 0, 13, 1, 'H');
			fill(3, 2, 12, 2, 'H');
			fill(2, 3, 3, 8, 'H');
			fill(12, 3, 13, 8, 'H');
			set(2, 8, 'h');
			set(13, 8, 'h');
			break;
		case 'cap':
			fill(3, 0, 12, 1, 'H');
			fill(2, 2, 13, 2, 'H');
			fill(4, 1, 11, 1, 'h');
			break;
		case 'ponytail':
			fill(2, 0, 13, 1, 'H');
			fill(3, 2, 12, 2, 'H');
			fill(13, 3, 14, 7, 'H');
			set(14, 8, 'h');
			set(13, 7, 'h');
			break;
		case 'bald':
			break;
	}

	// ---- eyes ----
	if (style === 'visor') {
		fill(4, 6, 11, 7, 'X');
		fill(4, 6, 5, 6, 'E');
		fill(10, 6, 11, 6, 'E');
	} else if (style === 'ghost') {
		fill(5, 6, 6, 7, 'X');
		fill(9, 6, 10, 7, 'X');
		set(5, 6, 'W');
		set(9, 6, 'W');
	} else {
		set(5, 7, 'W');
		set(6, 7, 'W');
		set(9, 7, 'W');
		set(10, 7, 'W');
		set(5, 8, 'E');
		set(6, 8, 'E');
		set(9, 8, 'E');
		set(10, 8, 'E');
	}

	// ---- mouth ----
	if (style !== 'ghost' && style !== 'visor') {
		set(7, 10, 's');
		set(8, 10, 's');
	}

	// ---- outfit / shoulders ----
	if (style !== 'ghost') {
		fill(2, 13, 13, 15, 'O');
		fill(2, 13, 2, 15, 'o');
		fill(13, 13, 13, 15, 'o');
		fill(7, 13, 8, 15, 'o');
	}

	return grid;
}

const SKIN_TONES = ['#f2d0b6', '#e0b089', '#c98d61', '#9c6b45', '#7a5236', '#d7a58a'];
const HAIR_COLORS = [
	'#2b2b3d',
	'#5b3a29',
	'#a8642a',
	'#e8c56b',
	'#d94f4f',
	'#5c6bc0',
	'#3fa66a',
	'#b06bff',
	'#e8e8f0'
];
const EYE_COLORS = ['#2b6cff', '#3fa66a', '#8b4513', '#7a5cff', '#2b2b3d', '#d94f4f'];
const OUTFIT_COLORS = [
	'#ff5c7a',
	'#57e389',
	'#ffd166',
	'#6ec6ff',
	'#b06bff',
	'#ff9f43',
	'#2de2e6',
	'#e8e8f0'
];
const BG_COLORS = ['#262647', '#3b2f4a', '#1f3b4a', '#3a2f2f', '#2c3d2f', '#41335c'];
const STYLES: AvatarConfig['style'][] = ['square', 'round', 'visor', 'ghost'];
const HAIR_STYLES: AvatarConfig['hairStyle'][] = [
	'spiky',
	'bob',
	'cap',
	'bald',
	'ponytail'
];

/** Deterministic pseudo-random from an integer seed (mulberry32). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function randomAvatar(seed = Math.floor(Math.random() * 2 ** 31)): AvatarConfig {
	const rnd = mulberry32(seed);
	const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
	return {
		version: 1,
		seed,
		skin: pick(SKIN_TONES),
		hair: pick(HAIR_COLORS),
		eyes: pick(EYE_COLORS),
		outfit: pick(OUTFIT_COLORS),
		bg: pick(BG_COLORS),
		style: pick(STYLES),
		hairStyle: pick(HAIR_STYLES)
	};
}

/** Paint the avatar grid onto a canvas context at the given scale/offset. */
export function drawAvatar(
	ctx: CanvasRenderingContext2D,
	config: AvatarConfig,
	x: number,
	y: number,
	scale: number
): void {
	const palette = avatarPalette(config);
	const grid = avatarPixels(config);
	for (let py = 0; py < AVATAR_SIZE; py++) {
		const row = grid[py];
		for (let px = 0; px < AVATAR_SIZE; px++) {
			const key = row[px] as PixelKey;
			const color = palette[key];
			if (key === '.') {
				ctx.fillStyle = color;
				ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
			} else {
				ctx.fillStyle = color;
				ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
			}
		}
	}
}
