/**
 * Realtime server: authenticates upgrades via the better-auth session cookie,
 * routes protocol messages, and owns lobby + game rooms. Transport-agnostic —
 * the Vite dev plugin and the prod `server.js` both mount it on an HTTP server.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { nanoid } from 'nanoid';
import { auth } from '$lib/server/auth';
import { Connection } from './connection';
import { LobbyRoom } from './lobby-room';
import { GameRoom } from './game-room';
import { createServerSim, gameConfigs, gameLimits, hasSim } from './sim-registry';
import { randomSeed } from '$lib/server/ids';
import {
	createLobby,
	buildLobbySnapshot,
	getLobbyByCode,
	joinLobby,
	listPublicLobbies
} from '$lib/server/lobby';
import { createMatch, finishMatch } from '$lib/server/matches';
import { upsertBestScore } from '$lib/server/scores';
import {
	ensureProfile,
	getProfile,
	getProfileByUsername,
	updateProfile,
	type ProfileRow
} from '$lib/server/profile';
import { parseAvatar } from '$lib/server/profile';
import {
	PROTOCOL_VERSION,
	parseClientMessage,
	requestPayloads,
	type LobbySnapshot
} from '$lib/net/protocol';
import type { GameConfig, MatchResult, SimPlayer } from '$lib/game/types';

const HEARTBEAT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const MATCH_START_DELAY_MS = 3_000;

/** Player colors (colorblind-friendly, distinguishable on dark bg). */
const SLOT_COLORS = [
	'#6ec6ff',
	'#ffd166',
	'#ff5c7a',
	'#57e389',
	'#b06bff',
	'#ff9f43',
	'#2de2e6',
	'#e8e8f0'
];

export class RealtimeServer {
	private readonly wss = new WebSocketServer({ noServer: true });
	private readonly byUser = new Map<string, Set<Connection>>();
	private readonly lobbyRooms = new Map<string, LobbyRoom>();
	private readonly gameRooms = new Map<string, GameRoom>();
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private started = false;

	/** Mount on an HTTP server's upgrade event for the given path (default /realtime). */
	attach(httpServer: import('node:http').Server, path = '/realtime'): void {
		httpServer.on('upgrade', (req, socket, head) => {
			if ((req.url ?? '').startsWith(path)) {
				void this.handleUpgrade(req, socket as Duplex, head as Buffer);
			}
		});
		this.start();
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
	}

	stop(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
		for (const room of this.gameRooms.values()) room.stop();
		this.wss.close();
	}

	// -- connections ---------------------------------------------------------

