/**
 * Level format parser/validator tests: malformed data must be rejected with
 * useful errors, valid data passes through unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
	parseGeoDashLevel,
	parseGeoDashLevelJson,
	validateGeoDashLevel,
	type GeoDashLevel
} from './level-types';

function baseLevel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'level-x',
		name: 'Test',
		difficulty: 2,
		bpm: 120,
		lengthPx: 1000,
		objects: [{ type: 'block', x: 0, y: 0, w: 1000, h: 80 }],
		...overrides
	};
}

describe('geodash level parser', () => {
	it('accepts a minimal valid level and echoes the data', () => {
		const result = parseGeoDashLevel(baseLevel());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.level.id).toBe('level-x');
		expect(result.level.objects).toHaveLength(1);
	});

	it('accepts every object type with its required fields', () => {
		const result = parseGeoDashLevel(
			baseLevel({
				objects: [
					{ type: 'block', x: 0, y: 0, w: 400, h: 80 },
					{ type: 'spike', x: 400, y: -40 },
					{ type: 'spike', x: 440, y: -80, flip: true },
					{ type: 'saw', x: 520, y: -22, r: 22, spin: 1 },
					{ type: 'pad', x: 600, y: -8, power: 1.4 },
					{ type: 'orb', x: 680, y: -110 },
					{ type: 'speed', x: 760, y: -140, mult: 1.3 },
					{ type: 'gravity', x: 840, y: -140, flip: true },
					{ type: 'deco', x: 920, y: -200, kind: 'cloud' }
				]
			})
		);
		expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
	});

	it('rejects non-objects and null', () => {
		for (const bad of [null, undefined, 42, 'level', [], true]) {
			const result = parseGeoDashLevel(bad);
			expect(result.ok, JSON.stringify(bad)).toBe(false);
		}
	});

	it('rejects missing or mistyped top-level fields', () => {
		const cases: Record<string, unknown>[] = [
			baseLevel({ id: '' }),
			baseLevel({ id: 7 }),
			baseLevel({ name: undefined }),
			baseLevel({ difficulty: 0 }),
			baseLevel({ difficulty: 6 }),
			baseLevel({ difficulty: 'hard' }),
			baseLevel({ bpm: 1000 }),
			baseLevel({ bpm: 'fast' }),
			baseLevel({ lengthPx: 10 }),
			baseLevel({ lengthPx: Infinity }),
			baseLevel({ objects: 'spikes' })
		];
		for (const value of cases) {
			const result = parseGeoDashLevel(value);
			expect(result.ok, JSON.stringify(value)).toBe(false);
		}
	});

	it('rejects malformed objects', () => {
		const cases: unknown[] = [
			{ type: 'lava', x: 0, y: 0 },
			{ type: 'block', x: 'zero', y: 0 },
			{ type: 'block', x: 0, y: NaN },
			{ type: 'block', x: 0, y: 0, w: -40 },
			{ type: 'block', x: 0, y: 0, h: 0 },
			{ type: 'spike', x: 0 },
			{ type: 'spike', x: 0, y: 0, flip: 'yes' },
			{ type: 'saw', x: 0, y: 0, r: -1 },
			{ type: 'pad', x: 0, y: 0 },
			{ type: 'pad', x: 0, y: 0, power: 'big' },
			{ type: 'orb', x: 0 },
			{ type: 'speed', x: 0, y: 0 },
			{ type: 'speed', x: 0, y: 0, mult: 'fast' },
			{ type: 'gravity', x: 0, y: 0 },
			{ type: 'gravity', x: 0, y: 0, flip: 1 },
			{ type: 'deco', x: 0, y: 0, kind: 'statue' },
			{ type: 'deco', x: 0, y: 0 }
		];
		for (const obj of cases) {
			const result = parseGeoDashLevel(baseLevel({ objects: [obj] }));
			expect(result.ok, JSON.stringify(obj)).toBe(false);
		}
	});

	it('rejects unknown keys (typos must not slip through)', () => {
		const result = parseGeoDashLevel(
			baseLevel({ objects: [{ type: 'block', x: 0, y: 0, wigth: 40 }] })
		);
		expect(result.ok).toBe(false);
		const topLevel = parseGeoDashLevel(baseLevel({ lenghtPx: 1000 }));
		expect(topLevel.ok).toBe(false);
	});
});

describe('geodash level semantic validation', () => {
	const clean = (): GeoDashLevel => ({
		id: 'level-y',
		name: 'Clean',
		difficulty: 3,
		bpm: 140,
		lengthPx: 1000,
		objects: [
			{ type: 'block', x: 0, y: 0, w: 500, h: 80 },
			{ type: 'spike', x: 300, y: -40 },
			{ type: 'block', x: 600, y: 0, w: 400, h: 80 }
		]
	});

	it('accepts a clean level', () => {
		expect(validateGeoDashLevel(clean())).toEqual([]);
	});

	it('rejects objects outside the level bounds', () => {
		const level = clean();
		level.objects.push({ type: 'spike', x: 1200, y: -40 });
		expect(validateGeoDashLevel(level).join(' ')).toMatch(/outside/);
	});

	it('rejects objects that run backwards in x', () => {
		const level = clean();
		level.objects.push({ type: 'spike', x: 100, y: -40 });
		expect(validateGeoDashLevel(level).join(' ')).toMatch(/backwards/);
	});

	it('rejects overlapping solids', () => {
		const level = clean();
		level.objects.push({ type: 'block', x: 700, y: -40, w: 80, h: 80 });
		expect(validateGeoDashLevel(level).join(' ')).toMatch(/overlapping solids/);
	});

	it('rejects too many orbs or portals for the usage bitmasks', () => {
		const level = clean();
		for (let i = 0; i < 33; i++) level.objects.push({ type: 'orb', x: 900 + i, y: -100 });
		expect(validateGeoDashLevel(level).join(' ')).toMatch(/max 32/);
	});

	it('rejects out-of-range pad power and speed mult', () => {
		const level = clean();
		level.objects.push({ type: 'pad', x: 900, y: -8, power: 99 });
		level.objects.push({ type: 'speed', x: 950, y: -140, mult: 0 });
		const errors = validateGeoDashLevel(level).join(' ');
		expect(errors).toMatch(/pad power/);
		expect(errors).toMatch(/speed mult/);
	});
});

describe('geodash level JSON parsing', () => {
	it('parses valid JSON', () => {
		const result = parseGeoDashLevelJson(JSON.stringify(baseLevel()));
		expect(result.ok).toBe(true);
	});

	it('rejects broken JSON and wrong shapes', () => {
		expect(parseGeoDashLevelJson('{ nope').ok).toBe(false);
		expect(parseGeoDashLevelJson('[]').ok).toBe(false);
		expect(parseGeoDashLevelJson('"level"').ok).toBe(false);
	});
});
