import type { GameId } from '$lib/game/types';

export interface GameMeta {
	id: GameId;
	title: string;
	tagline: string;
	accent: string;
	players: string;
	status: 'playable' | 'coming';
}

export const GAME_META: Record<GameId, GameMeta> = {
	echo: {
		id: 'echo',
		title: 'Echo Arena',
		tagline: 'Platform test chamber — run, sprint, prove the netcode.',
		accent: 'var(--color-echo)',
		players: '1-4 players',
		status: 'playable'
	},
	tank: {
		id: 'tank',
		title: 'Pixel Tanks',
		tagline: 'Arena tank battles — 2 lives each, obstacles, level ups.',
		accent: 'var(--color-tank)',
		players: '2-8 players',
		status: 'playable'
	},
	geodash: {
		id: 'geodash',
		title: 'GeoDash Party',
		tagline: 'Race friends through impossible spike-filled levels.',
		accent: 'var(--color-geodash)',
		players: '2-8 players',
		status: 'coming'
	},
	kart: {
		id: 'kart',
		title: 'Turbo Kart',
		tagline: 'Drift, boost and blast past your rivals.',
		accent: 'var(--color-kart)',
		players: '2-8 players',
		status: 'coming'
	},
	brawl: {
		id: 'brawl',
		title: 'Pixel Brawl',
		tagline: 'Knock them off the stage. Stocks and glory.',
		accent: 'var(--color-brawl)',
		players: '2-4 players',
		status: 'coming'
	}
};

export function isGameId(value: string): value is GameId {
	return value in GAME_META;
}
