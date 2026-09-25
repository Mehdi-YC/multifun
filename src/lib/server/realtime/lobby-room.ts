import type { Connection } from './connection';
import type { LobbySnapshot, MemberSnapshot, ServerMessage } from '$lib/net/protocol';
import type { GameId, MatchResult } from '$lib/game/types';
import { gameLimits, hasSim } from './sim-registry';
import {
	activeMembers,
	addMessage,
	buildLobbySnapshot,
	leaveLobby,
	promoteHost,
	setLobbyStatus,
	setReady,
	updateLobbySettings
} from '$lib/server/lobby';

const DISCONNECT_GRACE_MS = 30_000;
const EMPTY_CLOSE_MS = 60_000;

export interface LobbyRoomDeps {
	/** Create the match + game room and broadcast `game.start`. Throws on failure. */
	launchMatch(snapshot: LobbySnapshot): Promise<void>;
	/** Lobby deleted while a match runs — stop and abort it. */
	abortMatch(lobbyId: string): void;
	destroyRoom(lobbyId: string): void;
}

/**
 * Live lobby: presence, chat, ready state, host controls and match launch.
 * DB rows are the durable state; this room is the realtime view of them.
 */
export class LobbyRoom {
	readonly lobbyId: string;
	private readonly conns = new Map<string, Connection>();
	private readonly connected = new Set<string>();
	private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private emptyTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshot: LobbySnapshot;
	private matchRunning = false;

	constructor(
		lobbyId: string,
		snapshot: LobbySnapshot,
		private readonly deps: LobbyRoomDeps
	) {
		this.lobbyId = lobbyId;
		this.snapshot = snapshot;
	}

	get code(): string {
		return this.snapshot.code;
	}

	get isPlaying(): boolean {
		return this.matchRunning;
	}

	// -- membership ----------------------------------------------------------

	async join(conn: Connection): Promise<void> {
		this.conns.set(conn.userId, conn);
		this.connected.add(conn.userId);
		conn.rooms.add(this.lobbyId);
		const pending = this.graceTimers.get(conn.userId);
		if (pending) {
			clearTimeout(pending);
			this.graceTimers.delete(conn.userId);
		}
		if (this.emptyTimer) {
			clearTimeout(this.emptyTimer);
			this.emptyTimer = null;
		}
		await this.refresh();
		// Everyone in the room (including the joiner) needs the new member list.
		this.broadcast({ t: 'lobby.state', d: this.state() });
		this.broadcastPresence();
	}

	/** Socket lost but the player may come back within the grace period. */
	disconnect(conn: Connection): void {
		this.conns.delete(conn.userId);
		this.connected.delete(conn.userId);
		conn.rooms.delete(this.lobbyId);
		if (this.graceTimers.has(conn.userId)) return;
		const timer = setTimeout(() => {
			void this.expireMember(conn.userId).catch((err) =>
				console.error('[lobby-room] expireMember failed (non-fatal)', err)
			);
		}, DISCONNECT_GRACE_MS);
		this.graceTimers.set(conn.userId, timer);
		this.broadcastPresence();
		if (this.conns.size === 0) this.scheduleEmptyClose();
	}

	/** Voluntary leave (immediate removal). */
	async leave(conn: Connection): Promise<void> {
		const wasHost = conn.userId === this.snapshot.hostUserId;
		this.clearGrace(conn.userId);
		this.conns.delete(conn.userId);
		this.connected.delete(conn.userId);
		conn.rooms.delete(this.lobbyId);
		await leaveLobby(this.lobbyId, conn.userId);
		await this.refresh();
		if (wasHost && this.snapshot.members.length > 0) {
			await promoteHost(this.lobbyId, this.snapshot.members[0].userId);
			await this.refresh();
		}
		this.broadcast({ t: 'lobby.state', d: this.state() });
		this.broadcastPresence();
		if (this.conns.size === 0) this.scheduleEmptyClose();
	}

	private async expireMember(userId: string): Promise<void> {
		this.graceTimers.delete(userId);
		if (this.connected.has(userId)) return;
		const wasHost = userId === this.snapshot.hostUserId;
		await leaveLobby(this.lobbyId, userId);
		await this.refresh();
		if (wasHost && this.snapshot.members.length > 0) {
			await promoteHost(this.lobbyId, this.snapshot.members[0].userId);
			await this.refresh();
		}
		this.broadcast({ t: 'lobby.state', d: this.state() });
		this.broadcastPresence();
	}

	private scheduleEmptyClose(): void {
		if (this.emptyTimer) return;
		this.emptyTimer = setTimeout(() => {
			if (this.conns.size === 0)
				void this.close().catch((err) =>
					console.error('[lobby-room] close failed (non-fatal)', err)
				);
		}, EMPTY_CLOSE_MS);
	}

	// -- chat ----------------------------------------------------------------

	async handleChat(conn: Connection, text: string): Promise<void> {
		if (!this.snapshot.members.some((m) => m.userId === conn.userId)) return;
		if (!conn.allowChat()) {
			conn.sendError('rate-limited', 'Slow down a bit!');
			return;
		}
		const clean = text.trim().slice(0, 300);
		if (!clean) return;
		const { sentAt } = await addMessage(this.lobbyId, conn.userId, clean);
		this.broadcast({
			t: 'chat.msg',
			d: {
				lobbyId: this.lobbyId,
				from: conn.userId,
				fromName: conn.displayName,
				text: clean,
				ts: sentAt
			}
		});
	}

	// -- host controls -------------------------------------------------------

	async setReadyState(conn: Connection, ready: boolean): Promise<void> {
		if (this.matchRunning) return;
		await setReady(this.lobbyId, conn.userId, ready);
		await this.refresh();
		this.broadcast({ t: 'lobby.state', d: this.state() });
	}

