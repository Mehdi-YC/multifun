/**
 * Level data tests: every shipped level parses/validates, and a beatability
 * smoke proves the levels are not impossible — an auto-playing bot (jump when
 * a spike/gap is within lookahead distance, steer the ship through the safe
 * band, flip the ball past hazards) drives the real sim and must finish every
 * level in at most 3 attempts.
 */
import { describe, expect, it } from 'vitest';
import type { GeoDashMode, GeoDashObject } from './level-types';
import {
	blockSize,
	parseGeoDashLevel,
	spikeHitbox,
	validateGeoDashLevel,
	type GeoDashLevel
} from './level-types';
import { LEVELS, getLevel } from './levels';
import { createGeodashSim, type GeoDashPlayerState } from './sim';
import { KEY } from '../types';

// ---- validation ----

describe('geodash level data', () => {
	it('every shipped level parses and validates with zero errors', () => {
		expect(LEVELS.length).toBeGreaterThanOrEqual(6);
		for (const level of LEVELS) {
			const parsed = parseGeoDashLevel(level);
			expect(parsed.ok, `${level.id} should parse`).toBe(true);
			expect(validateGeoDashLevel(level)).toEqual([]);
		}
	});

	it('levels grow in length along a smooth difficulty curve', () => {
		expect(LEVELS).toHaveLength(6);
		for (let i = 1; i < LEVELS.length; i++) {
			expect(LEVELS[i].lengthPx, `${LEVELS[i].id} length`).toBeGreaterThan(LEVELS[i - 1].lengthPx);
			expect(LEVELS[i].difficulty, `${LEVELS[i].id} difficulty`).toBeGreaterThanOrEqual(
				LEVELS[i - 1].difficulty
			);
			expect(LEVELS[i].difficulty - LEVELS[i - 1].difficulty).toBeLessThanOrEqual(1);
		}
		expect(LEVELS[0].difficulty).toBe(1);
		expect(LEVELS[5].difficulty).toBe(5);
		for (const level of LEVELS) expect(level.bpm).toBeGreaterThanOrEqual(40);
	});

	it('the first three levels keep their ids and introduce no forms', () => {
		expect(LEVELS.slice(0, 3).map((level) => level.id)).toEqual(['level-1', 'level-2', 'level-3']);
		for (const level of LEVELS.slice(0, 3)) {
			expect(
				level.objects.some((obj) => obj.type === 'portal'),
				level.id
			).toBe(false);
		}
	});

	it('level-4 introduces ship, level-5 ball, level-6 mixes all forms', () => {
		const forms = (level: GeoDashLevel): GeoDashMode[] => {
			const out: GeoDashMode[] = ['cube'];
			for (const obj of level.objects) {
				if (obj.type === 'portal' && out[out.length - 1] !== obj.mode) out.push(obj.mode);
			}
			return out;
		};
		expect(forms(LEVELS[3])).toEqual(['cube', 'ship', 'cube']);
		expect(forms(LEVELS[4])).toEqual(['cube', 'ball', 'cube']);
		expect(forms(LEVELS[5])).toEqual(['cube', 'ship', 'cube', 'ball', 'cube']);
	});

	it('objects stay in bounds, run left to right, and solids never overlap', () => {
		for (const level of LEVELS) {
			let lastX = -Infinity;
			for (const obj of level.objects) {
				const at = `${level.id}: ${obj.type}@${obj.x}`;
				expect(obj.x, at).toBeGreaterThanOrEqual(0);
				expect(obj.x, at).toBeLessThanOrEqual(level.lengthPx);
				if ('y' in obj) {
					expect(obj.y, at).toBeGreaterThanOrEqual(-640);
					expect(obj.y, at).toBeLessThanOrEqual(320);
				}
				if (obj.type !== 'deco') {
					expect(obj.x, at).toBeGreaterThanOrEqual(lastX);
					lastX = obj.x;
				}
			}
			const solids = level.objects
				.map((obj, index) => ({ obj, index }))
				.filter((entry) => entry.obj.type === 'block');
			for (let i = 0; i < solids.length; i++) {
				for (let j = i + 1; j < solids.length; j++) {
					const a = solids[i].obj;
					const b = solids[j].obj;
					if (a.type !== 'block' || b.type !== 'block') continue;
					const ar = { x: a.x, y: a.y, ...blockSize(a) };
					const br = { x: b.x, y: b.y, ...blockSize(b) };
					const overlap =
						ar.x < br.x + br.w && br.x < ar.x + ar.w && ar.y < br.y + br.h && br.y < ar.y + ar.h;
					expect(overlap, `solids ${solids[i].index}/${solids[j].index}`).toBe(false);
				}
			}
		}
	});

	it('getLevel resolves ids and LEVELS ids are unique', () => {
		const ids = LEVELS.map((level) => level.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(getLevel(id)?.id).toBe(id);
		expect(getLevel('nope')).toBeUndefined();
	});
});

// ---- beatability smoke: auto-playing bot on the real sim ----

type Rect = { x: number; y: number; w: number; h: number };

interface BotWorld {
	spikes: Rect[][];
	saws: { x: number; y: number; r: number }[];
	blocks: Rect[];
	pads: { x: number; w: number }[];
	orbs: { x: number; y: number; index: number }[];
	/** Ground blocks (top at/below y = 0): where the player can stand/roll. */
	floors: Rect[];
	/** Overhead blocks (bottom at/below y = -150): ship/ball ceilings. */
	ceilings: Rect[];
	/** Deadly spike hitboxes attached to the floor side (y >= -60). */
	floorHazards: Rect[];
	/** Deadly spike hitboxes hanging from above (y < -60). */
	ceilingHazards: Rect[];
}

function botWorld(level: GeoDashLevel): BotWorld {
	const world: BotWorld = {
		spikes: [],
		saws: [],
		blocks: [],
		pads: [],
		orbs: [],
		floors: [],
		ceilings: [],
		floorHazards: [],
		ceilingHazards: []
	};
	const spikeRects: Rect[] = [];
	for (const obj of level.objects as GeoDashObject[]) {
		switch (obj.type) {
			case 'block': {
				const rect = { x: obj.x, y: obj.y, ...blockSize(obj) };
				world.blocks.push(rect);
				if (rect.y >= 0) world.floors.push(rect);
				if (rect.y + rect.h <= -150) world.ceilings.push(rect);
				break;
			}
			case 'spike': {
				const hit = spikeHitbox(obj);
				spikeRects.push(hit);
				if (hit.y >= -60) world.floorHazards.push(hit);
				else world.ceilingHazards.push(hit);
				break;
			}
			case 'saw':
				world.saws.push({ x: obj.x, y: obj.y, r: obj.r ?? 22 });
				break;
			case 'pad':
				world.pads.push({ x: obj.x, w: 40 });
				break;
			case 'orb':
				world.orbs.push({ x: obj.x, y: obj.y, index: world.orbs.length });
				break;
			default:
				break;
		}
	}
	// Group spikes into clusters: one jump clears one cluster.
	spikeRects.sort((a, b) => a.x - b.x);
	for (const rect of spikeRects) {
		const last = world.spikes[world.spikes.length - 1];
		if (last && rect.x - last[last.length - 1].x < 40) last.push(rect);
		else world.spikes.push([rect]);
	}
	return world;
}

/** Do the rects cover the whole [a, b] x range? */
function covers(rects: Rect[], a: number, b: number): boolean {
	return rects.some((rect) => rect.x <= a && rect.x + rect.w >= b);
}

function hazardIn(rects: Rect[], a: number, b: number): boolean {
	return rects.some((rect) => rect.x + rect.w > a && rect.x < b);
}

function sawIn(
	saws: { x: number; y: number; r: number }[],
	floorSide: boolean,
	a: number,
	b: number
): boolean {
	return saws.some((s) => s.y >= -60 === floorSide && s.x + s.r > a && s.x - s.r < b);
}

/**
 * Ship pilot: derive the safe vertical band from everything in a ~340px
 * lookahead (pass above floor-side obstacles, below ceiling-side ones) and
 * thrust toward the band's center with a velocity-damped bang-bang.
 */
function shipControl(p: GeoDashPlayerState, world: BotWorld): number {
	const margin = 6;
	const from = p.x - 20;
	const to = p.x + 340;
	let yLo = -400;
	let yHi = -30;
	for (const block of world.blocks) {
		if (block.x + block.w <= from || block.x >= to) continue;
		if (block.y + block.h >= -60) yHi = Math.min(yHi, block.y - 30 - margin);
		else yLo = Math.max(yLo, block.y + block.h + margin);
	}
	for (const s of world.saws) {
		if (s.x + s.r <= from || s.x - s.r >= to) continue;
		if (s.y >= -60) yHi = Math.min(yHi, s.y - s.r * 0.85 - 30 - margin);
		else yLo = Math.max(yLo, s.y + s.r * 0.85 + margin);
	}
	for (const cluster of world.spikes) {
		for (const s of cluster) {
			if (s.x + s.w <= from || s.x >= to) continue;
			if (s.y >= -60) yHi = Math.min(yHi, s.y - 30 - margin);
			else yLo = Math.max(yLo, s.y + s.h + margin);
		}
	}
	const target = (yLo + yHi) / 2;
	return p.y - target + 7 * p.vy > 0 ? KEY.JUMP : 0;
}

/**
 * Ball pilot: floor spikes/pits ahead -> flip up; ceiling spikes/ceiling end
 * ahead -> flip down. Flips only when the destination surface is covered and
 * hazard-free over the whole transfer (~200px + landing room).
 */
function ballControl(p: GeoDashPlayerState, world: BotWorld): number {
	if (!p.onGround) return 0;
	const onCeiling = p.gravityDir === -1;
	const near: [number, number] = [p.x + 40, p.x + 320];
	const dangerHere = (floorSide: boolean): boolean => {
		const rects = floorSide ? world.floorHazards : world.ceilingHazards;
		const saws = world.saws.filter((s) => s.y >= -60 === floorSide);
		return hazardIn(rects, near[0], near[1]) || sawIn(saws, floorSide, near[0], near[1]);
	};
	if (!onCeiling) {
		const danger = dangerHere(true) || !covers(world.floors, p.x + 30, p.x + 140);
		if (!danger) return 0;
		if (!covers(world.ceilings, p.x + 50, p.x + 700)) return 0;
		if (dangerHere(false) || hazardIn(world.ceilingHazards, p.x, p.x + 650)) return 0;
		if (sawIn(world.saws, false, p.x, p.x + 650)) return 0;
		return KEY.JUMP;
	}
	const danger = dangerHere(false) || !covers(world.ceilings, p.x + 30, p.x + 140);
	if (!danger) return 0;
	if (!covers(world.floors, p.x + 50, p.x + 700)) return 0;
	if (dangerHere(true) || hazardIn(world.floorHazards, p.x, p.x + 650)) return 0;
	if (sawIn(world.saws, true, p.x, p.x + 650)) return 0;
	return KEY.JUMP;
}

/**
 * Lookahead cube bot: on the ground it jumps when a spike cluster / saw / wall
 * is within one jump distance or a pit edge within ~70px (pads are run into,
 * not jumped); in the air it taps JUMP near a usable orb.
 */
function makeBot(level: GeoDashLevel) {
	const world = botWorld(level);
	let lastPress = -10;
	return (p: GeoDashPlayerState, tick: number): number => {
		if (p.mode === 'ship') return shipControl(p, world);
		if (p.mode === 'ball') return ballControl(p, world);
		const press = () => {
			lastPress = tick;
			return KEY.JUMP;
		};
		if (!p.onGround && p.coyote === 0) {
			for (const orb of world.orbs) {
				if ((p.orbUsed & (1 << orb.index)) !== 0) continue;
				const dx = orb.x - (p.x + 15);
				const dy = orb.y - (p.y + 15);
				if (dx * dx + dy * dy <= 40 * 40 && tick - lastPress >= 2) return press();
			}
			return 0;
		}
		const mult = p.speedMult;
		const look = 150 * mult;
		const bottom = p.y + 30;

		// Run into pads instead of jumping over them.
		for (const pad of world.pads) {
			if (pad.x + pad.w > p.x && pad.x - p.x <= 100 * mult) return 0;
		}
		for (const cluster of world.spikes) {
			const far = cluster[cluster.length - 1].x + cluster[cluster.length - 1].w;
			if (far > p.x && far - p.x <= look) return press();
		}
		for (const saw of world.saws) {
			const near = saw.x - saw.r;
			if (near > p.x - 30 && near - p.x <= look) return press();
		}
		for (const block of world.blocks) {
			if (block.x <= p.x || block.x - p.x > look) continue;
			// wall or step up ahead (blocks fully overhead are not in the way)
			if (block.y + block.h > p.y + 4 && block.y < bottom - 4) return press();
		}
		// Pit: no floor at the player's level in the near window.
		const from = p.x + 25;
		const to = p.x + 70 * mult;
		const grounded = world.blocks.some(
			(block) => Math.abs(block.y - bottom) <= 4 && block.x <= from && block.x + block.w >= to
		);
		if (!grounded) return press();
		return 0;
	};
}

function playLevel(level: GeoDashLevel, seed = 42) {
	const cfg = {
		tickRate: 60,
		durationTicks: 60 * 120,
		options: { countdownTicks: 0, level }
	};
	const sim = createGeodashSim(seed, cfg, [{ id: 'bot', name: 'Bot', color: '#fff', slot: 0 }]);
	const bot = makeBot(level);
	const deathCauses: string[] = [];
	for (let t = 0; t < cfg.durationTicks && !sim.finished; t++) {
		const p = sim.players[0];
		sim.tickOnce(new Map([['bot', { keys: bot(p, t) }]]));
		for (const ev of sim.drainEvents()) if (ev.kind === 'death') deathCauses.push(ev.cause);
	}
	const p = sim.players[0];
	return { finished: p.finished, attempts: p.attempts, progress: p.maxProgress, deathCauses };
}

describe('geodash level beatability (auto-play bot)', () => {
	for (const level of LEVELS) {
		it(`the bot completes ${level.id} "${level.name}" in at most 3 attempts`, () => {
			const result = playLevel(level);
			expect(result.progress, `${level.id} progress`).toBe(1);
			expect(result.finished, `${level.id} finished`).toBe(true);
			expect(result.attempts, `${level.id} attempts`).toBeLessThanOrEqual(3);
			expect(result.deathCauses, `${level.id} deaths`).toEqual([]);
		});
	}
});
