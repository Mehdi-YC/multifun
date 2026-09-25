/**
 * Turbo Kart tracks: a tile grid built around a closed-loop centerline spline.
 *
 * A track is authored as a compact `TrackMap`: a list of centerline waypoints
 * (world pixels), a road half-width and a handful of rectangular patches. The
 * tile grid is then DERIVED from the spline — every tile within `roadHalfWidth`
 * of the centerline becomes road, the next ring becomes curb, everything else
 * grass — so "the spline is on drivable tiles" holds by construction and the
 * tests can still verify it (plus the patches, which are hand-placed and can
 * get it wrong).
 *
 * The centerline is sampled (Catmull-Rom, ~6px steps) into `TrackPoint`s with
 * unit tangents and cumulative arc length. It drives everything: checkpoint
 * gates, respawn points, the AI racing line and the minimap path.
 *
 * Tile legend (char -> tile):
 *
 *   `.` road     — full grip, full speed
 *   `=` curb     — rumble strip, mildly slow
 *   `,` grass    — off-road, ~50% speed
 *   `i` ice      — very low grip (Frostbite Falls)
 *   `^` boost    — boost strip (+40% for 0.8s)
 *   `r` ramp     — launches karts into the air (trickable)
 *   `#` wall     — solid; soft-wall collisions
 *   `?` itembox  — road tile with an item box entity on top (sim-side)
 *   `~` water    — falling in respawns you at the last checkpoint
 *   `d` decor    — decorative prop on grass (drawn, not solid)
 */

export const TILE_SIZE = 16;

export type TileType =
	'road' | 'curb' | 'grass' | 'ice' | 'boost' | 'ramp' | 'wall' | 'itembox' | 'water' | 'decor';

export const TILE_CHARS: Record<string, TileType> = {
	'.': 'road',
	'=': 'curb',
	',': 'grass',
	i: 'ice',
	'^': 'boost',
	r: 'ramp',
	'#': 'wall',
	'?': 'itembox',
	'~': 'water',
	d: 'decor'
};

/** Tiles a kart can drive on at full rules (no falling, no wall bounce). */
export function isDrivableTile(tile: TileType): boolean {
	return (
		tile === 'road' ||
		tile === 'curb' ||
		tile === 'ice' ||
		tile === 'boost' ||
		tile === 'ramp' ||
		tile === 'itembox'
	);
}

/** Tiles that block movement (soft walls + breakable shortcut walls). */
export function isSolidTile(tile: TileType): boolean {
	return tile === 'wall';
}

/** Slow tiles (off-road): capped speed + rumble. */
export function isOffRoadTile(tile: TileType): boolean {
	return tile === 'grass' || tile === 'decor';
}

export interface TrackPoint {
	x: number;
	y: number;
	/** Unit tangent in the direction of travel. */
	tx: number;
	ty: number;
	/** Arc length from the start/finish line along the loop, in world px. */
	s: number;
}

/** A checkpoint gate on the centerline. Checkpoint 0 is the start/finish line. */
export interface TrackCheckpoint extends TrackPoint {
	index: number;
}

/** A deterministic moving hazard sweeping between two points (sim-timed). */
export interface HazardPath {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Sweep period in ticks (one full out-and-back trip). */
	period: number;
	/** Phase offset in [0, 1). */
	phase: number;
	/** Collision radius in px. */
	radius: number;
}

export interface StartSpot {
	x: number;
	y: number;
	angle: number;
}

/** Rendering palette for one track. */
export interface TrackPalette {
	bg: string;
	grass: string;
	grassAlt: string;
	road: string;
	roadAlt: string;
	curb: string;
	curbAlt: string;
	ice: string;
	boost: string;
	ramp: string;
	wall: string;
	wallLight: string;
	wallDark: string;
	water: string;
	decor: string;
	accent: string;
}

export interface Track {
	id: string;
	name: string;
	cols: number;
	rows: number;
	/** Road half-width in world px around the centerline (gate sizing etc.). */
	roadHalfWidth: number;
	/** Row-major tile grid, `cols * rows` entries. */
	tiles: TileType[];
	/** Dense closed-loop centerline samples (arc length ascending). */
	spline: TrackPoint[];
	/** Total loop length in world px. */
	lapLength: number;
	/** Checkpoint gates, evenly spaced by arc length (0 = start/finish). */
	checkpoints: TrackCheckpoint[];
	/** Respawn anchors (checkpoint points snapped onto drivable tiles). */
	respawns: TrackPoint[];
	/** Staggered starting grid, just past the start line. */
	startGrid: StartSpot[];
	/** Item box anchor points (tile centers). */
	itemBoxes: { x: number; y: number }[];
	/** Tile indices of breakable shortcut walls (sim owns their hp). */
	breakables: number[];
	/** Tile indices of designated jump-gap water (flanked by ramps). */
	jumpGaps: number[];
	hazards: HazardPath[];
	palette: TrackPalette;
}