	async updateSettings(
		conn: Connection,
		patch: {
			name?: string;
			gameId?: GameId;
			maxPlayers?: number;
			isPublic?: boolean;
			settings?: Record<string, unknown>;
		}
	): Promise<void> {
		if (conn.userId !== this.snapshot.hostUserId) throw new Error('not-host');
		if (patch.gameId !== undefined) {
			if (!hasSim(patch.gameId)) throw new Error('game-unavailable');
			const limits = gameLimits[patch.gameId];
			if (this.snapshot.members.length > limits.maxPlayers) throw new Error('too-many-players');
			if (
				this.snapshot.members.length < limits.minPlayers &&
				patch.gameId !== this.snapshot.gameId
			) {
				// switching TO a game that needs more players is fine (they can invite),
				// switching when the lobby can never host it is not
				if (limits.minPlayers > this.snapshot.maxPlayers) throw new Error('too-few-players');
			}
		}
		await updateLobbySettings(this.lobbyId, patch);
		await this.refresh();
		this.broadcast({ t: 'lobby.state', d: this.state() });
	}

	async kick(conn: Connection, targetUserId: string): Promise<void> {
		if (conn.userId !== this.snapshot.hostUserId) throw new Error('not-host');
		if (targetUserId === conn.userId) throw new Error('cannot-kick-self');
		const target = this.conns.get(targetUserId);
		await leaveLobby(this.lobbyId, targetUserId);
		this.clearGrace(targetUserId);
		this.conns.delete(targetUserId);
		this.connected.delete(targetUserId);
		await this.refresh();
		if (target) {
			target.rooms.delete(this.lobbyId);
			target.sendError('kicked', 'The host removed you from the lobby');
		}
		this.broadcast({ t: 'lobby.state', d: this.state() });
		this.broadcastPresence();
	}

	/** Host-only: close the lobby for everyone and remove it from listings. */
	async deleteLobby(conn: Connection): Promise<void> {
		if (conn.userId !== this.snapshot.hostUserId) throw new Error('not-host');
		// deleting mid-match aborts the match instead of leaving a zombie running
		if (this.matchRunning) {
			this.matchRunning = false;
			this.deps.abortMatch(this.lobbyId);
		}
		for (const m of this.snapshot.members) {
			await leaveLobby(this.lobbyId, m.userId);
		}
		this.broadcast({
			t: 'lobby.state',
			d: { ...this.state(), status: 'closed', members: [] }
		});
		for (const other of [...this.conns.values()]) {
			other.rooms.delete(this.lobbyId);
			if (other.userId !== conn.userId) {
				other.sendError('lobby-deleted', 'The host deleted this lobby');
			}
		}
		this.conns.clear();
		this.broadcastPresence();
		await this.close();
	}

	async startGame(conn: Connection): Promise<void> {
		if (conn.userId !== this.snapshot.hostUserId) throw new Error('not-host');
		if (this.matchRunning) throw new Error('match-running');
		await this.refresh();
		const members = this.snapshot.members;
		if (members.length === 0) throw new Error('no-players');
		const notReady = members.filter((m) => !m.isReady && m.userId !== conn.userId);
		if (notReady.length > 0) throw new Error('not-everyone-ready');
		this.matchRunning = true;
		try {
			await this.deps.launchMatch(this.snapshot);
			await setLobbyStatus(this.lobbyId, 'playing');
			await this.refresh();
			this.broadcast({ t: 'lobby.state', d: this.state() });
		} catch (err) {
			this.matchRunning = false;
			throw err;
		}
	}

	/** Match finished/aborted — back to open lobby. */
	async matchEnded(): Promise<void> {
		this.matchRunning = false;
		for (const m of this.snapshot.members) {
			await setReady(this.lobbyId, m.userId, false);
		}
		await setLobbyStatus(this.lobbyId, 'open');
		await this.refresh();
		this.broadcast({ t: 'lobby.state', d: this.state() });
	}

	// -- state / broadcast ---------------------------------------------------

	async refresh(): Promise<void> {
		const fresh = await buildLobbySnapshot(this.lobbyId);
		if (fresh) this.snapshot = fresh;
	}

	state(): LobbySnapshot {
		return {
			...this.snapshot,
			members: this.snapshot.members.map((m): MemberSnapshot => ({
				...m,
				connected: this.connected.has(m.userId)
			}))
		};
	}

	broadcast(msg: ServerMessage): void {
		for (const conn of this.conns.values()) conn.send(msg);
	}

	private broadcastPresence(): void {
		this.broadcast({
			t: 'presence',
			d: {
				lobbyId: this.lobbyId,
				users: this.snapshot.members.map((m) => ({
					userId: m.userId,
					username: m.username,
					displayName: m.displayName,
					online: this.connected.has(m.userId)
				}))
			}
		});
	}

	// -- teardown ------------------------------------------------------------

	async close(): Promise<void> {
		await setLobbyStatus(this.lobbyId, 'closed');
		for (const timer of this.graceTimers.values()) clearTimeout(timer);
		this.graceTimers.clear();
		if (this.emptyTimer) clearTimeout(this.emptyTimer);
		for (const conn of this.conns.values()) {
			conn.rooms.delete(this.lobbyId);
		}
		this.conns.clear();
		this.deps.destroyRoom(this.lobbyId);
	}

	private clearGrace(userId: string): void {
		const timer = this.graceTimers.get(userId);
		if (timer) clearTimeout(timer);
		this.graceTimers.delete(userId);
	}

	/** Used when a match ends unexpectedly (all players gone). */
	async activeMemberIds(): Promise<string[]> {
		const rows = await activeMembers(this.lobbyId);
		return rows.map((r) => r.userId);
	}
}

export type { MatchResult };
