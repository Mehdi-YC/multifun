/**
 * Level data tests: every shipped level parses/validates, and a beatability
 * smoke proves the levels are not impossible — an auto-playing bot (jump when
 * a spike/gap is within lookahead distance) drives the real sim and must
 * finish Easy and Normal in at most 3 attempts.
 */
import { describe, expect, it } from 'vitest';
import type { GeoDashObject } from './level-types';
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
		expect(LEVELS.length).toBeGreaterThanOrEqual(3);
		for (const level of LEVELS) {
			const parsed = parseGeoDashLevel(level);
			expect(parsed.ok, `${level.id} should parse`).toBe(true);
			expect(validateGeoDashLevel(level)).toEqual([]);
		}
	});

	it('levels have the expected lengths and difficulties', () => {
		const [easy, normal, hard] = LEVELS;
		expect(easy.lengthPx).toBeGreaterThanOrEqual(2800);
		expect(easy.lengthPx).toBeLessThanOrEqual(3200);
		expect(normal.lengthPx).toBeGreaterThanOrEqual(4300);
		expect(normal.lengthPx).toBeLessThanOrEqual(4700);
		expect(hard.lengthPx).toBeGreaterThanOrEqual(5800);
		expect(hard.lengthPx).toBeLessThanOrEqual(6200);
		expect(easy.difficulty).toBeLessThan(normal.difficulty);
		expect(normal.difficulty).toBeLessThan(hard.difficulty);
		for (const level of LEVELS) expect(level.bpm).toBeGreaterThanOrEqual(40);
	});

	it('objects stay in bounds, run left to right, and solids never overlap', () => {
		for (const level of LEVELS) {
			let lastX = -Infinity;
			for (const obj of level.objects) {
				const at = `${level.id}: ${obj.type}@${obj.x}`;
				expect(obj.x, at).toBeGreaterThanOrEqual(0);
				expect(obj.x, at).toBeLessThanOrEqual(level.lengthPx);
				expect(obj.y, at).toBeGreaterThanOrEqual(-640);
				expect(obj.y, at).toBeLessThanOrEqual(320);
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
}

function botWorld(level: GeoDashLevel): BotWorld {
	const world: BotWorld = { spikes: [], saws: [], blocks: [], pads: [], orbs: [] };
	const spikeRects: Rect[] = [];
	for (const obj of level.objects as GeoDashObject[]) {
		switch (obj.type) {
			case 'block':
				world.blocks.push({ x: obj.x, y: obj.y, ...blockSize(obj) });
				break;
			case 'spike':
				spikeRects.push(spikeHitbox(obj));
				break;
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

/**
 * Lookahead bot: on the ground it jumps when a spike cluster / saw / wall is
 * within one jump distance or a pit edge within ~70px (pads are run into, not
 * jumped); in the air it taps JUMP near a usable orb.
 */
function makeBot(level: GeoDashLevel) {
	const world = botWorld(level);
	let lastPress = -10;
	return (p: GeoDashPlayerState, tick: number): number => {
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
			if (block.y < bottom - 4) return press(); // wall or step up ahead
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
	for (let t = 0; t < cfg.durationTicks && !sim.finished; t++) {
		const p = sim.players[0];
		sim.tickOnce(new Map([['bot', { keys: bot(p, t) }]]));
		sim.drainEvents();
	}
	const p = sim.players[0];
	return { finished: p.finished, attempts: p.attempts, progress: p.maxProgress };
}

describe('geodash level beatability (auto-play bot)', () => {
	it('the bot completes the Easy level in at most 3 attempts', () => {
		const result = playLevel(LEVELS[0]);
		expect(result.progress).toBe(1);
		expect(result.finished).toBe(true);
		expect(result.attempts).toBeLessThanOrEqual(3);
	});

	it('the bot completes the Normal level in at most 3 attempts', () => {
		const result = playLevel(LEVELS[1]);
		expect(result.progress).toBe(1);
		expect(result.finished).toBe(true);
		expect(result.attempts).toBeLessThanOrEqual(3);
	});

	it('the bot completes the Hard level (cube-only beatable)', () => {
		const result = playLevel(LEVELS[2]);
		expect(result.progress).toBe(1);
		expect(result.finished).toBe(true);
		expect(result.attempts).toBeLessThanOrEqual(3);
	});
});
