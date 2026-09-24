/**
 * Server-side sim registry. Imports ONLY simulation code (node-safe, no DOM) so
 * the authoritative game loop can run inside the server process.
 */
import type { GameConfig, GameId, GameSim, SimPlayer } from '$lib/game/types';
import { createEchoSim } from '$lib/game/modules/echo/sim';

type SimFactory = (seed: number, config: GameConfig, players: SimPlayer[]) => GameSim;

const factories: Partial<Record<GameId, SimFactory>> = {
	echo: createEchoSim
	// geodash / kart / brawl land in later phases
};

export const gameLimits: Record<GameId, { minPlayers: number; maxPlayers: number }> = {
	echo: { minPlayers: 1, maxPlayers: 4 },
	tank: { minPlayers: 2, maxPlayers: 8 },
	geodash: { minPlayers: 1, maxPlayers: 8 },
	kart: { minPlayers: 2, maxPlayers: 8 },
	brawl: { minPlayers: 2, maxPlayers: 4 }
};

/** Match configs per game (mirrors GameModule.defaults; kept node-safe here). */
export const gameConfigs: Record<GameId, GameConfig> = {
	echo: { tickRate: 60, durationTicks: 60 * 20, options: {} },
	tank: { tickRate: 60, durationTicks: 60 * 120, options: { arenaId: 'crossfire' } },
	geodash: { tickRate: 60, durationTicks: 60 * 90, options: { levelId: 'daily' } },
	kart: { tickRate: 60, durationTicks: 60 * 120, options: { laps: 3 } },
	brawl: { tickRate: 60, durationTicks: 60 * 180, options: { stocks: 3 } }
};

export function createServerSim(
	gameId: GameId,
	seed: number,
	config: GameConfig,
	players: SimPlayer[]
): GameSim {
	const factory = factories[gameId];
	if (!factory) throw new Error(`no-sim-for-game:${gameId}`);
	return factory(seed, config, players);
}

export function hasSim(gameId: GameId): boolean {
	return factories[gameId] !== undefined;
}
