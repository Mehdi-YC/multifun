/**
 * GeoDash level format: types, schema + parser, and semantic validation.
 *
 * COORDINATE CONVENTION (the one convention for everything in geodash):
 * - World units are pixels; the grid cell is 40px.
 * - y grows DOWNWARD (screen-style). y = 0 is the top surface of the ground
 *   ("ground line"): the solid ground occupies y >= 0 and the playable air is
 *   y < 0. Gravity pulls toward +y; a jump sets negative vy (up).
 * - The floor is not implicit: it is built from `block` objects anchored at
 *   y = 0 (a floor segment with h = 80 occupies y in [0, 80]). Where no floor
 *   block exists there is a pit — falling past the sim's fall limit is death.
 * - Objects are anchored at the TOP-LEFT corner of their cell: a block at
 *   (x, y) with size (w, h) occupies [x, x+w] x [y, y+h]. A block resting on
 *   the ground has y = -h; a spike sitting on the ground has y = -40.
 */
import { z } from 'zod';

export const GRID = 40;
export const CUBE_SIZE = 30;

export type GeoDashDifficulty = 1 | 2 | 3 | 4 | 5;

/** Player forms switched by mode portals. */
export type GeoDashMode = 'cube' | 'ship' | 'ball';

export type GeoDashObject =
	| { type: 'block'; x: number; y: number; w?: number; h?: number }
	| { type: 'spike'; x: number; y: number; flip?: boolean }
	| { type: 'saw'; x: number; y: number; r?: number; spin?: number }
	| { type: 'pad'; x: number; y: number; power: number }
	| { type: 'orb'; x: number; y: number }
	| { type: 'speed'; x: number; y: number; mult: number }
	| { type: 'gravity'; x: number; y: number; flip: boolean }
	| { type: 'portal'; x: number; mode: GeoDashMode }
	| { type: 'deco'; x: number; y: number; kind: 'pillar' | 'tree' | 'cloud' };

export interface GeoDashLevel {
	id: string;
	name: string;
	difficulty: GeoDashDifficulty;
	/** Music sync pulses per minute; drives background beat pulses. */
	bpm: number;
	/** World width; the finish line is at x = lengthPx. */
	lengthPx: number;
	objects: GeoDashObject[];
}

// ---- structural parsing (zod at the trust boundary) ----

const coord = z.number().finite();
const size = z.number().finite().positive();

const blockSchema = z.strictObject({
	type: z.literal('block'),
	x: coord,
	y: coord,
	w: size.optional(),
	h: size.optional()
});

const spikeSchema = z.strictObject({
	type: z.literal('spike'),
	x: coord,
	y: coord,
	flip: z.boolean().optional()
});

const sawSchema = z.strictObject({
	type: z.literal('saw'),
	x: coord,
	y: coord,
	r: size.optional(),
	spin: z.number().finite().optional()
});

const padSchema = z.strictObject({
	type: z.literal('pad'),
	x: coord,
	y: coord,
	power: z.number().finite().positive()
});

const orbSchema = z.strictObject({
	type: z.literal('orb'),
	x: coord,
	y: coord
});

const speedSchema = z.strictObject({
	type: z.literal('speed'),
	x: coord,
	y: coord,
	mult: z.number().finite().positive()
});

const gravitySchema = z.strictObject({
	type: z.literal('gravity'),
	x: coord,
	y: coord,
	flip: z.boolean()
});

const portalSchema = z.strictObject({
	type: z.literal('portal'),
	x: coord,
	mode: z.enum(['cube', 'ship', 'ball'])
});

const decoSchema = z.strictObject({
	type: z.literal('deco'),
	x: coord,
	y: coord,
	kind: z.enum(['pillar', 'tree', 'cloud'])
});

const objectSchema = z.discriminatedUnion('type', [
	blockSchema,
	spikeSchema,
	sawSchema,
	padSchema,
	orbSchema,
	speedSchema,
	gravitySchema,
	portalSchema,
	decoSchema
]);