/** A rectangular patch painted after the base terrain, in tile coords. */
export interface TrackPatch {
	tile: TileType;
	col: number;
	row: number;
	w: number;
	h: number;
}

/** Compact source form of a track, as authored. */
export interface TrackMap {
	id: string;
	name: string;
	cols: number;
	rows: number;
	/** Closed-loop centerline waypoints in world pixels (>= 4). */
	centerline: [number, number][];
	/** Road half-width in world px around the centerline. */
	roadHalfWidth: number;
	patches: TrackPatch[];
	/**
	 * Item box spots as arc positions along the centerline: `s` in px from the
	 * start line, `lateral` in px to the right of the travel direction. Keeping
	 * them spline-anchored means they stay on the racing line if the geometry
	 * ever changes (validation still checks the final tile is drivable).
	 */
	itemBoxes: { s: number; lateral: number }[];
	/** Breakable wall tiles as [col, row] (must sit on `wall` patches). */
	breakables: [number, number][];
	/** Water tiles that form a jump gap (must be ramp-flanked). */
	jumpGaps: [number, number][];
	hazards: HazardPath[];
	palette: TrackPalette;
}

/** Distance between two consecutive centerline samples (~6px). */
export const SAMPLE_STEP = 6;

// ---- geometry ----

/** Catmull-Rom interpolation of a segment (p1 -> p2, eased by p0/p3). */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const t2 = t * t;
	const t3 = t2 * t;
	return (
		0.5 *
		(2 * p1 +
			(-p0 + p2) * t +
			(2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
			(-p0 + 3 * p1 - 3 * p2 + p3) * t3)
	);
}

/** Sample a closed Catmull-Rom loop through `waypoints` at ~SAMPLE_STEP px. */
function sampleLoop(waypoints: readonly [number, number][]): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	const n = waypoints.length;
	for (let i = 0; i < n; i++) {
		const p0 = waypoints[(i - 1 + n) % n];
		const p1 = waypoints[i];
		const p2 = waypoints[(i + 1) % n];
		const p3 = waypoints[(i + 2) % n];
		const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
		const steps = Math.max(2, Math.ceil(segLen / SAMPLE_STEP));
		for (let j = 0; j < steps; j++) {
			const t = j / steps;
			out.push({
				x: catmullRom(p0[0], p1[0], p2[0], p3[0], t),
				y: catmullRom(p0[1], p1[1], p2[1], p3[1], t)
			});
		}
	}
	return out;
}

/**
 * Turn raw loop samples into `TrackPoint`s: unit tangents (central difference,
 * wrapping) and cumulative arc length including the closing segment.
 */
function buildSpline(samples: { x: number; y: number }[]): TrackPoint[] {
	const n = samples.length;
	const spline: TrackPoint[] = [];
	let s = 0;
	for (let i = 0; i < n; i++) {
		const prev = samples[(i - 1 + n) % n];
		const next = samples[(i + 1) % n];
		let tx = next.x - prev.x;
		let ty = next.y - prev.y;
		const len = Math.hypot(tx, ty) || 1;
		tx /= len;
		ty /= len;
		spline.push({ x: samples[i].x, y: samples[i].y, tx, ty, s });
		const following = samples[(i + 1) % n];
		s += Math.hypot(following.x - samples[i].x, following.y - samples[i].y);
	}
	return spline;
}

/** Point on the loop at arc length `s` (wrapped), interpolated between samples. */
export function splineAt(track: Track, s: number): TrackPoint {
	const spline = track.spline;
	const n = spline.length;
	const wrapped = ((s % track.lapLength) + track.lapLength) % track.lapLength;
	// Samples are near-uniform (~SAMPLE_STEP apart): index straight from arc.
	let index = Math.floor(wrapped / SAMPLE_STEP);
	if (index >= n) index = n - 1;
	const a = spline[index];
	const b = spline[(index + 1) % n];
	const span = b.s > a.s ? b.s - a.s : track.lapLength - a.s;
	const t = span > 0 ? Math.min(1, Math.max(0, (wrapped - a.s) / span)) : 0;
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
		tx: a.tx + (b.tx - a.tx) * t,
		ty: a.ty + (b.ty - a.ty) * t,
		s: wrapped
	};
}

