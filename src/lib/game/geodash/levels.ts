/**
 * Handcrafted GeoDash levels as plain data.
 *
 * COORDINATE CONVENTION (see level-types.ts): y grows downward, the ground
 * surface is y = 0, and objects anchor at their top-left corner. The floor is
 * made of `block` objects at y = 0 (see `floorSeg`), so missing floor = pit.
 *
 * Levels are built by composing patterns (see plan.md §7):
 * spike runs, staircases of blocks, jump-pad launches over gaps, saw
 * corridors, orb chains. Every level is beatable with a pure cube character —
 * levels.spec.ts proves it with an auto-playing bot driving the real sim.
 */
import type { GeoDashLevel, GeoDashObject } from './level-types';
import { GRID } from './level-types';

// ---- pattern helpers (all return plain GeoDashObject data) ----

/** A floor segment from x0 to x1: solid ground occupying y in [0, 80]. */
function floorSeg(x0: number, x1: number): GeoDashObject {
	return { type: 'block', x: x0, y: 0, w: x1 - x0, h: 80 };
}

/** A grounded spike: 40x40 cell sitting on the ground (base at y = 0). */
function spike(x: number): GeoDashObject {
	return { type: 'spike', x, y: -GRID };
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

/** A jump pad plate on the ground (power 1.4 = yellow, 1.8 = pink). */
function pad(x: number, power: number): GeoDashObject {
	return { type: 'pad', x, y: -8, power };
}

/** A speed portal bar standing on the ground. */
function speedPortal(x: number, mult: number): GeoDashObject {
	return { type: 'speed', x, y: -140, mult };
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
	difficulty: 3,
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
	difficulty: 5,
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

/** Every shipped level, in progression order. */
export const LEVELS: readonly GeoDashLevel[] = [LEVEL_1, LEVEL_2, LEVEL_3];

/** Look up a level by id (undefined when unknown). */
export function getLevel(id: string): GeoDashLevel | undefined {
	return LEVELS.find((level) => level.id === id);
}
