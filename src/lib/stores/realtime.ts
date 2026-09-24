/**
 * Svelte-facing singleton for the realtime client + live platform state
 * (connection status, current lobby, chat, active match).
 */
import { get, writable, type Writable } from 'svelte/store';
import { RealtimeClient } from '$lib/game/netcode/realtime-client';
import type { LobbySnapshot, MemberSnapshot, ServerMessage } from '$lib/net/protocol';
import type { GameId, MatchResult } from '$lib/game/types';

export interface ChatLine {
	from: string;
	fromName: string;
	text: string;
	ts: number;
}

export interface MatchInfo {
	matchId: string;
	gameId: GameId;
	seed: number;
	players: { id: string; name: string; color: string; slot: number }[];
	config: { tickRate: number; durationTicks: number; options: Record<string, unknown> };
	startAt: number;
}

export interface MatchResults {
	matchId: string;
	results: MatchResult[];
}

let client: RealtimeClient | null = null;

export const connection: Writable<'idle' | 'connecting' | 'open' | 'closed'> = writable('idle');
export const lobby: Writable<LobbySnapshot | null> = writable(null);
export const chat: Writable<ChatLine[]> = writable([]);
export const activeMatch: Writable<MatchInfo | null> = writable(null);
export const matchResults: Writable<MatchResults | null> = writable(null);

/** Lazily created singleton connection. */
export function realtime(): RealtimeClient {
	if (!client) {
		client = new RealtimeClient();
		client.onStatus((status) => {
			connection.set(status);
			// Re-attach to the current lobby after a reconnect (server holds the
			// slot for a grace period but the room membership is per-connection).
			if (status === 'open') {
				const current = get(lobby);
				if (current && current.status !== 'closed') {
					void client!.request('lobby.join', { code: current.code }).catch(() => {});
				}
			}
		});
		client.on('lobby.state', (msg) => {
			lobby.set(structuredClone(msg.d));
		});
		client.on('chat.msg', (msg) => {
			chat.update((lines) => [...lines.slice(-199), msg.d]);
		});
		client.on('game.start', (msg) => {
			matchResults.set(null);
			activeMatch.set(msg.d);
		});
		client.on('game.end', (msg) => {
			activeMatch.set(null);
			matchResults.set({ matchId: msg.d.matchId, results: msg.d.results });
		});
		client.on('err', (msg) => {
			console.warn('[realtime]', msg.d.code, msg.d.msg);
		});
	}
	return client;
}

export function leaveCurrentLobby(): void {
	const current = getLobbyId();
	lobby.set(null);
	chat.set([]);
	if (current) {
		void realtime()
			.request('lobby.leave', { lobbyId: current })
			.catch(() => {});
	}
}

export function getLobbyId(): string | null {
	let id: string | null = null;
	lobby.subscribe((l) => (id = l?.id ?? null))();
	return id;
}

export function selfMember(selfUserId: string, snapshot: LobbySnapshot): MemberSnapshot | null {
	return snapshot.members.find((m) => m.userId === selfUserId) ?? null;
}

export type { ServerMessage };