const difficultySchema = z.union([
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5)
]);

const levelSchema = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(64),
	difficulty: difficultySchema,
	bpm: z.number().finite().min(40).max(240),
	lengthPx: z
		.number()
		.finite()
		.min(GRID * 5),
	objects: z.array(objectSchema).max(2048)
});

export type LevelParseResult = { ok: true; level: GeoDashLevel } | { ok: false; errors: string[] };

/** Max orbs / speed / mode portals a level may contain (sim keeps 32-bit usage masks). */
export const MAX_MASKED_OBJECTS = 32;

/** Default size of a block when w/h are omitted: one 40px grid cell. */
export function blockSize(block: { w?: number; h?: number }): { w: number; h: number } {
	return { w: block.w ?? GRID, h: block.h ?? GRID };
}

/** The deadly hitbox of a spike inside its 40x40 cell (forgiving sides). */
export function spikeHitbox(spike: { x: number; y: number; flip?: boolean }): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	const w = GRID - 18; // 22px wide: triangles are forgiving at the corners
	if (spike.flip) return { x: spike.x + 9, y: spike.y, w, h: GRID - 12 };
	return { x: spike.x + 9, y: spike.y + 12, w, h: GRID - 12 };
}

/** Pad plate rect: 40 wide, 8 tall, anchored top-left at (x, y). */
export function padRect(pad: { x: number; y: number }): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	return { x: pad.x, y: pad.y, w: GRID, h: 8 };
}

/** Orb pickup box: a 44x44 box centered on the orb. */
export function orbBox(orb: { x: number; y: number }): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	return { x: orb.x - 22, y: orb.y - 22, w: 44, h: 44 };
}

/**
 * The gate column a mode portal occupies: a thin full-air-band bar the player
 * flies/rolls/jumps through. Portals trigger on crossing their x plane, and
 * no solid may intersect the gate (see validateGeoDashLevel).
 */
export function portalGate(portal: { x: number }): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	return { x: portal.x - 8, y: -160, w: 24, h: 160 };
}

/** Parse + semantically validate untyped level data (e.g. from JSON or config). */
export function parseGeoDashLevel(value: unknown): LevelParseResult {
	const structural = levelSchema.safeParse(value);
	if (!structural.success) {
		return {
			ok: false,
			errors: structural.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
		};
	}
	const level = structural.data as GeoDashLevel;
	const semantic = validateGeoDashLevel(level);
	if (semantic.length > 0) return { ok: false, errors: semantic };
	return { ok: true, level };
}

/** Parse a JSON string into a validated level. */
export function parseGeoDashLevelJson(json: string): LevelParseResult {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (err) {
		return { ok: false, errors: [`json: ${err instanceof Error ? err.message : 'invalid'}`] };
	}
	return parseGeoDashLevel(value);
}

/**
 * Semantic checks on an already-structurally-valid level: object bounds,
 * x ordering ("monotonic-ish": non-deco objects never move backwards), mode
 * portals ordered with clear spacing and free of solids, and no overlapping
 * solids. Returns a list of human-readable errors (empty = ok).
 */