export interface NearestSpline {
	index: number;
	distance: number;
	point: TrackPoint;
}

/**
 * Nearest centerline sample to a world position. `hint` is the previous sample
 * index (windowed local search — hot path for 8 karts at 60Hz); pass -1 (or a
 * stale hint) for a full scan. Deterministic: pure function of its arguments.
 */
export function nearestSpline(track: Track, x: number, y: number, hint = -1): NearestSpline {
	const spline = track.spline;
	const n = spline.length;
	let best = -1;
	let bestD2 = Number.POSITIVE_INFINITY;
	const search = (from: number, to: number): void => {
		for (let k = from; k <= to; k++) {
			const i = ((k % n) + n) % n;
			const dx = spline[i].x - x;
			const dy = spline[i].y - y;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) {
				bestD2 = d2;
				best = i;
			}
		}
	};
	if (hint >= 0) search(hint - 64, hint + 64);
	else search(0, n - 1);
	// A windowed miss (teleport, far respawn, stale hint) falls back to the
	// full scan well before any distance decision (respawns at 150px) trusts
	// a windowed-only answer.
	if (hint >= 0 && bestD2 > 100 * 100) {
		best = -1;
		bestD2 = Number.POSITIVE_INFINITY;
		search(0, n - 1);
	}
	return { index: best, distance: Math.sqrt(bestD2), point: spline[best] };
}

// ---- tiles ----

/** Tile at grid coords; out of bounds reads as `wall` (the world is sealed). */
export function tileAt(track: Track, col: number, row: number): TileType {
	if (col < 0 || row < 0 || col >= track.cols || row >= track.rows) return 'wall';
	return track.tiles[row * track.cols + col];
}

