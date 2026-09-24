import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '$lib/server/db';
import { lobby, lobbyMember, lobbyMessage, type LobbyStatus } from '$lib/server/db/schema';
import { lobbyCode } from '$lib/server/ids';
import { getProfiles, type ProfileRow } from '$lib/server/profile';
import type { GameId } from '$lib/game/types';
import type { LobbyListItem, LobbySnapshot, MemberSnapshot } from '$lib/net/protocol';

export interface CreateLobbyInput {
	name: string;
	gameId: GameId;
	hostUserId: string;
	maxPlayers: number;
	isPublic: boolean;
	settings: Record<string, unknown>;
}

export async function createLobby(input: CreateLobbyInput): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const [row] = await db
				.insert(lobby)
				.values({
					code: lobbyCode(),
					name: input.name,
					gameId: input.gameId,
					hostUserId: input.hostUserId,
					maxPlayers: input.maxPlayers,
					isPublic: input.isPublic,
					settingsJson: JSON.stringify(input.settings)
				})
				.returning({ id: lobby.id });
			await joinLobby(row.id, input.hostUserId, 'host');
			return row.id;
		} catch (err) {
			// unique code collision — retry with a fresh code
			if (attempt === 9) throw err;
		}
	}
	throw new Error('lobby-create-failed');
}

export async function joinLobby(
	lobbyId: string,
	userId: string,
	role: 'host' | 'player' = 'player'
): Promise<void> {
	const all = await db.select().from(lobbyMember).where(eq(lobbyMember.lobbyId, lobbyId));
	const active = all.filter((m) => m.leftAt === null);
	const existing = all.find((m) => m.userId === userId);
	if (existing) {
		if (existing.leftAt === null) return; // already in (page refresh) — keep ready state
		// genuine rejoin after leave/kick: reactivate the same slot, un-ready
		await db
			.update(lobbyMember)
			.set({ leftAt: null, isReady: false })
			.where(and(eq(lobbyMember.lobbyId, lobbyId), eq(lobbyMember.userId, userId)));
		return;
	}
	if (active.length >= (await getMaxPlayers(lobbyId))) throw new Error('lobby-full');
	const usedSlots = new Set(active.map((m) => m.slot));
	let slot = 0;
	while (usedSlots.has(slot)) slot++;
	await db.insert(lobbyMember).values({ lobbyId, userId, slot, role });
}

async function getMaxPlayers(lobbyId: string): Promise<number> {
	const [row] = await db
		.select({ maxPlayers: lobby.maxPlayers })
		.from(lobby)
		.where(eq(lobby.id, lobbyId))
		.limit(1);
	return row?.maxPlayers ?? 8;
}

export async function leaveLobby(lobbyId: string, userId: string): Promise<void> {
	await db
		.update(lobbyMember)
		.set({ leftAt: new Date() })
		.where(and(eq(lobbyMember.lobbyId, lobbyId), eq(lobbyMember.userId, userId)));
}

export async function setReady(lobbyId: string, userId: string, ready: boolean): Promise<void> {
	await db
		.update(lobbyMember)
		.set({ isReady: ready })
		.where(and(eq(lobbyMember.lobbyId, lobbyId), eq(lobbyMember.userId, userId)));
}

export async function promoteHost(lobbyId: string, userId: string): Promise<void> {
	await db.update(lobby).set({ hostUserId: userId }).where(eq(lobby.id, lobbyId));
	await db
		.update(lobbyMember)
		.set({ role: 'host' })
		.where(and(eq(lobbyMember.lobbyId, lobbyId), eq(lobbyMember.userId, userId)));
}

export async function demoteFromHost(lobbyId: string, userId: string): Promise<void> {
	await db
		.update(lobbyMember)
		.set({ role: 'player' })
		.where(and(eq(lobbyMember.lobbyId, lobbyId), eq(lobbyMember.userId, userId)));
}

export async function updateLobbySettings(
	lobbyId: string,
	patch: {
		name?: string;
		maxPlayers?: number;
		isPublic?: boolean;
		settings?: Record<string, unknown>;
	}
): Promise<void> {
	const values: Partial<typeof lobby.$inferInsert> = {};
	if (patch.name !== undefined) values.name = patch.name;
	if (patch.maxPlayers !== undefined) values.maxPlayers = patch.maxPlayers;
	if (patch.isPublic !== undefined) values.isPublic = patch.isPublic;
	if (patch.settings !== undefined) values.settingsJson = JSON.stringify(patch.settings);
	await db.update(lobby).set(values).where(eq(lobby.id, lobbyId));
}

export async function setLobbyStatus(lobbyId: string, status: LobbyStatus): Promise<void> {
	await db
		.update(lobby)
		.set({ status, closedAt: status === 'closed' ? new Date() : null })
		.where(eq(lobby.id, lobbyId));
}

export async function getLobbyByCode(code: string): Promise<typeof lobby.$inferSelect | null> {
	const [row] = await db.select().from(lobby).where(eq(lobby.code, code.toUpperCase())).limit(1);
	return row ?? null;
}

