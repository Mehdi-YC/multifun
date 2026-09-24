/**
 * Fixed-timestep game loop: ticks at a constant rate, renders once per frame
 * with an interpolation alpha. The animation frame source and the clock are
 * injectable so the loop runs headless in tests.
 */
import { TICK_MS, type NowFn, nowMs } from './fixed';

export type RafFn = (callback: (timeMs: number) => void) => number;
export type CafFn = (handle: number) => void;

export interface FixedTimestepLoopOptions {
	/** Simulation ticks per second. */
	tickRate: number;
	/** Called once per simulation tick with the tick index (starts at 0). */
	onTick: (tick: number) => void;
	/** Called once per animation frame with the interpolation alpha in [0, 1). */
	onRender: (alpha: number, tick: number) => void;
	/** requestAnimationFrame replacement (injectable). Defaults to rAF or setTimeout. */
	raf?: RafFn;
	/** cancelAnimationFrame replacement (injectable). */
	caf?: CafFn;
	/** Clock in milliseconds (injectable). Defaults to performance.now(). */
	now?: NowFn;
	/** Max ticks executed per frame before dropping time (spiral-of-death guard). */
	maxCatchUpTicks?: number;
}

const DEFAULT_MAX_CATCH_UP = 5;

function defaultRaf(callback: (timeMs: number) => void): number {
	if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
	return setTimeout(() => callback(nowMs()), 16) as unknown as number;
}

function defaultCaf(handle: number): void {
	if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
	else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export class FixedTimestepLoop {
	readonly tickRate: number;
	readonly tickMs: number;
	readonly maxCatchUpTicks: number;

	running = false;
	/** Number of simulation ticks executed since start(). */
	tickCount = 0;
	/** Number of animation frames rendered since start(). */
	frameCount = 0;
	/** Ticks that could not be executed because of the catch-up clamp. */
	droppedTicks = 0;

	private readonly onTick: (tick: number) => void;
	private readonly onRender: (alpha: number, tick: number) => void;
	private readonly raf: RafFn;
	private readonly caf: CafFn;
	private readonly now: NowFn;

	private accumulator = 0;
	private lastTime = 0;
	private handle: number | null = null;

	constructor(options: FixedTimestepLoopOptions) {
		this.tickRate = options.tickRate;
		this.tickMs = TICK_MS(options.tickRate);
		this.maxCatchUpTicks = options.maxCatchUpTicks ?? DEFAULT_MAX_CATCH_UP;
		this.onTick = options.onTick;
		this.onRender = options.onRender;
		this.raf = options.raf ?? defaultRaf;
		this.caf = options.caf ?? defaultCaf;
		this.now = options.now ?? nowMs;
	}

	/** Begin ticking. Idempotent. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.accumulator = 0;
		this.lastTime = this.now();
		this.schedule();
	}

	/** Stop ticking and cancel any pending frame. Idempotent. */
	stop(): void {
		if (!this.running) return;
		this.running = false;
		if (this.handle !== null) this.caf(this.handle);
		this.handle = null;
	}

	private schedule(): void {
		this.handle = this.raf(() => {
			this.handle = null;
			if (this.running) this.frame();
		});
	}

	private frame(): void {
		const time = this.now();
		const delta = Math.max(0, time - this.lastTime);
		this.lastTime = time;
		this.accumulator += delta;

		let executed = 0;
		while (this.accumulator >= this.tickMs && executed < this.maxCatchUpTicks) {
			this.accumulator -= this.tickMs;
			this.onTick(this.tickCount);
			this.tickCount++;
			executed++;
		}
		// Beyond the clamp we cannot keep up: drop the surplus ticks.
		while (this.accumulator >= this.tickMs) {
			this.accumulator -= this.tickMs;
			this.droppedTicks++;
		}

		this.onRender(this.accumulator / this.tickMs, this.tickCount);
		this.frameCount++;
		if (this.running) this.schedule();
	}
}