/** Tile under a world pixel position. */
export function tileAtPx(track: Track, x: number, y: number): TileType {
	return tileAt(track, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
}

/** Center of the tile at [col, row], in world pixels. */
export function tileCenter(col: number, row: number): { x: number; y: number } {
	return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

/**
 * Position of a moving hazard at a sim tick: a triangle wave along its path
 * (out and back over `period` ticks). Pure function of (hazard, tick) — the
 * sim never stores hazard positions, so snapshots stay small and restore is
 * exact (the tick carries it).
 */
export function hazardAt(hazard: HazardPath, tick: number): { x: number; y: number } {
	const phase = (((tick / hazard.period + hazard.phase) % 1) + 1) % 1;
	const t = phase < 0.5 ? phase * 2 : 2 - phase * 2;
	return {
		x: hazard.x0 + (hazard.x1 - hazard.x0) * t,
		y: hazard.y0 + (hazard.y1 - hazard.y0) * t
	};
}

// ---- building ----

/**
 * Build a full track from its source form. Throws with a descriptive message on
 * malformed geometry (see `validateTrack` for the semantic checks the tests
 * run).
 */
export function parseTrack(map: TrackMap): Track {
	if (typeof map.id !== 'string' || map.id.length === 0) {
		throw new Error('track: id must be a non-empty string');
	}
	if (!Number.isInteger(map.cols) || !Number.isInteger(map.rows) || map.cols < 8 || map.rows < 8) {
		throw new Error(`track ${map.id}: grid must be at least 8x8 tiles`);
	}
	if (map.cols > 96 || map.rows > 96) {
		throw new Error(`track ${map.id}: grid must be at most 96x96 tiles`);
	}
	if (!Array.isArray(map.centerline) || map.centerline.length < 4) {
		throw new Error(`track ${map.id}: needs at least 4 centerline waypoints`);
	}
	if (!(map.roadHalfWidth >= 16 && map.roadHalfWidth <= 96)) {
		throw new Error(`track ${map.id}: roadHalfWidth must be 16..96 px`);
	}

	const samples = sampleLoop(map.centerline);
	const spline = buildSpline(samples);
	let lapLength = 0;
	for (let i = 0; i < spline.length; i++) {
		const a = spline[i];
		const b = spline[(i + 1) % spline.length];
		lapLength += Math.hypot(b.x - a.x, b.y - a.y);
	}

	// Base terrain: road band around the centerline, curb ring, grass beyond.
	const tiles: TileType[] = new Array(map.cols * map.rows).fill('grass');
	for (let row = 0; row < map.rows; row++) {
		for (let col = 0; col < map.cols; col++) {
			if (row === 0 || col === 0 || row === map.rows - 1 || col === map.cols - 1) {
				tiles[row * map.cols + col] = 'wall';
				continue;
			}
			const center = tileCenter(col, row);
			let dist = Number.POSITIVE_INFINITY;
			for (const p of spline) {
				const dx = p.x - center.x;
				const dy = p.y - center.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < dist) dist = d2;
			}
			dist = Math.sqrt(dist);
			if (dist <= map.roadHalfWidth) tiles[row * map.cols + col] = 'road';
			else if (dist <= map.roadHalfWidth + TILE_SIZE) tiles[row * map.cols + col] = 'curb';
		}
	}

	// Hand-placed patches (boost strips, ramps, ice, water, shortcut walls...).
	for (const patch of map.patches) {
		for (let row = patch.row; row < patch.row + patch.h; row++) {
			for (let col = patch.col; col < patch.col + patch.w; col++) {
				if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) continue;
				tiles[row * map.cols + col] = patch.tile;
			}
		}
	}

	const indexOf = (col: number, row: number): number => row * map.cols + col;
	const breakables: number[] = [];
	for (const [col, row] of map.breakables) {
		if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) {
			throw new Error(`track ${map.id}: breakable [${col}, ${row}] out of bounds`);
		}
		const index = indexOf(col, row);
		if (tiles[index] !== 'wall') {
			throw new Error(`track ${map.id}: breakable [${col}, ${row}] is not a wall tile`);
		}
		breakables.push(index);
	}
	const jumpGaps: number[] = [];
	for (const [col, row] of map.jumpGaps) {
		if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) {
			throw new Error(`track ${map.id}: jump gap [${col}, ${row}] out of bounds`);
		}
		const index = indexOf(col, row);
		if (tiles[index] !== 'water') {
			throw new Error(`track ${map.id}: jump gap [${col}, ${row}] is not a water tile`);
		}
		jumpGaps.push(index);
	}

	// Assemble the static track first: item box / checkpoint / respawn / grid
	// derivation below reads back through the spline helpers.
	const track: Track = {
		id: map.id,
		name: map.name,
		cols: map.cols,
		rows: map.rows,
		roadHalfWidth: map.roadHalfWidth,
		tiles,
		spline,
		lapLength,
		checkpoints: [],
		respawns: [],
		startGrid: [],
		itemBoxes: [],
		breakables,
		jumpGaps,
		hazards: map.hazards.map((h) => ({ ...h })),
		palette: map.palette
	};

	// Item boxes: spline-anchored spots on drivable ground, entity at tile center.
	for (const spot of map.itemBoxes) {
		if (!Number.isFinite(spot.s) || !Number.isFinite(spot.lateral)) {
			throw new Error(`track ${map.id}: item box spot must be { s, lateral } numbers`);
		}
		const p = splineAt(track, spot.s);
		const x = p.x - p.ty * spot.lateral;
		const y = p.y + p.tx * spot.lateral;
		const col = Math.floor(x / TILE_SIZE);
		const row = Math.floor(y / TILE_SIZE);
		const index = indexOf(col, row);
		if (col < 0 || row < 0 || col >= map.cols || row >= map.rows || !isDrivableTile(tiles[index])) {
			throw new Error(
				`track ${map.id}: item box at s=${spot.s} lateral=${spot.lateral} is not on drivable ground`
			);
		}
		tiles[index] = 'itembox';
		track.itemBoxes.push(tileCenter(col, row));
	}

	// Checkpoint gates: 12 evenly spaced by arc length (0 = start/finish).
	const checkpointCount = 12;
	for (let k = 0; k < checkpointCount; k++) {
		const s = (k * lapLength) / checkpointCount;
		const p = splineAt(track, s);
		track.checkpoints.push({ ...p, s, index: k });
	}

	// Respawn anchors: the checkpoint position, snapped to a drivable sample.
	for (const cp of track.checkpoints) {
		const near = nearestSpline(track, cp.x, cp.y, -1);
		let anchor: TrackPoint = { ...cp };
		for (let offset = 0; offset <= 24; offset++) {
			const signs = offset === 0 ? [0] : [1, -1];
			let found = false;
			for (const sign of signs) {
				const i = (((near.index + sign * offset) % spline.length) + spline.length) % spline.length;
				const p = spline[i];
				const tile = tiles[Math.floor(p.y / TILE_SIZE) * map.cols + Math.floor(p.x / TILE_SIZE)];
				if (isDrivableTile(tile)) {
					anchor = { ...p };
					found = true;
					break;
				}
			}
			if (found) break;
		}
		track.respawns.push(anchor);
	}

	// Start grid: 2 columns x 4 rows staggered just past the start line.
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 2; col++) {
			const s = 18 + row * 22;
			const lateral = col === 0 ? -18 : 18;
			const p = splineAt(track, s);
			track.startGrid.push({
				x: p.x - p.ty * lateral,
				y: p.y + p.tx * lateral,
				angle: Math.atan2(p.ty, p.tx)
			});
		}
	}

	return track;
}

