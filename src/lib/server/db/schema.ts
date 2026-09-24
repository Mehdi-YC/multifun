import { relations, sql } from 'drizzle-orm';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';
import { user } from './auth.schema';

// ---------------------------------------------------------------------------
// Profiles (1:1 with better-auth user)
// ---------------------------------------------------------------------------

export const profile = sqliteTable(
	'profile',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		username: text('username').notNull(),
		displayName: text('display_name').notNull(),
		/** JSON-serialized AvatarConfig — procedural pixel avatar. */
		avatarJson: text('avatar_json').notNull(),
		bio: text('bio').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(t) => [uniqueIndex('profile_username_uq').on(t.username)]
);

// ---------------------------------------------------------------------------
// Lobbies
// ---------------------------------------------------------------------------

export const lobbyStatus = ['open', 'playing', 'closed'] as const;
export type LobbyStatus = (typeof lobbyStatus)[number];

export const lobby = sqliteTable(
	'lobby',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid(12)),
		/** 6-char human-readable join code. */
		code: text('code').notNull(),
		name: text('name').notNull(),
		gameId: text('game_id').notNull(),
		hostUserId: text('host_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		status: text('status', { enum: lobbyStatus }).notNull().default('open'),
		maxPlayers: integer('max_players').notNull().default(4),
		isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(true),
		settingsJson: text('settings_json').notNull().default('{}'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		closedAt: integer('closed_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('lobby_code_uq').on(t.code),
		index('lobby_status_game_idx').on(t.status, t.gameId)
	]
);

export const lobbyMember = sqliteTable(
	'lobby_member',
	{
		lobbyId: text('lobby_id')
			.notNull()
			.references(() => lobby.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		slot: integer('slot').notNull(),
		role: text('role', { enum: ['host', 'player'] })
			.notNull()
			.default('player'),
		isReady: integer('is_ready', { mode: 'boolean' }).notNull().default(false),
		joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		leftAt: integer('left_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		primaryKey({ columns: [t.lobbyId, t.userId] }),
		index('lobby_member_user_idx').on(t.userId)
	]
);

export const lobbyMessage = sqliteTable(
	'lobby_message',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid(12)),
		lobbyId: text('lobby_id')
			.notNull()
			.references(() => lobby.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		text: text('text').notNull(),
		sentAt: integer('sent_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(t) => [index('lobby_message_lobby_idx').on(t.lobbyId, t.sentAt)]
);

// ---------------------------------------------------------------------------
// Matches & scores
// ---------------------------------------------------------------------------

export const matchStatus = ['playing', 'finished', 'aborted'] as const;
export type MatchStatus = (typeof matchStatus)[number];

export const match = sqliteTable('match', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => nanoid(12)),
	lobbyId: text('lobby_id')
		.notNull()
		.references(() => lobby.id, { onDelete: 'cascade' }),
	gameId: text('game_id').notNull(),
	seed: integer('seed').notNull(),
	settingsJson: text('settings_json').notNull().default('{}'),
	status: text('status', { enum: matchStatus }).notNull().default('playing'),
	startedAt: integer('started_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	endedAt: integer('ended_at', { mode: 'timestamp_ms' })
});

export const matchPlayer = sqliteTable(
	'match_player',
	{
		matchId: text('match_id')
			.notNull()
			.references(() => match.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		placement: integer('placement').notNull().default(0),
		score: integer('score').notNull().default(0),
		statsJson: text('stats_json').notNull().default('{}'),
		disconnected: integer('disconnected', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [primaryKey({ columns: [t.matchId, t.userId] }), index('match_player_user_idx').on(t.userId)]
);

/** Individual attempts/runs (e.g. GeoDash level attempts, kart lap records). */
export const run = sqliteTable(
	'run',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => nanoid(12)),
		matchId: text('match_id').references(() => match.id, { onDelete: 'set null' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		gameId: text('game_id').notNull(),
		/** level id / track id / stage id depending on game. */
		levelId: text('level_id').notNull(),
		value: integer('value').notNull(),
		unit: text('unit', { enum: ['ms', 'score', 'progress'] }).notNull().default('score'),
		endedAt: integer('ended_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(t) => [index('run_lookup_idx').on(t.gameId, t.levelId, t.userId)]
);

/** Single leaderboard source: best value per game/mode/key per user. */
export const bestScore = sqliteTable(
	'best_score',
	{
		gameId: text('game_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		mode: text('mode').notNull(),
		/** level/track/stage identifier ('global' when not applicable). */
		key: text('key').notNull(),
		value: integer('value').notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(t) => [
		primaryKey({ columns: [t.gameId, t.mode, t.key, t.userId] }),
		index('best_score_rank_idx').on(t.gameId, t.mode, t.key, t.value)
	]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const profileRelations = relations(profile, ({ one }) => ({
	user: one(user, { fields: [profile.userId], references: [user.id] })
}));

export * from './auth.schema';
