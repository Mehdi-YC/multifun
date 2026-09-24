/**
 * Tiny tween/easing library for juice (HUD pops, menu bounces...). Driven by
 * dt like everything else, so it behaves the same under any frame rate.
 */

export type EaseFn = (t: number) => number;

export function easeOutQuad(t: number): number {
	const u = 1 - t;
	return 1 - u * u;
}

export function easeOutBack(t: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const u = t - 1;
	return 1 + c3 * u * u * u + c1 * u * u;
}

export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface TweenSpec {
	from: number;
	to: number;
	/** Duration in seconds. */
	duration: number;
	ease?: EaseFn;
	/** Delay in seconds before the first update. */
	delay?: number;
	onUpdate: (value: number) => void;
	onComplete?: () => void;
}

export interface TweenHandle {
	readonly done: boolean;
	cancel(): void;
}

interface Tween extends TweenHandle {
	spec: TweenSpec;
	elapsed: number;
	started: boolean;
	done: boolean;
}

export class TweenManager {
	private readonly tweens: Tween[] = [];

	get size(): number {
		let n = 0;
		for (const t of this.tweens) if (!t.done) n++;
		return n;
	}

	to(spec: TweenSpec): TweenHandle {
		const tween: Tween = {
			spec,
			elapsed: 0,
			started: false,
			done: false,
			cancel: () => {
				tween.done = true;
			}
		};
		this.tweens.push(tween);
		return tween;
	}

	update(dt: number): void {
		for (const tween of this.tweens) {
			if (tween.done) continue;
			tween.elapsed += dt;
			const delay = tween.spec.delay ?? 0;
			if (tween.elapsed < delay) continue;
			if (!tween.started) {
				tween.started = true;
				tween.spec.onUpdate(tween.spec.from);
			}
			const duration = Math.max(tween.spec.duration, 0);
			const t = duration === 0 ? 1 : Math.min(1, (tween.elapsed - delay) / duration);
			const eased = (tween.spec.ease ?? easeOutQuad)(t);
			tween.spec.onUpdate(tween.spec.from + (tween.spec.to - tween.spec.from) * eased);
			if (t >= 1) {
				tween.done = true;
				tween.spec.onComplete?.();
			}
		}
		// Compact finished tweens (allocation here is fine; particles own the
		// no-allocation contract).
		if (this.tweens.length > 0 && this.size === 0) this.tweens.length = 0;
	}

	clear(): void {
		for (const tween of this.tweens) tween.done = true;
		this.tweens.length = 0;
	}
}
