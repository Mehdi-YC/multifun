/**
 * Echo Arena — stub multiplayer game. Deleted once the real games land, but it
 * fully implements the GameModule contract so the platform can run it today.
 */
import type { GameModule } from '../../types';
import { createEchoSim } from './sim';
import { createEchoClient } from './render';

export * from './sim';
export * from './render';

export const echoModule: GameModule = {
	id: 'echo',
	displayName: 'Echo Arena',
	tagline: 'Outrun the grid before the clock runs out.',
	minPlayers: 1,
	maxPlayers: 4,
	defaults: { tickRate: 60, durationTicks: 60 * 20, options: {} },
	createSim: (seed, config, players) => createEchoSim(seed, config, players),
	createClient: (ctx) => createEchoClient(ctx)
};