// ---- validation ----

/**
 * Semantic checks the tests (and any future track editor) run: closed loop,
 * spline on drivable ground, respawns/boxes reachable, sane lap length and
 * jump gaps flanked by ramps. Returns a list of problems (empty = valid).
 */
export function validateTrack(track: Track): string[] {
	const problems: string[] = [];
	const spline = track.spline;
	const n = spline.length;

	if (n < 24) problems.push(`spline too short (${n} samples)`);
	const first = spline[0];
	const last = spline[n - 1];
	const closing = Math.hypot(first.x - last.x, first.y - last.y);
	if (closing > SAMPLE_STEP * 3) {
		problems.push(`loop not closed (gap ${closing.toFixed(1)}px between last and first sample)`);
	}

	// The racing line must stay on drivable ground (jump-gap water is allowed
	// but must be ramp-flanked — checked below).
	const gapSet = new Set(track.jumpGaps);
	for (let i = 0; i < n; i++) {
		const p = spline[i];
		const tile = tileAtPx(track, p.x, p.y);
		if (isDrivableTile(tile)) continue;
		if (gapSet.has(Math.floor(p.y / TILE_SIZE) * track.cols + Math.floor(p.x / TILE_SIZE)))
			continue;
		problems.push(`spline sample ${i} sits on '${tile}' at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
	}

	for (let i = 0; i < track.respawns.length; i++) {
		const p = track.respawns[i];
		const tile = tileAtPx(track, p.x, p.y);
		if (!isDrivableTile(tile)) {
			problems.push(`respawn ${i} sits on '${tile}' at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
		}
	}

	for (let i = 0; i < track.itemBoxes.length; i++) {
		const box = track.itemBoxes[i];
		const tile = tileAtPx(track, box.x, box.y);
		if (tile !== 'itembox') {
			problems.push(`item box ${i} sits on '${tile}' at ${box.x.toFixed(0)},${box.y.toFixed(0)}`);
		}
	}

	if (!(track.lapLength >= 600 && track.lapLength <= 6000)) {
		problems.push(`lap length ${track.lapLength.toFixed(0)}px out of range (600..6000)`);
	}

	// Checkpoint gates must not overlap: spacing has to exceed the gate width.
	const spacing = track.lapLength / track.checkpoints.length;
	if (spacing < 48) problems.push(`checkpoint spacing ${spacing.toFixed(0)}px too tight (< 48)`);

	// Every jump-gap tile needs a ramp within 4 tiles behind/ahead of it.
	for (const index of track.jumpGaps) {
		const col = index % track.cols;
		const row = Math.floor(index / track.cols);
		let nearRamp = false;
		for (let dy = -4; dy <= 4 && !nearRamp; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				if (tileAt(track, col + dx, row + dy) === 'ramp') {
					nearRamp = true;
					break;
				}
			}
		}
		if (!nearRamp) problems.push(`jump gap tile [${col}, ${row}] has no ramp within 4 tiles`);
	}

	if (track.startGrid.length < 8)
		problems.push(`start grid has ${track.startGrid.length} spots (< 8)`);
	for (let i = 0; i < track.startGrid.length; i++) {
		const spot = track.startGrid[i];
		const tile = tileAtPx(track, spot.x, spot.y);
		if (!isDrivableTile(tile)) {
			problems.push(
				`start spot ${i} sits on '${tile}' at ${spot.x.toFixed(0)},${spot.y.toFixed(0)}`
			);
		}
	}

	if (track.itemBoxes.length === 0) problems.push('track has no item boxes');
	return problems;
}

