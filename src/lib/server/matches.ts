import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { match, matchPlayer, run } from '$lib/server/db/schema';
import type { GameId, MatchResult } from '$lib/game/types';

export async function createMatch(input: {
	lobbyId: string;
	gameId: GameId;
	seed: number;
	settings: Record<string, unknown>;
	playerUserIds: string[];
}): Promise<string> {
	const [row] = await db
		.insert(match)
		.values({
			lobbyId: input.lobbyId,
			gameId: input.gameId,
			seed: input.seed,
			settingsJson: JSON.stringify(input.settings)
		})
		.returning({ id: match.id });
	await db.insert(matchPlayer).values(
		input.playerUserIds.map((userId) => ({
			matchId: row.id,
			userId
		})) as (typeof matchPlayer.$inferInsert)[]
	);
	return row.id;
}

/** Persist final placements/scores. `results.player` is the user id. */
export async function finishMatch(
	matchId: string,
	results: MatchResult[],
	status: 'finished' | 'aborted' = 'finished'
): Promise<void> {
	await db
		.update(match)
		.set({ status, endedAt: new Date() })
		.where(eq(match.id, matchId));
	for (const r of results) {
		await db
			.update(matchPlayer)
			.set({
				placement: r.placement,
				score: r.score,
				statsJson: JSON.stringify(r.stats)
			})
			.where(and(eq(matchPlayer.matchId, matchId), eq(matchPlayer.userId, r.player)));
	}
}

export async function recordRun(input: {
	matchId?: string;
	userId: string;
	gameId: GameId;
	levelId: string;
	value: number;
	unit: 'ms' | 'score' | 'progress';
}): Promise<void> {
	await db.insert(run).values({
		matchId: input.matchId ?? null,
		userId: input.userId,
		gameId: input.gameId,
		levelId: input.levelId,
		value: input.value,
		unit: input.unit
	});
}
