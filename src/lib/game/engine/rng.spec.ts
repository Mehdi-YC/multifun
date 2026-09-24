import { describe, expect, it } from 'vitest';
import { mulberry32, pick, randInt, shuffle } from './rng';

describe('mulberry32', () => {
	it('is deterministic for a given seed', () => {
		const a = mulberry32(1234);
		const b = mulberry32(1234);
		const seqA = Array.from({ length: 16 }, () => a());
		const seqB = Array.from({ length: 16 }, () => b());
		expect(seqA).toEqual(seqB);
	});

	it('produces different sequences for different seeds', () => {
		const a = Array.from({ length: 8 }, mulberry32(1));
		const b = Array.from({ length: 8 }, mulberry32(2));
		expect(a).not.toEqual(b);
	});

	it('stays in [0, 1)', () => {
		const rng = mulberry32(99);
		for (let i = 0; i < 1000; i++) {
			const v = rng();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('randInt', () => {
	it('returns integers within [min, max] inclusive', () => {
		const rng = mulberry32(7);
		for (let i = 0; i < 500; i++) {
			const v = randInt(rng, -3, 5);
			expect(Number.isInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(-3);
			expect(v).toBeLessThanOrEqual(5);
		}
	});

	it('is reproducible from a seed', () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		expect([randInt(a, 0, 100), randInt(a, 0, 100)]).toEqual([
			randInt(b, 0, 100),
			randInt(b, 0, 100)
		]);
	});
});

describe('pick', () => {
	it('returns an element of the list, reproducibly', () => {
		const items = ['a', 'b', 'c', 'd'];
		const a = mulberry32(5);
		const b = mulberry32(5);
		expect(pick(a, items)).toBe(pick(b, items));
		expect(items).toContain(pick(mulberry32(9), items));
	});

	it('throws on an empty list', () => {
		expect(() => pick(mulberry32(1), [])).toThrow();
	});
});

describe('shuffle', () => {
	it('is a deterministic permutation that leaves the input untouched', () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8];
		const copy = items.slice();
		const s1 = shuffle(mulberry32(11), items);
		const s2 = shuffle(mulberry32(11), items);
		expect(s1).toEqual(s2);
		expect(items).toEqual(copy);
		expect(s1.slice().sort((x, y) => x - y)).toEqual(copy);
		expect(s1).not.toBe(items);
	});
});
