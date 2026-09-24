/**
 * Arena integrity: every shipped map parses, is sealed inside steel, seats 8
 * spawns on open floor, and every spawn can reach every other spawn.
 */
import { describe, expect, it } from 'vitest';
import {
	ARENAS,
	TILE_SIZE,
	getArena,
	isBulletSolid,
	isTankSolid,
	parseArena,
	tileAt,
	tileAtPx,
	tileCenter,
	type Arena,
	type ArenaMap
} from './arena';

const MINI: ArenaMap = {
	id: 'mini',
	name: 'Mini',
	rows: ['#####', '#...#', '#.C.#', '#...#', '#####'],
	spawns: [
		[1, 1],
		[3, 3]
	]
};

/** Tank-walkable tiles (bushes are driven over; water and solids block). */
function walkable(arena: Arena, col: number, row: number): boolean {
	return !isTankSolid(tileAt(arena, col, row));
}

/** Flood fill from the first spawn; returns the set of reachable tile indices. */
function reachableTiles(arena: Arena): Set<number> {
	const start = tileCenter(
		Math.floor(arena.spawns[0].x / TILE_SIZE),
		Math.floor(arena.spawns[0].y / TILE_SIZE)
	);
	const startCol = Math.floor(start.x / TILE_SIZE);
	const startRow = Math.floor(start.y / TILE_SIZE);
	const seen = new Set<number>([startRow * arena.cols + startCol]);
	const queue: [number, number][] = [[startCol, startRow]];
	while (queue.length > 0) {
		const [col, row] = queue.pop() as [number, number];
		for (const [dc, dr] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1]
		] as const) {
			const nc = col + dc;
			const nr = row + dr;
			const key = nr * arena.cols + nc;
			if (nc < 0 || nr < 0 || nc >= arena.cols || nr >= arena.rows) continue;
			if (seen.has(key) || !walkable(arena, nc, nr)) continue;
			seen.add(key);
			queue.push([nc, nr]);
		}
	}
	return seen;
}

describe('shipped arenas', () => {
	it('ships exactly three arenas: crossfire, islands, fortress', () => {
		expect(ARENAS.map((a) => a.id)).toEqual(['crossfire', 'islands', 'fortress']);
		expect(getArena('islands').id).toBe('islands');
		expect(getArena('does-not-exist').id).toBe('crossfire');
	});

	it('every arena is a 30x17 tile grid (480x272 world pixels)', () => {
		for (const arena of ARENAS) {
			expect(arena.cols).toBe(30);
			expect(arena.rows).toBe(17);
			expect(arena.tiles).toHaveLength(30 * 17);
		}
	});

	it('is fully enclosed by walls (no leaks)', () => {
		for (const arena of ARENAS) {
			for (let col = 0; col < arena.cols; col++) {
				expect(tileAt(arena, col, 0)).toBe('wall');
				expect(tileAt(arena, col, arena.rows - 1)).toBe('wall');
			}
			for (let row = 0; row < arena.rows; row++) {
				expect(tileAt(arena, 0, row)).toBe('wall');
				expect(tileAt(arena, arena.cols - 1, row)).toBe('wall');
			}
		}
	});

	it('has 8 spawn points on floor tiles', () => {
		for (const arena of ARENAS) {
			expect(arena.spawns).toHaveLength(8);
			for (const spawn of arena.spawns) {
				const col = Math.floor(spawn.x / TILE_SIZE);
				const row = Math.floor(spawn.y / TILE_SIZE);
				expect(tileAt(arena, col, row)).toBe('floor');
				expect(spawn.x % TILE_SIZE).toBe(TILE_SIZE / 2);
				expect(spawn.y % TILE_SIZE).toBe(TILE_SIZE / 2);
			}
		}
	});

	it('keeps every spawn mutually reachable (flood-fill BFS)', () => {
		for (const arena of ARENAS) {
			const seen = reachableTiles(arena);
			for (const spawn of arena.spawns) {
				const col = Math.floor(spawn.x / TILE_SIZE);
				const row = Math.floor(spawn.y / TILE_SIZE);
				expect(seen.has(row * arena.cols + col)).toBe(true);
			}
		}
	});
});

describe('parseArena validator', () => {
	it('parses a well-formed map into tiles and spawn pixels', () => {
		const arena = parseArena(MINI);
		expect(arena.cols).toBe(5);
		expect(arena.rows).toBe(5);
		expect(tileAt(arena, 2, 2)).toBe('crate');
		expect(tileAt(arena, 1, 1)).toBe('floor');
		expect(arena.spawns[0]).toEqual({ x: 24, y: 24 });
		expect(arena.spawns[1]).toEqual({ x: 56, y: 56 });
	});

	it('rejects ragged rows, unknown chars and out-of-range spawns', () => {
		expect(() => parseArena({ ...MINI, rows: ['#####', '#..#', '#####'] })).toThrow(/width/);
		expect(() => parseArena({ ...MINI, rows: ['#####', '#..X#', '#####'] })).toThrow(
			/unknown tile char/
		);
		expect(() => parseArena({ ...MINI, spawns: [[9, 1]] })).toThrow(/out of bounds/);
		expect(() => parseArena({ ...MINI, spawns: [[2, 2]] })).toThrow(/solid tile/);
		expect(() => parseArena({ ...MINI, spawns: [] })).toThrow(/spawn/);
		expect(() => parseArena({ ...MINI, rows: [] })).toThrow(/rows/);
	});
});

describe('tile helpers', () => {
	it('maps collision classes per tile type', () => {
		expect(isTankSolid('wall')).toBe(true);
		expect(isTankSolid('crate')).toBe(true);
		expect(isTankSolid('water')).toBe(true);
		expect(isTankSolid('bush')).toBe(false);
		expect(isTankSolid('floor')).toBe(false);
		expect(isBulletSolid('wall')).toBe(true);
		expect(isBulletSolid('crate')).toBe(true);
		expect(isBulletSolid('water')).toBe(false);
		expect(isBulletSolid('bush')).toBe(false);
	});

	it('reads out-of-bounds as wall and pixels via tileAtPx', () => {
		const arena = parseArena(MINI);
		expect(tileAt(arena, -1, 3)).toBe('wall');
		expect(tileAt(arena, 5, 0)).toBe('wall');
		expect(tileAtPx(arena, 40, 40)).toBe('crate');
		expect(tileAtPx(arena, 24, 24)).toBe('floor');
	});
});
