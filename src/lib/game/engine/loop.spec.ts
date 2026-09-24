import { describe, expect, it } from 'vitest';
import { FixedTimestepLoop } from './loop';

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(tickRate: number, maxCatchUpTicks?: number) {
	let now = 0;
	let pending: ((t: number) => void) | null = null;
	let nextHandle = 0;
	const ticks: number[] = [];
	const renders: { alpha: number; tick: number }[] = [];
	const loop = new FixedTimestepLoop({
		tickRate,
		onTick: (tick) => ticks.push(tick),
		onRender: (alpha, tick) => renders.push({ alpha, tick }),
		raf: (cb) => {
			pending = cb;
			return ++nextHandle;
		},
		caf: () => {
			pending = null;
		},
		now: () => now,
		maxCatchUpTicks
	});
	/** Drive one animation frame at time t. */
	const pump = (t: number) => {
		now = t;
		const cb = pending;
		pending = null;
		cb?.(t);
	};
	const hasPendingFrame = () => pending !== null;
	return { loop, ticks, renders, pump, hasPendingFrame };
}

describe('FixedTimestepLoop', () => {
	it('accumulates ticks at the fixed rate and renders with alpha', () => {
		const h: Harness = makeHarness(10); // tickMs = 100
		h.loop.start();
		expect(h.loop.running).toBe(true);

		h.pump(350);
		expect(h.ticks).toEqual([0, 1, 2]);
		expect(h.loop.tickCount).toBe(3);
		expect(h.loop.frameCount).toBe(1);
		expect(h.loop.droppedTicks).toBe(0);
		expect(h.renders).toEqual([{ alpha: 0.5, tick: 3 }]);

		h.pump(800); // time 800 = +450ms => 5 more ticks, alpha 0
		expect(h.ticks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(h.renders[1]).toEqual({ alpha: 0, tick: 8 });
	});

	it('clamps catch-up to maxCatchUpTicks and counts dropped ticks', () => {
		const h: Harness = makeHarness(10);
		h.loop.start();
		h.pump(2500); // 25 ticks' worth of time in one frame
		expect(h.ticks).toHaveLength(5);
		expect(h.loop.droppedTicks).toBe(20);
		expect(h.loop.tickCount).toBe(5);
		expect(h.loop.frameCount).toBe(1);
	});

	it('honours a custom maxCatchUpTicks', () => {
		const h: Harness = makeHarness(10, 3);
		h.loop.start();
		h.pump(1000);
		expect(h.ticks).toHaveLength(3);
		expect(h.loop.droppedTicks).toBe(7);
	});

	it('stop() halts ticking and cancels the pending frame', () => {
		const h: Harness = makeHarness(10);
		h.loop.start();
		h.pump(100);
		expect(h.ticks).toHaveLength(1);

		h.loop.stop();
		expect(h.loop.running).toBe(false);
		expect(h.hasPendingFrame()).toBe(false);

		h.pump(5000);
		expect(h.ticks).toHaveLength(1);
		expect(h.loop.frameCount).toBe(1);

		h.loop.stop(); // idempotent
		expect(h.loop.running).toBe(false);
	});

	it('restarts cleanly after stop()', () => {
		const h: Harness = makeHarness(10);
		h.loop.start();
		h.pump(100);
		h.loop.stop();

		h.loop.start(); // idempotent double start leaves one frame pending
		h.loop.start();
		expect(h.hasPendingFrame()).toBe(true);
		h.pump(200); // +100ms of fresh time => exactly one more tick
		expect(h.ticks).toEqual([0, 1]);
		expect(h.loop.tickCount).toBe(2);
		expect(h.loop.droppedTicks).toBe(0);
	});

	it('renders even when no tick is due', () => {
		const h: Harness = makeHarness(10);
		h.loop.start();
		h.pump(0);
		expect(h.ticks).toHaveLength(0);
		expect(h.renders).toEqual([{ alpha: 0, tick: 0 }]);
	});
});
