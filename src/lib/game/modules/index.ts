/**
 * Game module registry. `echo` is the stub that proves the netcode pipeline;
 * `geodash` / `kart` / `brawl` land in later phases.
 */
import type { GameId, GameModule } from '../types';
import { echoModule } from './echo';

export * from './echo';

export const gameModules: Record<GameId, GameModule | undefined> = {
	echo: echoModule,
	tank: undefined, // wired when the tank module lands
	geodash: undefined,
	kart: undefined,
	brawl: undefined
};

export function getGameModule(id: GameId): GameModule | undefined {
	return gameModules[id];
}