// ---- shipped tracks ----

const SUNNY_PALETTE: TrackPalette = {
	bg: '#24401c',
	grass: '#3e8e3f',
	grassAlt: '#56b45a',
	road: '#5a5f6b',
	roadAlt: '#545963',
	curb: '#e8e8f0',
	curbAlt: '#c2283c',
	ice: '#bfe9ff',
	boost: '#ffb437',
	ramp: '#8a6f4a',
	wall: '#6c7488',
	wallLight: '#9aa3b8',
	wallDark: '#454b60',
	water: '#2f6fc4',
	decor: '#2c6b2f',
	accent: '#ffe066'
};

const DOJO_PALETTE: TrackPalette = {
	bg: '#0f1020',
	grass: '#241b33',
	grassAlt: '#2c2140',
	road: '#2a2c3c',
	roadAlt: '#252735',
	curb: '#e0407f',
	curbAlt: '#4a2050',
	ice: '#7be0ff',
	boost: '#ff4fa0',
	ramp: '#3c3454',
	wall: '#3a3155',
	wallLight: '#8a5cff',
	wallDark: '#241c3c',
	water: '#16224e',
	decor: '#1c1430',
	accent: '#7be0ff'
};

const FROST_PALETTE: TrackPalette = {
	bg: '#1c2a38',
	grass: '#dfeaf2',
	grassAlt: '#c8d8e4',
	road: '#6a7686',
	roadAlt: '#626e7e',
	curb: '#9ad6ff',
	curbAlt: '#5a86a8',
	ice: '#aee6ff',
	boost: '#ffd166',
	ramp: '#8fa8bd',
	wall: '#4c5b6c',
	wallLight: '#7c8ca0',
	wallDark: '#36424f',
	water: '#28527e',
	decor: '#b8c8d4',
	accent: '#9ad6ff'
};

/**
 * Sunny Circuit — wide, gentle sweeps that teach drift-boost charging. The
 * start/finish straight runs along the bottom; long corners left and right.
 */
const SUNNY_CIRCUIT: TrackMap = {
	id: 'sunny-circuit',
	name: 'Sunny Circuit',
	cols: 40,
	rows: 30,
	centerline: [
		[280, 432],
		[180, 420],
		[128, 372],
		[88, 268],
		[112, 156],
		[216, 96],
		[340, 80],
		[452, 96],
		[536, 168],
		[552, 272],
		[512, 372],
		[408, 424]
	],
	roadHalfWidth: 46,
	patches: [
		// Boost strips on both straights.
		{ tile: 'boost', col: 18, row: 25, w: 3, h: 4 },
		{ tile: 'boost', col: 19, row: 2, w: 3, h: 4 },
		// A playful ramp on the top straight (trick for a landing boost).
		{ tile: 'ramp', col: 27, row: 2, w: 2, h: 4 },
		// Scenery pockets (infield grass, never on the racing line).
		{ tile: 'decor', col: 17, row: 13, w: 3, h: 3 },
		{ tile: 'decor', col: 24, row: 15, w: 2, h: 2 },
		{ tile: 'decor', col: 21, row: 20, w: 2, h: 2 },
		{ tile: 'decor', col: 13, row: 21, w: 2, h: 2 }
	],
	itemBoxes: [
		{ s: 120, lateral: -20 },
		{ s: 340, lateral: 16 },
		{ s: 720, lateral: -10 },
		{ s: 900, lateral: 20 },
		{ s: 1320, lateral: -16 },
		{ s: 1560, lateral: 18 }
	],
	breakables: [],
	jumpGaps: [],
	hazards: [],
	palette: SUNNY_PALETTE
};

/**
 * Neon Dojo — tight S-curves under neon light. The shortcut across the S
 * chicane sits behind a breakable wall block: smash it (a crash at speed or a
 * missile) to open the straight shot through the middle.
 */
