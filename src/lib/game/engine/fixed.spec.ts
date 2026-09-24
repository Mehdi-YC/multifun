import { afterEach, describe, expect, it } from 'vitest';
import {
	TICK_MS,
	approach,
	clamp,
	integrate,
	lerp,
	nowMs,
	setNowSource,
	stepVelocity
} from './fixed';

afterEach(() => {
	setNowSource(null);
});

describe('TICK_MS', () => {
	it('matches 1000 / tickRate', () => {
		expect(TICK_MS(60)).toBeCloseTo(1000 / 60, 12);
		expect(TICK_MS(10)).toBe(100);
	});
});

describe('nowMs', () => {
	it('respects the injected clock and restores the default', () => {
		setNowSource(() => 42);
		expect(nowMs()).toBe(42);
		setNowSource(null);
		expect(Number.isFinite(nowMs())).toBe(true);
	});
});

describe('lerp', () => {
	it('interpolates and extrapolates exactly at the endpoints', () => {
		expect(lerp(0, 10, 0)).toBe(0);
		expect(lerp(0, 10, 1)).toBe(10);
		expect(lerp(0, 10, 0.5)).toBe(5);
		expect(lerp(10, 20, 2)).toBe(30);
	});
});

describe('clamp', () => {
	it('clamps below, inside and above the range', () => {
		expect(clamp(-1, 0, 10)).toBe(0);
		expect(clamp(5, 0, 10)).toBe(5);
		expect(clamp(11, 0, 10)).toBe(10);
	});
});

describe('approach', () => {
	it('moves at most maxDelta and never overshoots', () => {
		expect(approach(0, 10, 3)).toBe(3);
		expect(approach(9, 10, 3)).toBe(10);
		expect(approach(10, 0, 4)).toBe(6);
		expect(approach(1, 0, 4)).toBe(0);
		expect(approach(5, 10, 0)).toBe(5);
	});
});

describe('integrate', () => {
	it('uses explicit ordering: pos + (vel * dt)', () => {
		expect(integrate(10, 4, 0.5)).toBe(12);
		expect(integrate(0, 3, 0.25)).toBe(3 * 0.25);
		expect(integrate(0, 0, 1)).toBe(0);
	});

	it('is bit-exact with the same expression in the same order', () => {
		const pos = 1 / 3;
		const vel = 2 / 7;
		const dt = 1 / 60;
		expect(integrate(pos, vel, dt)).toBe(pos + vel * dt);
	});
});

describe('stepVelocity', () => {
	it('uses explicit ordering: vel + (accel * dt)', () => {
		expect(stepVelocity(5, 10, 0.5)).toBe(10);
		expect(stepVelocity(0, 3, 0.25)).toBe(3 * 0.25);
	});
});
