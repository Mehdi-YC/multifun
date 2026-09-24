/**
 * Seeded, deterministic pseudo-random numbers. Never use Math.random in
 * anything that touches a simulation: every draw must be reproducible from a
 * seed alone.
 */

/** A source of floats in [0, 1). */
export type Rng = () => number;

/** Classic mulberry32 PRNG. Same seed => same sequence, forever. */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Integer in [min, max], both inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
	return min + Math.floor(rng() * (max - min + 1));
}

/** Pick one element from a non-empty list. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
	if (items.length === 0) throw new Error('pick: empty list');
	return items[Math.floor(rng() * items.length)];
}

/** Fisher-Yates shuffle. Returns a new array; the input is left untouched. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}