const NEON_DOJO: TrackMap = {
	id: 'neon-dojo',
	name: 'Neon Dojo',
	cols: 40,
	rows: 30,
	centerline: [
		[280, 412],
		[184, 408],
		[112, 380],
		[92, 292],
		[108, 196],
		[180, 128],
		[272, 108],
		[348, 196],
		[424, 116],
		[492, 164],
		[548, 248],
		[520, 344],
		[436, 408]
	],
	roadHalfWidth: 30,
	patches: [
		// Shortcut lane across the S chicane (blocked by the wall block below).
		{ tile: 'road', col: 17, row: 5, w: 11, h: 3 },
		// Breakable wall block in the middle of the shortcut lane.
		{ tile: 'wall', col: 21, row: 5, w: 3, h: 3 },
		// Boost strips: bottom straight and the exit of the chicane.
		{ tile: 'boost', col: 15, row: 25, w: 3, h: 3 },
		{ tile: 'boost', col: 31, row: 22, w: 3, h: 3 },
		// Neon decor pockets (off the racing line).
		{ tile: 'decor', col: 24, row: 19, w: 3, h: 3 },
		{ tile: 'decor', col: 33, row: 9, w: 2, h: 2 },
		{ tile: 'decor', col: 21, row: 15, w: 3, h: 3 },
		{ tile: 'decor', col: 10, row: 22, w: 2, h: 2 }
	],
	itemBoxes: [
		{ s: 110, lateral: -12 },
		{ s: 300, lateral: 12 },
		{ s: 560, lateral: -8 },
		{ s: 900, lateral: 12 },
		{ s: 1220, lateral: -12 }
	],
	breakables: [
		[21, 5],
		[22, 5],
		[23, 5],
		[21, 6],
		[22, 6],
		[23, 6],
		[21, 7],
		[22, 7],
		[23, 7]
	],
	jumpGaps: [],
	hazards: [],
	palette: DOJO_PALETTE
};

/**
 * Frostbite Falls — low-grip ice on the west bend, a jump gap over a frozen
 * channel on the bottom straight (ramps both sides) and a sweeping snowball
 * hazard crossing the top straight.
 */
const FROSTBITE_FALLS: TrackMap = {
	id: 'frostbite-falls',
	name: 'Frostbite Falls',
	cols: 40,
	rows: 30,
	centerline: [
		[300, 428],
		[190, 420],
		[120, 380],
		[92, 280],
		[104, 172],
		[180, 104],
		[300, 84],
		[420, 92],
		[520, 140],
		[552, 240],
		[520, 340],
		[430, 408]
	],
	roadHalfWidth: 40,
	patches: [
		// The frozen west bend: pure ice, minimal grip.
		{ tile: 'ice', col: 3, row: 11, w: 6, h: 11 },
		// Frozen channel across the bottom straight + ramp lips both sides.
		{ tile: 'water', col: 19, row: 24, w: 2, h: 6 },
		{ tile: 'ramp', col: 17, row: 25, w: 2, h: 4 },
		{ tile: 'ramp', col: 21, row: 25, w: 2, h: 4 },
		// Snow drifts (infield/off-road only).
		{ tile: 'decor', col: 24, row: 20, w: 3, h: 3 },
		{ tile: 'decor', col: 20, row: 13, w: 3, h: 3 },
		{ tile: 'decor', col: 14, row: 7, w: 2, h: 2 },
		{ tile: 'decor', col: 36, row: 24, w: 2, h: 2 }
	],
	itemBoxes: [
		{ s: 130, lateral: -18 },
		{ s: 380, lateral: 18 },
		{ s: 760, lateral: -12 },
		{ s: 1120, lateral: 16 },
		{ s: 1520, lateral: -16 }
	],
	breakables: [],
	jumpGaps: [
		[19, 24],
		[20, 24],
		[19, 25],
		[20, 25],
		[19, 26],
		[20, 26],
		[19, 27],
		[20, 27],
		[19, 28],
		[20, 28],
		[19, 29],
		[20, 29]
	],
	hazards: [
		// Snowball sweeping across the top straight.
		{ x0: 300, y0: 36, x1: 300, y1: 132, period: 300, phase: 0, radius: 13 },
		// A second sweeper on the east bend, out of phase.
		{ x0: 566, y0: 200, x1: 470, y1: 264, period: 260, phase: 0.5, radius: 11 }
	],
	palette: FROST_PALETTE
};

/** All shipped tracks, in menu order. */
export const TRACKS: readonly Track[] = [SUNNY_CIRCUIT, NEON_DOJO, FROSTBITE_FALLS].map(parseTrack);

/** Look up a track by id; unknown ids fall back to `sunny-circuit`. */
export function getTrack(id: string): Track {
	return TRACKS.find((track) => track.id === id) ?? TRACKS[0];
}
