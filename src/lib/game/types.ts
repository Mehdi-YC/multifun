/**
 * Core game contracts shared by client and server.
 * Everything here must stay UI-framework-free and deterministic-friendly.
 */

export type GameId = 'echo' | 'tank' | 'geodash' | 'kart' | 'brawl';
export const GAME_IDS: GameId[] = ['echo', 'tank', 'geodash', 'kart', 'brawl'];

export type PlayerId = string;

/** Bitmask of digital inputs per fixed tick. */
export const KEY = {
	UP: 1,
	DOWN: 2,
	LEFT: 4,
	RIGHT: 8,
	JUMP: 16,
	SPECIAL: 32,
	DRIFT: 64,
	ITEM: 128
} as const;

export interface InputFrame {
	/** Bitmask of KEY.* values. */
	keys: number;
}

export const EMPTY_INPUT: InputFrame = { keys: 0 };

/** A discrete thing that happened during simulation (drives SFX/VFX + server validation). */
export type GameEvent =
	| { kind: 'spawn'; player: PlayerId }
	| { kind: 'death'; player: PlayerId; cause: string }
	| { kind: 'respawn'; player: PlayerId }
	| { kind: 'finish'; player: PlayerId; timeMs: number }
	| { kind: 'collect'; player: PlayerId; item: string }
	| { kind: 'hit'; player: PlayerId; by: PlayerId; force: number }
	| { kind: 'boost'; player: PlayerId; power: number }
	| { kind: 'lap'; player: PlayerId; lap: number; timeMs: number }
	| { kind: 'countdown'; value: number }
	| { kind: 'match-end' };

/** Compact serializable delta of a sim, broadcast to clients for remote entities. */
export type GameStatePatch = Record<string, unknown>;

export interface MatchResult {
	player: PlayerId;
	placement: number;
	score: number;
	stats: Record<string, number>;
}

/** Config for one match; per-game settings live under `options`. */
export interface GameConfig {
	tickRate: number;
	durationTicks: number;
	options: Record<string, unknown>;
}

/**
 * Deterministic simulation. Same inputs on client and server produce the same
 * state and the same event stream. Fixed timestep: one `tick()` = 1/tickRate s.
 */
export interface GameSim {
	readonly tick: number;
	readonly finished: boolean;
	tickOnce(inputs: Map<PlayerId, InputFrame>): void;
	/** Drain events accumulated since the last call. */
	drainEvents(): GameEvent[];
	snapshot(): GameStatePatch;
	restore(state: GameStatePatch): void;
	results(): MatchResult[];
	/** Stable hash of the whole sim state, for determinism assertions. */
	hash(): number;
}

export interface SimPlayer {
	id: PlayerId;
	name: string;
	color: string;
	slot: number;
}

export interface GameContext {
	canvas: HTMLCanvasElement;
	selfId: PlayerId;
	players: SimPlayer[];
	seed: number;
	config: GameConfig;
	/** Send an input frame for the local player to the server. */
	sendInput(frame: InputFrame): void;
	/** Called when the match ends with final validated results. */
	onEnd(results: MatchResult[]): void;
}

export interface GameClient {
	start(): void;
	stop(): void;
	/** Feed a remote snapshot (other players' state) for interpolation. */
	onSnapshot?(patch: GameStatePatch): void;
	/** Feed a server game event (for shared SFX/VFX). */
	onEvent?(ev: GameEvent): void;
}

export interface GameModule {
	id: GameId;
	displayName: string;
	tagline: string;
	minPlayers: number;
	maxPlayers: number;
	defaults: GameConfig;
	createSim(seed: number, config: GameConfig, players: SimPlayer[]): GameSim;
	createClient(ctx: GameContext): GameClient;
}
