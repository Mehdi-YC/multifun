import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { bestScore, profile } from '$lib/server/db/schema';
import type { GameId } from '$lib/game/types';

export interface LeaderboardEntry {
	userId: string;
	username: string;
	displayName: string;
	avatarJson: string;
	value: number;
	updatedAt: number;
	rank: number;
}

/**
 * Store the user's best value for a game/mode/key.
 * `higherIsBetter` picks the comparison direction (false = time trials).
 */
export async function upsertBestScore(input: {
	gameId: GameId;
	userId: string;
	mode: string;
	key: string;
	value: number;
	higherIsBetter?: boolean;
}): Promise<boolean> {
	const higher = input.higherIsBetter ?? true;
	const existing = await db
		.select()
		.from(bestScore)
		.where(
			and(
				eq(bestScore.gameId, input.gameId),
				eq(bestScore.userId, input.userId),
				eq(bestScore.mode, input.mode),
				eq(bestScore.key, input.key)
			)
		)
		.limit(1);
	const current = existing[0];
	if (current && (higher ? current.value >= input.value : current.value <= input.value)) {
		return false;
	}
	await db
		.insert(bestScore)
		.values({
			gameId: input.gameId,
			userId: input.userId,
			mode: input.mode,
			key: input.key,
			value: input.value
		})
		.onConflictDoUpdate({
			target: [bestScore.gameId, bestScore.mode, bestScore.key, bestScore.userId],
			set: { value: input.value, updatedAt: new Date() }
		});
	return true;
}

export async function leaderboard(input: {
	gameId: GameId;
	mode: string;
	key: string;
	higherIsBetter?: boolean;
	limit?: number;
}): Promise<LeaderboardEntry[]> {
	const limit = input.limit ?? 50;
	const higher = input.higherIsBetter ?? true;
	const rows = await db
		.select({
			userId: bestScore.userId,
			value: bestScore.value,
			updatedAt: bestScore.updatedAt,
			username: profile.username,
			displayName: profile.displayName,
			avatarJson: profile.avatarJson
		})
		.from(bestScore)
		.innerJoin(profile, eq(profile.userId, bestScore.userId))
		.where(
			and(
				eq(bestScore.gameId, input.gameId),
				eq(bestScore.mode, input.mode),
				eq(bestScore.key, input.key)
			)
		)
		.orderBy(higher ? desc(bestScore.value) : bestScore.value)
		.limit(limit);
	return rows.map((r, i) => ({
		userId: r.userId,
		username: r.username,
		displayName: r.displayName,
		avatarJson: r.avatarJson,
		value: r.value,
		updatedAt: r.updatedAt.getTime(),
		rank: i + 1
	}));
}

export async function userBest(input: {
	gameId: GameId;
	userId: string;
	mode: string;
	key: string;
}): Promise<number | null> {
	const [row] = await db
		.select({ value: bestScore.value })
		.from(bestScore)
		.where(
			and(
				eq(bestScore.gameId, input.gameId),
				eq(bestScore.userId, input.userId),
				eq(bestScore.mode, input.mode),
				eq(bestScore.key, input.key)
			)
		)
		.limit(1);
	return row?.value ?? null;
}
