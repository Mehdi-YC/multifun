/**
 * Pixel Tanks arenas. Arenas are compact string maps (rows of chars) parsed
 * into a tile grid of `TILE_SIZE`-pixel tiles (30x17 tiles = 480x272 world px,
 * the whole arena fits the 480x270 canvas). Char legend:
 *
 *   `#` wall  — solid steel; bullets bounce once off it
 *   `C` crate — destructible (2 hits); blocks tanks and bullets
 *   `~` water — blocks tanks; bullets fly over it
 *   `B` bush  — decorative cover; tanks drive over it (drawn on top)
 *   `.` floor — open ground
 *
 * Maps are horizontally mirrored while authored (rows describe the left half
 * plus the mirrored right half), which is why every arena plays symmetrically.
 * Each arena carries 8 spawn points as [col, row] tile coordinates.
 */

export const TILE_SIZE = 16;

export type TileType = 'wall' | 'crate' | 'water' | 'bush' | 'floor';

export const TILE_CHARS: Record<string, TileType> = {
	'#': 'wall',
	C: 'crate',
	'~': 'water',
	B: 'bush',
	'.': 'floor'
};

/** A point in world pixels. */
export interface ArenaPoint {
	x: number;
	y: number;
}

export interface Arena {
	id: string;
	name: string;
	cols: number;
	rows: number;
	/** Row-major tile grid, `cols * rows` entries. */
	tiles: TileType[];
	/** Spawn points in world pixels (tile centers). */
	spawns: ArenaPoint[];
}

/** Compact source form of an arena, as authored. */
export interface ArenaMap {
	id: string;
	name: string;
	/** `rows.length` rows of `cols` chars each, see TILE_CHARS. */
	rows: string[];
	/** Spawn points as [col, row] tile coordinates. */
	spawns: [number, number][];
}

/** Tanks collide with walls, crates and water. */
export function isTankSolid(tile: TileType): boolean {
	return tile === 'wall' || tile === 'crate' || tile === 'water';
}

/** Bullets collide with walls and crates; they fly over water and bushes. */
export function isBulletSolid(tile: TileType): boolean {
	return tile === 'wall' || tile === 'crate';
}

/** Tile at grid coords; out of bounds reads as `wall` (the world is sealed). */
export function tileAt(arena: Arena, col: number, row: number): TileType {
	if (col < 0 || row < 0 || col >= arena.cols || row >= arena.rows) return 'wall';
	return arena.tiles[row * arena.cols + col];
}

