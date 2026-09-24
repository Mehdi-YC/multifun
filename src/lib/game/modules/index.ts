/**
 * Game module registry. `echo` is the stub that proves the netcode pipeline;
 * `tank` / `geodash` are playable; `kart` / `brawl` land in later phases.
 */
import type { GameId, GameModule } from '../types';
import { echoModule } from './echo';
import { geodashModule } from '../geodash';
import { tankModule } from '../tank';

export * from './echo';

export const gameModules: Record<GameId, GameModule | undefined> = {
	echo: echoModule,
	tank: tankModule,
	geodash: geodashModule,
	kart: undefined,
	brawl: undefined
};

export function getGameModule(id: GameId): GameModule | undefined {
	return gameModules[id];
}