export function validateGeoDashLevel(level: GeoDashLevel): string[] {
	const errors: string[] = [];
	let orbs = 0;
	let portals = 0;
	let modePortals = 0;
	let lastX = -Infinity;
	let lastModePortalX = -Infinity;

	// Blocks are known up front so portal gates can be checked against solids
	// regardless of object order.
	const blocks: { x: number; y: number; w: number; h: number }[] = [];
	for (const obj of level.objects) {
		if (obj.type === 'block') blocks.push({ x: obj.x, y: obj.y, ...blockSize(obj) });
	}

	for (let i = 0; i < level.objects.length; i++) {
		const obj = level.objects[i];
		const at = `objects[${i}] (${obj.type})`;
		if (obj.x < 0 || obj.x > level.lengthPx) {
			errors.push(`${at}: x ${obj.x} outside [0, ${level.lengthPx}]`);
		}
		if ('y' in obj && (obj.y < -GRID * 16 || obj.y > GRID * 8)) {
			errors.push(`${at}: y ${obj.y} outside the playable band`);
		}
		if (obj.type !== 'deco' && obj.x < lastX) {
			errors.push(`${at}: x ${obj.x} moves backwards (objects must be sorted by x)`);
		}
		if (obj.type !== 'deco') lastX = obj.x;

		switch (obj.type) {
			case 'block': {
				const { w, h } = blockSize(obj);
				if (w > GRID * 150 || h > GRID * 8) errors.push(`${at}: block ${w}x${h} too large`);
				break;
			}
			case 'saw': {
				const r = obj.r ?? 22;
				if (r > GRID * 2) errors.push(`${at}: saw radius ${r} too large`);
				break;
			}
			case 'pad': {
				if (obj.power < 0.5 || obj.power > 3)
					errors.push(`${at}: pad power ${obj.power} outside [0.5, 3]`);
				break;
			}
			case 'speed': {
				if (obj.mult < 0.4 || obj.mult > 2)
					errors.push(`${at}: speed mult ${obj.mult} outside [0.4, 2]`);
				portals++;
				break;
			}
			case 'orb': {
				orbs++;
				break;
			}
			case 'portal': {
				modePortals++;
				if (obj.x < lastModePortalX + GRID) {
					errors.push(
						`${at}: mode portal at x ${obj.x} too close to the previous portal (min ${GRID}px apart)`
					);
				}
				lastModePortalX = obj.x;
				const gate = portalGate(obj);
				for (const block of blocks) {
					const overlap =
						gate.x < block.x + block.w &&
						block.x < gate.x + gate.w &&
						gate.y < block.y + block.h &&
						block.y < gate.y + gate.h;
					if (overlap) {
						errors.push(`${at}: portal gate overlaps a solid block`);
						break;
					}
				}
				break;
			}
			default:
				break;
		}
	}

	if (orbs > MAX_MASKED_OBJECTS) errors.push(`level has ${orbs} orbs (max ${MAX_MASKED_OBJECTS})`);
	if (portals > MAX_MASKED_OBJECTS) {
		errors.push(`level has ${portals} speed portals (max ${MAX_MASKED_OBJECTS})`);
	}
	if (modePortals > MAX_MASKED_OBJECTS) {
		errors.push(`level has ${modePortals} mode portals (max ${MAX_MASKED_OBJECTS})`);
	}

	for (const overlap of findOverlappingSolids(level)) {
		errors.push(`objects[${overlap.a}] and objects[${overlap.b}]: overlapping solids`);
	}

	return errors;
}

function solidRect(obj: GeoDashObject): { x: number; y: number; w: number; h: number } | null {
	if (obj.type !== 'block') return null;
	const { w, h } = blockSize(obj);
	return { x: obj.x, y: obj.y, w, h };
}

/** Pairs of block indexes whose rectangles strictly intersect. */
export function findOverlappingSolids(level: GeoDashLevel): { a: number; b: number }[] {
	const out: { a: number; b: number }[] = [];
	const solids: { index: number; rect: { x: number; y: number; w: number; h: number } }[] = [];
	level.objects.forEach((obj, index) => {
		const rect = solidRect(obj);
		if (rect) solids.push({ index, rect });
	});
	for (let i = 0; i < solids.length; i++) {
		for (let j = i + 1; j < solids.length; j++) {
			const a = solids[i];
			const b = solids[j];
			const overlap =
				a.rect.x < b.rect.x + b.rect.w &&
				b.rect.x < a.rect.x + a.rect.w &&
				a.rect.y < b.rect.y + b.rect.h &&
				b.rect.y < a.rect.y + a.rect.h;
			if (overlap) out.push({ a: a.index, b: b.index });
		}
	}
	return out;
}
