/**
 * Turbo Kart AI drivers. Sim-owned karts (ids `ai-1`..., "CPU 1"...) follow the
 * track centerline spline with lookahead steering, drift through wide turns,
 * trick off ramps and spend their items with racing awareness. Mild
 * rubber-banding (±8% speed, capped) keeps races close without teleporting.
 *
 * Everything is a pure function of sim state: decisions come from the kart, the
 * spline and a tiny per-AI state (wobble/jitter timers) that lives in the
 * snapshot, with randomness drawn only from the sim's seeded rng. Same seed +
 * same inputs ⇒ the same AI race, forever.
 */
import type { PlayerId } from '../types';
import { KEY } from '../types';
import { clamp } from '../engine/fixed';
import { nearestSpline, type Track } from './track';
import { angleDelta } from './interp';
import type { KartState } from './sim';

/** Fixed livery palette for AI karts (index = ai number - 1). */
export const AI_COLORS: readonly string[] = [
	'#ff5c7a',
	'#57e389',
	'#6ec6ff',
	'#ffd166',
	'#c792ea',
	'#ff9f43',
	'#63d7d2',
	'#e8e8f0'
];

export type AiDifficulty = 'easy' | 'medium' | 'hard';

/** Serializable per-AI decision state (part of snapshot/restore/hash). */
export type AiState = {
	id: PlayerId;
	/** Ticks until the next item-use check. */
	itemTimer: number;
	/** Ticks left holding the current drift (0 = not drifting on purpose). */
	driftTimer: number;
	/** Lateral offset (px) applied to the lookahead target. */
	wobble: number;
	/** Ticks until the wobble re-rolls. */
	wobbleTimer: number;
};

interface DifficultyConfig {
	/** Lookahead in spline samples at zero speed. */
	lookahead: number;
	/** Wobble amplitude in px. */
	wobble: number;
	/** Curvature (radians over the lookahead) that triggers a drift. */
	driftCurvature: number;
	/** Whether the AI bothers with ramp tricks. */
	tricks: boolean;
	/** Rubber-banding strength scale. */
	rubber: number;
}

const DIFFICULTY: Record<AiDifficulty, DifficultyConfig> = {
	easy: { lookahead: 10, wobble: 12, driftCurvature: 0.85, tricks: false, rubber: 0.4 },
	medium: { lookahead: 14, wobble: 8, driftCurvature: 0.55, tricks: true, rubber: 0.7 },
	hard: { lookahead: 18, wobble: 4, driftCurvature: 0.4, tricks: true, rubber: 1 }
};

/** Max rubber-banding speed multiplier deviation. */
export const RUBBER_BAND_MAX = 0.08;

/**
 * Speed multiplier from the signed progress gap to the pack (`gap` > 0 = this
 * AI trails): trailers get a nudge, leaders a slight hold-back, both capped at
 * ±8% and scaled down on easier difficulties.
 */
export function aiRubberBand(difficulty: AiDifficulty, gap: number): number {
	const scale = DIFFICULTY[difficulty]?.rubber ?? 0.7;
	const band = clamp(gap * 0.0004, -RUBBER_BAND_MAX, RUBBER_BAND_MAX) * scale;
	return 1 + band;
}

/** Display metadata for a sim-owned AI kart (`ai-1` -> "CPU 1", palette color). */
export function aiMeta(id: PlayerId): { name: string; color: string } {
	const match = /^ai-(\d+)$/.exec(id);
	const index = match ? Math.max(0, Number(match[1]) - 1) : 0;
	return {
		name: `CPU ${match ? Number(match[1]) : index + 1}`,
		color: AI_COLORS[index % AI_COLORS.length]
	};
}

function shouldUseItem(
	kart: KartState,
	others: readonly KartState[],
	config: DifficultyConfig
): boolean {
	switch (kart.item) {
		case 'shield':
		case 'lightning':
			return true;
		case 'mushroom':
			return true;
		case 'missile':
			// Fire when someone to hunt is within missile range ahead.
			return others.some(
				(o) => o.id !== kart.id && o.progress > kart.progress && o.progress - kart.progress < 500
			);
		case 'oil':
			// Drop it on a pursuer; easy AI just litters.
			return (
				config.rubber < 0.5 ||
				others.some(
					(o) => o.id !== kart.id && kart.progress > o.progress && kart.progress - o.progress < 160
				)
			);
		default:
			return false;
	}
}

/**
 * Decide one tick of input for an AI kart. Mutates `state` (wobble/item/drift
 * timers — all snapshot state). Pure function of its arguments otherwise.
 */
export function aiDecide(
	track: Track,
	kart: KartState,
	others: readonly KartState[],
	state: AiState,
	difficulty: AiDifficulty,
	_tick: number,
	rng: () => number
): number {
	if (kart.spinTimer > 0) return 0;
	const config = DIFFICULTY[difficulty] ?? DIFFICULTY.medium;

	// Slowly drifting lateral target keeps the pack from riding one line.
	state.wobbleTimer--;
	if (state.wobbleTimer <= 0) {
		state.wobbleTimer = 45;
		state.wobble = (rng() * 2 - 1) * config.wobble;
	}

	const near = nearestSpline(track, kart.x, kart.y, kart.splineHint);
	const n = track.spline.length;
	// Cross-track error: how far (and which side) the kart sits off the racing
	// line. The lookahead target leans back toward the line so the AI recenters
	// instead of drifting wide or slicing every corner.
	const perp = (kart.x - near.point.x) * -near.point.ty + (kart.y - near.point.y) * near.point.tx;
	const correction = clamp(-perp * 0.35, -24, 24);
	const lookahead = Math.max(4, Math.round(config.lookahead + Math.abs(kart.speed) * 3));
	const target = track.spline[(near.index + lookahead) % n];
	// Offset the target sideways (perpendicular to the racing line).
	const offset = state.wobble + correction;
	const tx = target.x - target.ty * offset;
	const ty = target.y + target.tx * offset;
	const desired = Math.atan2(ty - kart.y, tx - kart.x);
	const delta = angleDelta(kart.angle, desired);

	let keys = KEY.UP;
	if (delta > 0.02) keys |= KEY.RIGHT;
	else if (delta < -0.02) keys |= KEY.LEFT;

	// Drift through wide turns: hold DRIFT for a spell, release for a mini-turbo
	// (holds run past the 60-tick first tier so the boost actually fires).
	const curvature = Math.abs(
		angleDelta(Math.atan2(near.point.ty, near.point.tx), Math.atan2(target.ty, target.tx))
	);
	if (state.driftTimer > 0) {
		state.driftTimer--;
		keys |= KEY.DRIFT;
	} else if (
		curvature > config.driftCurvature &&
		Math.abs(kart.speed) > 2 &&
		kart.z <= 0 &&
		kart.boostTimer <= 0
	) {
		state.driftTimer = 55 + Math.floor(rng() * 55);
		keys |= KEY.DRIFT;
	}

	// Trick spin off ramps for the landing boost.
	if (kart.z > 0 && !kart.trick && config.tricks) keys |= KEY.JUMP;

	// Spend items with racing awareness (timers keep decisions sparse).
	state.itemTimer--;
	if (state.itemTimer <= 0 && kart.item !== null && kart.spinTimer === 0) {
		if (shouldUseItem(kart, others, config)) {
			keys |= KEY.ITEM;
			state.itemTimer = 90 + Math.floor(rng() * 60);
		} else {
			state.itemTimer = 30;
		}
	}
	return keys;
}
