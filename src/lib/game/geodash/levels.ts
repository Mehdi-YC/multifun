/**
 * Handcrafted GeoDash levels as plain data.
 *
 * COORDINATE CONVENTION (see level-types.ts): y grows downward, the ground
 * surface is y = 0, and objects anchor at their top-left corner. The floor is
 * made of `block` objects at y = 0 (see `floorSeg`), so missing floor = pit.
 *
 * Levels are built by composing patterns (see plan.md §7): spike runs,
 * staircases of blocks, jump-pad launches over gaps, saw corridors, orb
 * chains, and form sections behind `portal` gates (ship corridors with a
 * ceiling to slide along; ball runs between floor and ceiling with gravity
 * flips). Every level is beatable by a human — fair sightlines (>= 0.5s),
 * readable patterns, no frame-perfect inputs — and levels.spec.ts proves it
 * with an auto-playing bot driving the real sim in every form.
 */
import type { GeoDashLevel, GeoDashMode, GeoDashObject } from './level-types';
import { GRID } from './level-types';

// ---- pattern helpers (all return plain GeoDashObject data) ----

/** A floor segment from x0 to x1: solid ground occupying y in [0, 80]. */
function floorSeg(x0: number, x1: number): GeoDashObject {
	return { type: 'block', x: x0, y: 0, w: x1 - x0, h: 80 };
}

/** A ceiling segment from x0 to x1 whose underside sits at `bottomY`. */
function ceilingSeg(x0: number, x1: number, bottomY: number): GeoDashObject {
	const thick = 40;
	return { type: 'block', x: x0, y: bottomY - thick, w: x1 - x0, h: thick };
}

/** A grounded spike: 40x40 cell sitting on the ground (base at y = 0). */
function spike(x: number): GeoDashObject {
	return { type: 'spike', x, y: -GRID };
}

/** A hanging spike pointing down from a ceiling whose underside is `bottomY`. */
function spikeCeiling(x: number, bottomY: number): GeoDashObject {
	return { type: 'spike', x, y: bottomY, flip: true };
}

/** A run of `count` adjacent spikes (one jump clears it). */
function spikeRun(x: number, count: number): GeoDashObject[] {
	const out: GeoDashObject[] = [];
	for (let i = 0; i < count; i++) out.push(spike(x + i * GRID));
	return out;
}

/** A staircase step: solid from `topY` down to the ground. */
function step(x: number, topY: number, w: number): GeoDashObject {
	return { type: 'block', x, y: topY, w, h: -topY };
}

/** A grounded saw blade (deadly circle, center 22px above the ground). */
function saw(x: number): GeoDashObject {
	return { type: 'saw', x, y: -22, r: 22, spin: 1 };
}

/** A saw hanging from a ceiling whose underside is `bottomY`. */
function sawCeiling(x: number, bottomY: number): GeoDashObject {
	return { type: 'saw', x, y: bottomY + 22, r: 22, spin: -1 };
}

/** A jump pad plate on the ground (power 1.4 = yellow, 1.8 = pink). */
function pad(x: number, power: number): GeoDashObject {
	return { type: 'pad', x, y: -8, power };
}

/** A speed portal bar standing on the ground. */
function speedPortal(x: number, mult: number): GeoDashObject {
	return { type: 'speed', x, y: -140, mult };
}

/** A form-switching portal gate at x (cube | ship | ball). */
function modePortal(x: number, mode: GeoDashMode): GeoDashObject {
	return { type: 'portal', x, mode };
}

// ---- the levels ----

const LEVEL_1: GeoDashLevel = {
	id: 'level-1',
	name: 'Neon Warmup',
	difficulty: 1,
	bpm: 112,
	lengthPx: 3000,
	objects: [
		floorSeg(0, 1560),
		spike(500),
		spike(880),
		...spikeRun(1080, 2),
		floorSeg(1720, 2200),
		pad(2100, 1.4),
		floorSeg(2400, 3060),
		step(2560, -40, 280),
		step(2840, -80, 160),
		{ type: 'deco', x: 320, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 700, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 1420, y: -60, kind: 'tree' },
		{ type: 'deco', x: 1900, y: -240, kind: 'cloud' },
		{ type: 'deco', x: 2300, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 2760, y: -240, kind: 'cloud' }
	]
};

const LEVEL_2: GeoDashLevel = {
	id: 'level-2',
	name: 'Pulse Run',
	difficulty: 2,
	bpm: 128,
	lengthPx: 4500,
	objects: [
		floorSeg(0, 1200),
		spike(600),
		saw(880),
		floorSeg(1360, 2200),
		speedPortal(1700, 1.3),
		...spikeRun(1860, 3),
		floorSeg(2480, 3700),
		step(2700, -40, 320),
		step(3020, -80, 320),
		speedPortal(3600, 1),
		floorSeg(3860, 4560),
		...spikeRun(4080, 2),
		{ type: 'deco', x: 260, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 520, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 1080, y: -60, kind: 'tree' },
		{ type: 'deco', x: 1520, y: -240, kind: 'cloud' },
		{ type: 'deco', x: 2340, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 3420, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 4240, y: -60, kind: 'tree' }
	]
};

