/**
 * Pixel Tanks — top-down multiplayer tank battle. 2-8 players, one
 * deterministic 60Hz sim hosting everyone: 2 lives, bouncing shells,
 * destructible crates, level-ups, last tank rolling wins.
 */
import type { GameModule } from '../types';
import { createTankSim } from './sim';
import { createTankClient } from './render';

export * from './arena';
export * from './sim';
export * from './render';

export const tankModule: GameModule = {
	id: 'tank',
	displayName: 'Pixel Tanks',
	tagline: 'Arena tank battles — 2 lives, no mercy.',
	minPlayers: 2,
	maxPlayers: 8,
	defaults: { tickRate: 60, durationTicks: 60 * 120, options: { arenaId: 'crossfire' } },
	createSim: (seed, config, players) => createTankSim(seed, config, players),
	createClient: (ctx) => createTankClient(ctx)
};
