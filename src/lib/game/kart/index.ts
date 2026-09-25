/**
 * Turbo Kart — top-down pixel kart racing. 2-8 racers, one deterministic 60Hz
 * sim hosting everyone: drift-boosts, boost pads, ramp tricks, slipstream,
 * items and 3-lap races across three circuits. `aiCount` fills the grid with
 * sim-owned CPU karts so small lobbies still race a full pack.
 *
 * `config.options` consumed by the sim/client:
 * - `trackId`: 'sunny-circuit' | 'neon-dojo' | 'frostbite-falls' (default 'sunny-circuit')
 * - `laps`: laps to complete (default 3)
 * - `aiCount`: sim-owned CPU karts, 0-7 (default 0)
 * - `aiDifficulty`: 'easy' | 'medium' | 'hard' (default 'medium')
 * - `countdownTicks`: shared 3/2/1/GO freeze length (default 150 = 2.5s)
 *
 * Event stream (existing GameEvent kinds only): `spawn` (all racers),
 * `countdown` (3/2/1/GO), `lap` {player, lap, timeMs = lap split}, `boost`
 * {player, power} (pads/mini-turbos/tricks/slipstream/mushroom/respawn),
 * `collect` {item: 'itembox' | 'mushroom' | 'oil' | 'missile' | 'shield' |
 * 'lightning'}, `hit` {player, by, force} (force 0 = shield absorbed it),
 * `finish` {player, timeMs = race time incl. countdown}, `respawn`, `match-end`.
 */
import type { GameModule } from '../types';
import { createKartSim } from './sim';
import { createKartClient } from './render';

export * from './track';
export * from './interp';
export * from './sim';
export * from './ai';
export * from './render';

export const kartModule: GameModule = {
	id: 'kart',
	displayName: 'Turbo Kart',
	tagline: 'Drift, boost and blast past your rivals.',
	minPlayers: 1,
	maxPlayers: 8,
	defaults: {
		tickRate: 60,
		durationTicks: 60 * 180,
		options: { trackId: 'sunny-circuit', laps: 3, aiCount: 0, aiDifficulty: 'medium' }
	},
	createSim: (seed, config, players) => createKartSim(seed, config, players),
	createClient: (ctx) => createKartClient(ctx)
};