const LEVEL_3: GeoDashLevel = {
	id: 'level-3',
	name: 'Vortex Rush',
	difficulty: 3,
	bpm: 145,
	lengthPx: 6000,
	objects: [
		floorSeg(0, 1100),
		spike(560),
		saw(820),
		// 360px pit crossed with an orb chain: jump at the edge, orb at the apex.
		{ type: 'orb', x: 1168, y: -120 },
		floorSeg(1460, 2500),
		...spikeRun(1900, 2),
		saw(2260),
		// jump-pad launch over a 300px pit into the speed corridor
		pad(2480, 1.4),
		floorSeg(2800, 6060),
		speedPortal(3100, 1.3),
		saw(3320),
		...spikeRun(3560, 3),
		step(3760, -40, 280),
		speedPortal(4500, 1.6),
		saw(4800),
		...spikeRun(5300, 2),
		spike(5750),
		{ type: 'deco', x: 300, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 640, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 1600, y: -240, kind: 'cloud' },
		{ type: 'deco', x: 2100, y: -60, kind: 'tree' },
		{ type: 'deco', x: 2900, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 3680, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 4520, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 5240, y: -240, kind: 'cloud' }
	]
};

/**
 * Ship intro: gentle cube warm-up, then a wide ship corridor (floor to glide
 * on, ceiling at -190 to slide under) with saws alternating floor/ceiling
 * every ~600px — always time to settle into the clear middle band.
 */
const LEVEL_4: GeoDashLevel = {
	id: 'level-4',
	name: 'Sky Circuit',
	difficulty: 3,
	bpm: 132,
	lengthPx: 7000,
	objects: [
		floorSeg(0, 3000),
		spike(600),
		saw(950),
		modePortal(1250, 'ship'),
		ceilingSeg(1250, 3200, -190),
		saw(1800),
		sawCeiling(2400, -190),
		floorSeg(3000, 5300),
		saw(3050),
		ceilingSeg(3200, 5200, -190),
		sawCeiling(3600, -190),
		saw(4200),
		sawCeiling(4800, -190),
		modePortal(5300, 'cube'),
		floorSeg(5300, 7100),
		spike(5800),
		...spikeRun(6200, 2),
		saw(6600),
		{ type: 'deco', x: 400, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 2000, y: -320, kind: 'cloud' },
		{ type: 'deco', x: 3400, y: -320, kind: 'cloud' },
		{ type: 'deco', x: 5600, y: -170, kind: 'pillar' },
		{ type: 'deco', x: 6400, y: -230, kind: 'cloud' }
	]
};

/**
 * Ball intro: cube warm-up into a floor/ceiling run. Spikes on the floor mean
 * "flip up", hanging spikes mean "flip down", and one floor pit must be
 * crossed upside-down along the ceiling. Transfers need ~200px, hazards sit
 * >= 550px apart.
 */
const LEVEL_5: GeoDashLevel = {
	id: 'level-5',
	name: 'Gravity Grove',
	difficulty: 4,
	bpm: 138,
	lengthPx: 7500,
	objects: [
		floorSeg(0, 3400),
		spike(600),
		...spikeRun(1000, 2),
		pad(1300, 1.4),
		modePortal(1550, 'ball'),
		ceilingSeg(1900, 3400, -200),
		spike(2200),
		spikeCeiling(2750, -200),
		ceilingSeg(3400, 5400, -200),
		floorSeg(3800, 7600),
		spikeCeiling(4400, -200),
		spike(5000),
		ceilingSeg(5400, 6150, -200),
		modePortal(6300, 'cube'),
		spike(6800),
		...spikeRun(7050, 2),
		step(7300, -40, 250),
		{ type: 'deco', x: 400, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 2400, y: -330, kind: 'cloud' },
		{ type: 'deco', x: 4200, y: -330, kind: 'cloud' },
		{ type: 'deco', x: 5800, y: -330, kind: 'cloud' },
		{ type: 'deco', x: 6900, y: -170, kind: 'pillar' }
	]
};

/**
 * Transformation overdrive: cube -> ship -> cube (faster) -> ball -> cube.
 * Each section keeps the same fair rhythms as the intro levels, packed more
 * tightly: ship saws every ~450px, ball flips every ~700px, one pit crossed
 * on the ceiling, and a 1.15x cube sprint in the middle.
 */
const LEVEL_6: GeoDashLevel = {
	id: 'level-6',
	name: 'Transformation Overdrive',
	difficulty: 5,
	bpm: 150,
	lengthPx: 9500,
	objects: [
		floorSeg(0, 3650),
		spike(500),
		...spikeRun(850, 2),
		saw(1150),
		modePortal(1350, 'ship'),
		ceilingSeg(1350, 3650, -190),
		saw(1750),
		sawCeiling(2200, -190),
		saw(2650),
		sawCeiling(3050, -190),
		floorSeg(3650, 7000),
		modePortal(3700, 'cube'),
		speedPortal(3900, 1.15),
		spike(4150),
		...spikeRun(4550, 2),
		saw(4950),
		speedPortal(5150, 1),
		modePortal(5300, 'ball'),
		ceilingSeg(5300, 8400, -200),
		spike(5900),
		spikeCeiling(6600, -200),
		floorSeg(7400, 9600),
		spikeCeiling(7750, -200),
		modePortal(8450, 'cube'),
		spike(8800),
		...spikeRun(9100, 2),
		step(9350, -40, 200),
		{ type: 'deco', x: 350, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 2450, y: -320, kind: 'cloud' },
		{ type: 'deco', x: 4300, y: -230, kind: 'cloud' },
		{ type: 'deco', x: 6200, y: -330, kind: 'cloud' },
		{ type: 'deco', x: 8100, y: -330, kind: 'cloud' },
		{ type: 'deco', x: 8900, y: -170, kind: 'pillar' }
	]
};

/** Every shipped level, in progression order. */
export const LEVELS: readonly GeoDashLevel[] = [
	LEVEL_1,
	LEVEL_2,
	LEVEL_3,
	LEVEL_4,
	LEVEL_5,
	LEVEL_6
];

/** Look up a level by id (undefined when unknown). */
export function getLevel(id: string): GeoDashLevel | undefined {
	return LEVELS.find((level) => level.id === id);
}