export async function getLobbyById(id: string): Promise<typeof lobby.$inferSelect | null> {
	const [row] = await db.select().from(lobby).where(eq(lobby.id, id)).limit(1);
	return row ?? null;
}

export async function activeMembers(lobbyId: string): Promise<(typeof lobbyMember.$inferSelect)[]> {
	return db
		.select()
		.from(lobbyMember)
		.where(and(eq(lobbyMember.lobbyId, lobbyId), isNull(lobbyMember.leftAt)))
		.orderBy(lobbyMember.slot);
}

export async function buildLobbySnapshot(lobbyId: string): Promise<LobbySnapshot | null> {
	const row = await getLobbyById(lobbyId);
	if (!row) return null;
	const members = await activeMembers(lobbyId);
	const profiles = await getProfiles(members.map((m) => m.userId));
	const memberSnapshots: MemberSnapshot[] = members.map((m) => {
		const p = profiles.get(m.userId);
		return {
			userId: m.userId,
			username: p?.username ?? 'unknown',
			displayName: p?.displayName ?? 'Unknown',
			avatarJson: p ? safeAvatar(p) : defaultAvatar(),
			slot: m.slot,
			role: m.role,
			isReady: m.isReady,
			connected: true
		};
	});
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		gameId: row.gameId as GameId,
		hostUserId: row.hostUserId,
		status: row.status,
		maxPlayers: row.maxPlayers,
		settings: JSON.parse(row.settingsJson) as Record<string, unknown>,
		members: memberSnapshots,
		createdAt: row.createdAt.getTime()
	};
}

function safeAvatar(p: ProfileRow) {
	try {
		return JSON.parse(p.avatarJson) as LobbySnapshot['members'][number]['avatarJson'];
	} catch {
		return defaultAvatar();
	}
}

function defaultAvatar() {
	return {
		version: 1 as const,
		seed: 0,
		skin: '#f2d0b6',
		hair: '#2b2b3d',
		eyes: '#2b6cff',
		outfit: '#ff5c7a',
		bg: '#262647',
		style: 'square' as const,
		hairStyle: 'spiky' as const
	};
}

export async function listPublicLobbies(gameId?: GameId): Promise<LobbyListItem[]> {
	const rows = await db
		.select()
		.from(lobby)
		.where(and(eq(lobby.isPublic, true), eq(lobby.status, 'open')))
		.orderBy(desc(lobby.createdAt))
		.limit(50);
	const filtered = gameId ? rows.filter((r) => r.gameId === gameId) : rows;
	const out: LobbyListItem[] = [];
	for (const row of filtered) {
		const members = await activeMembers(row.id);
		const hosts = await getProfiles([row.hostUserId]);
		out.push({
			id: row.id,
			code: row.code,
			name: row.name,
			gameId: row.gameId as GameId,
			playerCount: members.length,
			maxPlayers: row.maxPlayers,
			status: row.status,
			hostName: hosts.get(row.hostUserId)?.displayName ?? 'Unknown'
		});
	}
	return out;
}

export async function addMessage(
	lobbyId: string,
	userId: string,
	text: string
): Promise<{ id: string; sentAt: number }> {
	const [row] = await db
		.insert(lobbyMessage)
		.values({ id: nanoid(12), lobbyId, userId, text })
		.returning({ id: lobbyMessage.id, sentAt: lobbyMessage.sentAt });
	// keep history trimmed
	await trimMessages(lobbyId);
	return { id: row.id, sentAt: row.sentAt.getTime() };
}

async function trimMessages(lobbyId: string): Promise<void> {
	const recent = await db
		.select({ id: lobbyMessage.id })
		.from(lobbyMessage)
		.where(eq(lobbyMessage.lobbyId, lobbyId))
		.orderBy(desc(lobbyMessage.sentAt))
		.limit(200);
	if (recent.length === 200) {
		const keep = new Set(recent.map((r) => r.id));
		const all = await db
			.select({ id: lobbyMessage.id })
			.from(lobbyMessage)
			.where(eq(lobbyMessage.lobbyId, lobbyId));
		const stale = all.filter((r) => !keep.has(r.id)).map((r) => r.id);
		if (stale.length > 0) {
			const { inArray } = await import('drizzle-orm');
			await db.delete(lobbyMessage).where(inArray(lobbyMessage.id, stale));
		}
	}
}

export async function recentMessages(
	lobbyId: string,
	limit = 50
): Promise<{ userId: string; text: string; sentAt: number }[]> {
	const rows = await db
		.select()
		.from(lobbyMessage)
		.where(eq(lobbyMessage.lobbyId, lobbyId))
		.orderBy(desc(lobbyMessage.sentAt))
		.limit(limit);
	return rows
		.map((r) => ({ userId: r.userId, text: r.text, sentAt: r.sentAt.getTime() }))
		.reverse();
}