	private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		try {
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (typeof value === 'string') headers.set(key, value);
				else if (Array.isArray(value)) headers.set(key, value.join(', '));
			}
			const session = await auth.api.getSession({ headers });
			if (!session) {
				socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
				socket.destroy();
				return;
			}
			const profile = await ensureProfile(
				session.user.id,
				session.user.name || session.user.email?.split('@')[0] || 'player'
			);
			this.wss.handleUpgrade(req, socket, head, (ws) => {
				this.onConnection(ws, profile);
			});
		} catch (err) {
			console.error('[realtime] upgrade failed', err);
			socket.destroy();
		}
	}

	private onConnection(ws: WebSocket, profile: ProfileRow): void {
		const conn = new Connection(nanoid(10), ws, {
			id: profile.userId,
			username: profile.username,
			displayName: profile.displayName
		});
		let set = this.byUser.get(conn.userId);
		if (!set) {
			set = new Set();
			this.byUser.set(conn.userId, set);
		}
		set.add(conn);

		conn.send({
			t: 'welcome',
			d: { userId: conn.userId, sessionId: conn.id, serverTick: Date.now() }
		});

		ws.on('message', (raw) => {
			conn.lastSeen = Date.now();
			void this.onMessage(conn, raw.toString());
		});
		ws.on('pong', () => {
			conn.lastSeen = Date.now();
		});
		ws.on('close', () => this.onClose(conn));
		ws.on('error', () => this.onClose(conn));
	}

	private onClose(conn: Connection): void {
		const set = this.byUser.get(conn.userId);
		if (set) {
			set.delete(conn);
			if (set.size === 0) this.byUser.delete(conn.userId);
		}
		for (const lobbyId of [...conn.rooms]) {
			const room = this.lobbyRooms.get(lobbyId);
			room?.disconnect(conn);
		}
	}

	private sweep(): void {
		const now = Date.now();
		for (const set of this.byUser.values()) {
			for (const conn of set) {
				if (now - conn.lastSeen > CONNECTION_TIMEOUT_MS) {
					conn.terminate();
					this.onClose(conn);
				} else if (conn.open) {
					conn.ping();
				}
			}
		}
	}

	// -- message dispatch ----------------------------------------------------

	private async onMessage(conn: Connection, raw: string): Promise<void> {
		const msg = parseClientMessage(raw);
		if (!msg) {
			conn.sendError('bad-message', 'Unrecognized message');
			return;
		}
		try {
			switch (msg.t) {
				case 'hello':
					if (msg.d.version !== PROTOCOL_VERSION) {
						conn.sendError('version-mismatch', 'Please refresh the page');
						conn.close(4000, 'version-mismatch');
					}
					break;
				case 'ping':
					break;
				case 'chat': {
					const room = this.roomForConnection(conn, msg.d.lobbyId);
					if (room) await room.handleChat(conn, msg.d.text);
					break;
				}
				case 'input': {
					this.gameRooms.get(msg.d.matchId)?.addInput(conn.userId, msg.d.keys);
					break;
				}
				case 'req':
					await this.handleReq(conn, msg.id, msg.d.t, msg.d.d);
					break;
			}
		} catch (err) {
			console.error('[realtime] message error', err);
			conn.sendError('internal', 'Something went wrong');
		}
	}

	private roomForConnection(conn: Connection, lobbyId: string): LobbyRoom | null {
		if (!conn.rooms.has(lobbyId)) return null;
		return this.lobbyRooms.get(lobbyId) ?? null;
	}

	private async handleReq(
		conn: Connection,
		id: number,
		name: string,
		payload: unknown
	): Promise<void> {
		try {
			const result = await this.dispatch(conn, name, payload);
			conn.ack(id, true, result);
		} catch (err) {
			const code = err instanceof Error ? err.message : 'error';
			conn.ack(id, false, undefined, { code, msg: humanError(code) });
		}
	}

	private async dispatch(conn: Connection, name: string, payload: unknown): Promise<unknown> {
		switch (name) {
			case 'lobby.create': {
				const p = requestPayloads['lobby.create'].parse(payload);
				if (!hasSim(p.gameId)) throw new Error('game-unavailable');
				const lobbyId = await createLobby({
					name: p.name,
					gameId: p.gameId,
					hostUserId: conn.userId,
					maxPlayers: Math.min(p.maxPlayers, gameLimits[p.gameId].maxPlayers),
					isPublic: p.isPublic,
					settings: p.settings
				});
				const snap = await buildLobbySnapshot(lobbyId);
				if (!snap) throw new Error('lobby-not-found');
				const room = new LobbyRoom(lobbyId, snap, this.roomDeps());
				this.lobbyRooms.set(lobbyId, room);
				await room.join(conn);
				return { lobby: room.state() };
			}
			case 'lobby.join': {
				const p = requestPayloads['lobby.join'].parse(payload);
				const row = await getLobbyByCode(p.code);
				if (!row) throw new Error('lobby-not-found');
				if (row.status === 'closed') throw new Error('lobby-closed');
				let room = this.lobbyRooms.get(row.id);
				if (!room) {
					const snap = await buildLobbySnapshot(row.id);
					if (!snap) throw new Error('lobby-not-found');
					room = new LobbyRoom(row.id, snap, this.roomDeps());
					this.lobbyRooms.set(row.id, room);
				}
				if (room.isPlaying) throw new Error('match-in-progress');
				await joinLobby(row.id, conn.userId);
				await room.join(conn);
				return { lobby: room.state() };
			}
			case 'lobby.leave': {
				const p = requestPayloads['lobby.leave'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (room) await room.leave(conn);
				return { ok: true };
			}
			case 'lobby.delete': {
				const p = requestPayloads['lobby.delete'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (!room) throw new Error('not-in-lobby');
				await room.deleteLobby(conn);
				return { ok: true };
			}
			case 'lobby.list': {
				const p = requestPayloads['lobby.list'].parse(payload);
				return { lobbies: await listPublicLobbies(p.gameId) };
			}
			case 'lobby.ready': {
				const p = requestPayloads['lobby.ready'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (!room) throw new Error('not-in-lobby');
				await room.setReadyState(conn, p.ready);
				return { ok: true };
			}
			case 'lobby.start': {
				const p = requestPayloads['lobby.start'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (!room) throw new Error('not-in-lobby');
				await room.startGame(conn);
				return { ok: true };
			}
			case 'lobby.kick': {
				const p = requestPayloads['lobby.kick'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (!room) throw new Error('not-in-lobby');
				await room.kick(conn, p.userId);
				return { ok: true };
			}
			case 'lobby.settings': {
				const p = requestPayloads['lobby.settings'].parse(payload);
				const room = this.roomForConnection(conn, p.lobbyId);
				if (!room) throw new Error('not-in-lobby');
				await room.updateSettings(conn, {
					name: p.name,
					gameId: p.gameId,
					maxPlayers: p.maxPlayers,
					isPublic: p.isPublic,
					settings: p.settings
				});
				return { ok: true };
			}
			case 'profile.get': {
				const p = requestPayloads['profile.get'].parse(payload);
				const row = p.username
					? await getProfileByUsername(p.username)
					: await getProfile(conn.userId);
				if (!row) throw new Error('profile-not-found');
				return { profile: publicProfile(row) };
			}
			case 'profile.save': {
				const p = requestPayloads['profile.save'].parse(payload);
				const row = await updateProfile(conn.userId, {
					username: p.username,
					displayName: p.displayName,
					bio: p.bio,
					avatarJson: p.avatarJson ? JSON.stringify(p.avatarJson) : undefined
				});
				if (p.displayName) conn.displayName = p.displayName;
				return { profile: publicProfile(row) };
			}
			default:
				throw new Error('unknown-request');
		}
	}

	// -- match lifecycle -----------------------------------------------------

	private roomDeps() {
		return {
			launchMatch: (snapshot: LobbySnapshot) => this.launchMatch(snapshot),
			destroyRoom: (lobbyId: string) => this.lobbyRooms.delete(lobbyId)
		};
	}

	private async launchMatch(lobby: LobbySnapshot): Promise<void> {
		const room = this.lobbyRooms.get(lobby.id);
		if (!room) throw new Error('not-in-lobby');
		const players: SimPlayer[] = lobby.members.map((m, i) => ({
			id: m.userId,
			name: m.displayName,
			color: SLOT_COLORS[i % SLOT_COLORS.length],
			slot: i
		}));
		const seed = randomSeed();
		// lobby settings (host-configurable) override the game defaults
		const base = gameConfigs[lobby.gameId];
		const config: GameConfig = {
			...base,
			options: { ...base.options, ...lobby.settings }
		};
		const sim = createServerSim(lobby.gameId, seed, config, players);
		const matchId = await createMatch({
			lobbyId: lobby.id,
			gameId: lobby.gameId,
			seed,
			settings: config.options,
			playerUserIds: players.map((p) => p.id)
		});
		const gameRoom = new GameRoom({
			matchId,
			gameId: lobby.gameId,
			sim,
			config,
			players,
			broadcast: (msg) => room.broadcast(msg),
			onEnd: (results) => void this.handleMatchEnd(lobby, matchId, results)
		});
		this.gameRooms.set(matchId, gameRoom);
		const startAt = Date.now() + MATCH_START_DELAY_MS;
		room.broadcast({
			t: 'game.start',
			d: {
				matchId,
				gameId: lobby.gameId,
				seed,
				players: players.map((p) => ({
					id: p.id,
					name: p.name,
					color: p.color,
					slot: p.slot
				})),
				config,
				startAt
			}
		});
		gameRoom.start(startAt);
	}

	private async handleMatchEnd(
		lobby: LobbySnapshot,
		matchId: string,
		results: MatchResult[]
	): Promise<void> {
		this.gameRooms.delete(matchId);
		await finishMatch(matchId, results, 'finished');
		for (const r of results) {
			await upsertBestScore({
				gameId: lobby.gameId,
				userId: r.player,
				mode: 'casual',
				key: 'global',
				value: r.score,
				higherIsBetter: true
			});
		}
		const room = this.lobbyRooms.get(lobby.id);
		if (room) {
			room.broadcast({ t: 'game.end', d: { matchId, results } });
			await room.matchEnded();
		}
	}
}

function publicProfile(row: ProfileRow) {
	return {
		userId: row.userId,
		username: row.username,
		displayName: row.displayName,
		avatarJson: parseAvatar(row.avatarJson),
		bio: row.bio,
		createdAt: row.createdAt.getTime()
	};
}

function humanError(code: string): string {
	const messages: Record<string, string> = {
		'lobby-not-found': 'Lobby not found — check the code',
		'lobby-full': 'That lobby is full',
		'lobby-closed': 'That lobby is closed',
		'lobby-deleted': 'The host deleted this lobby',
		'match-in-progress': 'A match is already running — wait for it to end',
		'not-host': 'Only the host can do that',
		'not-everyone-ready': 'Everyone must be ready first',
		'not-in-lobby': 'You are not in that lobby',
		'username-taken': 'That username is taken',
		'game-unavailable': 'That game is not available yet',
		'too-many-players': 'Too many players for that game — remove some first',
		'too-few-players': 'That lobby is too small for that game',
		'cannot-kick-self': 'You cannot kick yourself',
		'rate-limited': 'Slow down a bit!',
		'unknown-request': 'Unknown request'
	};
	return messages[code] ?? 'Something went wrong';
}

let instance: RealtimeServer | null = null;

export function getRealtimeServer(): RealtimeServer {
	if (!instance) instance = new RealtimeServer();
	return instance;
}