/** Tile under a world pixel position. */
export function tileAtPx(arena: Arena, x: number, y: number): TileType {
	return tileAt(arena, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
}

/** Center of the tile at [col, row], in world pixels. */
export function tileCenter(col: number, row: number): ArenaPoint {
	return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

/**
 * Parse and validate a compact map definition. Throws with a descriptive
 * message on malformed rows, unknown tile chars or bad spawn points.
 */
export function parseArena(map: ArenaMap): Arena {
	if (typeof map.id !== 'string' || map.id.length === 0) {
		throw new Error('arena: id must be a non-empty string');
	}
	if (!Array.isArray(map.rows) || map.rows.length < 3) {
		throw new Error(`arena ${map.id}: needs at least 3 rows`);
	}
	const cols = map.rows[0].length;
	if (cols < 3 || cols > 64 || map.rows.length > 64) {
		throw new Error(`arena ${map.id}: dimensions out of range (3..64 tiles per axis)`);
	}
	const tiles: TileType[] = [];
	for (let row = 0; row < map.rows.length; row++) {
		const line = map.rows[row];
		if (line.length !== cols) {
			throw new Error(`arena ${map.id}: row ${row} has width ${line.length}, expected ${cols}`);
		}
		for (let col = 0; col < cols; col++) {
			const tile = TILE_CHARS[line[col]];
			if (tile === undefined) {
				throw new Error(`arena ${map.id}: unknown tile char '${line[col]}' at [${col}, ${row}]`);
			}
			tiles.push(tile);
		}
	}
	if (!Array.isArray(map.spawns) || map.spawns.length === 0) {
		throw new Error(`arena ${map.id}: needs at least one spawn point`);
	}
	const spawns: ArenaPoint[] = [];
	const rows = map.rows.length;
	for (let i = 0; i < map.spawns.length; i++) {
		const [col, row] = map.spawns[i];
		if (
			!Number.isInteger(col) ||
			!Number.isInteger(row) ||
			col < 0 ||
			row < 0 ||
			col >= cols ||
			row >= rows
		) {
			throw new Error(`arena ${map.id}: spawn ${i} [${col}, ${row}] is out of bounds`);
		}
		const tile = tiles[row * cols + col];
		if (isTankSolid(tile)) {
			throw new Error(`arena ${map.id}: spawn ${i} [${col}, ${row}] sits on solid tile '${tile}'`);
		}
		spawns.push(tileCenter(col, row));
	}
	return { id: map.id, name: map.name, cols, rows, tiles, spawns };
}

// ---- shipped maps (authored as left halves, mirrored right) ----

/**
 * Mirror a left-half map horizontally, then mirror the rows vertically:
 * 9 half rows become 17 full rows with the bottom border intact.
 */
function mirrored(half: string[]): string[] {
	const rows = half.map((line) => line + line.split('').reverse().join(''));
	return rows.concat(rows.slice(0, -1).reverse());
}

/** crossfire — symmetric lanes, steel bars and crate clusters in each quadrant. */
const CROSSFIRE: ArenaMap = {
	id: 'crossfire',
	name: 'Crossfire',
	rows: mirrored([
		'###############',
		'#..............',
		'#...CC.........',
		'#..............',
		'#..C....##.....',
		'#......####....',
		'#..C....##.....',
		'#..............',
		'#....C.....C...'
	]),
	spawns: [
		[2, 2],
		[27, 2],
		[2, 14],
		[27, 14],
		[13, 1],
		[16, 1],
		[1, 8],
		[28, 8]
	]
};

/** islands — water-heavy pools carve the field into open driving lanes. */
const ISLANDS: ArenaMap = {
	id: 'islands',
	name: 'Islands',
	rows: mirrored([
		'###############',
		'#..............',
		'#..~~~..C......',
		'#.~~~~~........',
		'#.~~~~~..##....',
		'#..~~~.........',
		'#.....C........',
		'#..~~~.........',
		'#..............'
	]),
	spawns: [
		[2, 1],
		[27, 1],
		[2, 15],
		[27, 15],
		[13, 8],
		[16, 8],
		[1, 6],
		[28, 6]
	]
};

/** fortress — a central steel fort ringed by tight corridors and crate cover. */
const FORTRESS: ArenaMap = {
	id: 'fortress',
	name: 'Fortress',
	rows: [
		'###############',
		'#..............',
		'#..C..#........',
		'#.....#........',
		'#.....C.C......',
		'#..............',
		'#..........####',
		'#..........####',
		'#....CC....####',
		'#..........####',
		'#..........####',
		'#..............',
		'#.....C.C......',
		'#.....#........',
		'#..C..#........',
		'#..............',
		'###############'
	].map((line) => line + line.split('').reverse().join('')),
	spawns: [
		[2, 2],
		[27, 2],
		[2, 14],
		[27, 14],
		[13, 1],
		[16, 1],
		[1, 8],
		[28, 8]
	]
};

/** All shipped arenas, in menu order. */
export const ARENAS: readonly Arena[] = [CROSSFIRE, ISLANDS, FORTRESS].map(parseArena);

/** Look up an arena by id; unknown ids fall back to `crossfire`. */
export function getArena(id: string): Arena {
	return ARENAS.find((arena) => arena.id === id) ?? ARENAS[0];
}
