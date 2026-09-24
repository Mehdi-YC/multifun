/**
 * GeoDash Party — multiplayer Geometry Dash-like race. Cube mode only for
 * now (ship/wave/ball land later); 2-8 players run the same auto-runner level
 * simultaneously, dying and respawning, first to the finish wins.
 *
 * `config.options` consumed by the sim/client:
 * - `mode`: 'race' (default, the only mode for now)
 * - `levelId`: 'level-1' | 'level-2' | 'level-3' (default 'level-1')
 * - `level`: full GeoDashLevel override (validated; beats `levelId` — used by
 *   tests and, later, the level editor)
 * - `countdownTicks`: shared 3/2/1/GO freeze length (default 180 = 3s)
 * - `reducedMotion`: true disables death flash + screen shake
 */
import type { GameModule } from '../types';
import { createGeodashSim } from './sim';
import { createGeodashClient } from './render';

export * from './level-types';
export * from './levels';
export * from './sim';
export * from './render';

export const geodashModule: GameModule = {
	id: 'geodash',
	displayName: 'GeoDash Party',
	tagline: 'Auto-run, jump, die, retry — first to the finish wins.',
	minPlayers: 1,
	maxPlayers: 8,
	defaults: {
		tickRate: 60,
		durationTicks: 60 * 120,
		options: { mode: 'race', levelId: 'level-1' }
	},
	createSim: (seed, config, players) => createGeodashSim(seed, config, players),
	createClient: (ctx) => createGeodashClient(ctx)
};
