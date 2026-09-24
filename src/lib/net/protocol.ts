/**
 * Realtime wire protocol (v1). Shared by client and server; zod validates every
 * inbound message on the server. JSON envelopes over WebSocket at /realtime.
 */
import { z } from 'zod';
import type { GameEvent, GameId, GameStatePatch, MatchResult } from '$lib/game/types';

export const PROTOCOL_VERSION = 1;

const gameEventSchema: z.ZodType<GameEvent> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('spawn'), player: z.string() }),
		z.object({ kind: z.literal('death'), player: z.string(), cause: z.string() }),
		z.object({ kind: z.literal('respawn'), player: z.string() }),
		z.object({ kind: z.literal('finish'), player: z.string(), timeMs: z.number() }),
		z.object({ kind: z.literal('collect'), player: z.string(), item: z.string() }),
		z.object({
			kind: z.literal('hit'),
			player: z.string(),
			by: z.string(),
			force: z.number()
		}),
		z.object({ kind: z.literal('boost'), player: z.string(), power: z.number() }),
		z.object({
			kind: z.literal('lap'),
			player: z.string(),
			lap: z.number(),
			timeMs: z.number()
		}),
		z.object({ kind: z.literal('countdown'), value: z.number() }),
		z.object({ kind: z.literal('match-end') })
	])
) as z.ZodType<GameEvent>;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const avatarConfigSchema = z.object({
	version: z.literal(1),
	seed: z.number().int(),
	skin: z.string(),
	hair: z.string(),
	eyes: z.string(),
	outfit: z.string(),
	bg: z.string(),
	style: z.enum(['square', 'round', 'visor', 'ghost']),
	hairStyle: z.enum(['spiky', 'bob', 'cap', 'bald', 'ponytail'])
});
export type AvatarConfig = z.infer<typeof avatarConfigSchema>;

export const gameIdSchema = z.enum(['echo', 'geodash', 'kart', 'brawl']);

export const memberSnapshotSchema = z.object({
	userId: z.string(),
	username: z.string(),
	displayName: z.string(),
	avatarJson: avatarConfigSchema,
	slot: z.number().int(),
	role: z.enum(['host', 'player']),
	isReady: z.boolean(),
	connected: z.boolean()
});
export type MemberSnapshot = z.infer<typeof memberSnapshotSchema>;

export const lobbySnapshotSchema = z.object({
	id: z.string(),
	code: z.string(),
	name: z.string(),
	gameId: gameIdSchema,
	hostUserId: z.string(),
	status: z.enum(['open', 'playing', 'closed']),
	maxPlayers: z.number().int().min(2).max(8),
	settings: z.record(z.string(), z.unknown()),
	members: z.array(memberSnapshotSchema),
	createdAt: z.number()
});
export type LobbySnapshot = z.infer<typeof lobbySnapshotSchema>;

export const lobbyListItemSchema = z.object({
	id: z.string(),
	code: z.string(),
	name: z.string(),
	gameId: gameIdSchema,
	playerCount: z.number().int(),
	maxPlayers: z.number().int(),
	status: z.enum(['open', 'playing', 'closed']),
	hostName: z.string()
});
export type LobbyListItem = z.infer<typeof lobbyListItemSchema>;

export const matchResultSchema = z.object({
	player: z.string(),
	placement: z.number().int(),
	score: z.number(),
	stats: z.record(z.string(), z.number())
});

export const playerSlotSchema = z.object({
	id: z.string(),
	name: z.string(),
	color: z.string(),
	slot: z.number().int()
});

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('t', [
	z.object({
		t: z.literal('hello'),
		id: z.number().int().optional(),
		d: z.object({ token: z.string(), version: z.number().int() })
	}),
	z.object({
		t: z.literal('req'),
		id: z.number().int(),
		d: z.object({ t: z.string(), d: z.unknown().optional() })
	}),
	z.object({
		t: z.literal('input'),
		d: z.object({
			matchId: z.string(),
			tick: z.number().int(),
			seq: z.number().int(),
			keys: z.number().int()
		})
	}),
	z.object({
		t: z.literal('chat'),
		d: z.object({ lobbyId: z.string(), text: z.string().min(1).max(300) })
	}),
	z.object({ t: z.literal('ping'), d: z.object({ ts: z.number() }) })
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** The `req.d.t` commands the server understands, with their payloads. */
export const requestPayloads = {
	'lobby.create': z.object({
		name: z.string().min(1).max(32),
		gameId: gameIdSchema,
		maxPlayers: z.number().int().min(2).max(8).default(4),
		isPublic: z.boolean().default(true),
		settings: z.record(z.string(), z.unknown()).default({})
	}),
	'lobby.join': z.object({ code: z.string().min(4).max(8) }),
	'lobby.leave': z.object({ lobbyId: z.string() }),
	'lobby.list': z.object({ gameId: gameIdSchema.optional() }),
	'lobby.ready': z.object({ lobbyId: z.string(), ready: z.boolean() }),
	'lobby.start': z.object({ lobbyId: z.string() }),
	'lobby.kick': z.object({ lobbyId: z.string(), userId: z.string() }),
	'lobby.settings': z.object({
		lobbyId: z.string(),
		name: z.string().min(1).max(32).optional(),
		maxPlayers: z.number().int().min(2).max(8).optional(),
		isPublic: z.boolean().optional(),
		settings: z.record(z.string(), z.unknown()).optional()
	}),
	'profile.get': z.object({ username: z.string().optional() }),
	'profile.save': z.object({
		username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/).optional(),
		displayName: z.string().min(1).max(24).optional(),
		bio: z.string().max(200).optional(),
		avatarJson: avatarConfigSchema.optional()
	})
} as const;
export type RequestName = keyof typeof requestPayloads;
export type RequestPayload<N extends RequestName> = z.infer<(typeof requestPayloads)[N]>;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface Presence {
	userId: string;
	username: string;
	displayName: string;
	online: boolean;
}

export type ServerMessage =
	| { t: 'welcome'; d: { userId: string; sessionId: string; serverTick: number } }
	| {
			t: 'ack';
			id: number;
			ok: boolean;
			d?: unknown;
			err?: { code: string; msg: string };
	  }
	| { t: 'lobby.state'; d: LobbySnapshot }
	| { t: 'lobby.list'; d: LobbyListItem[] }
	| { t: 'presence'; d: { lobbyId: string; users: Presence[] } }
	| {
			t: 'chat.msg';
			d: { lobbyId: string; from: string; fromName: string; text: string; ts: number };
	  }
	| {
			t: 'game.start';
			d: {
				matchId: string;
				gameId: GameId;
				seed: number;
				players: z.infer<typeof playerSlotSchema>[];
				config: { tickRate: number; durationTicks: number; options: Record<string, unknown> };
				startAt: number;
			};
	  }
	| { t: 'game.snap'; d: { matchId: string; tick: number; state: GameStatePatch } }
	| { t: 'game.event'; d: { matchId: string; tick: number; ev: GameEvent } }
	| { t: 'game.end'; d: { matchId: string; results: MatchResult[] } }
	| { t: 'err'; d: { code: string; msg: string } };

export function parseClientMessage(raw: string): ClientMessage | null {
	try {
		const parsed = clientMessageSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
