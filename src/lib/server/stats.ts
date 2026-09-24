import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { match, matchPlayer, bestScore } from '$lib/server/db/schema';
import { getProfiles } from '$lib/server/profile';

export interface MatchSummary {
	matchId: string;
	gameId: string;
	placement: number;
	score: number;
	startedAt: number;
}

export interface UserStats {
	matchesPlayed: number;
	wins: number;
	byGame: Record<string, { played: number; wins: number; best: number }>;
	recent: (MatchSummary & { opponentNames: string[] })[];
}

export async function userStats(userId: string): Promise<UserStats> {
	const rows = await db
		.select({
			matchId: matchPlayer.matchId,
			placement: matchPlayer.placement,
			score: matchPlayer.score,
			gameId: match.gameId,
			startedAt: match.startedAt
		})
		.from(matchPlayer)
		.innerJoin(match, eq(match.id, matchPlayer.matchId))
		.where(eq(matchPlayer.userId, userId))
		.orderBy(desc(match.startedAt))
		.limit(100);

	const bests = await db.select().from(bestScore).where(eq(bestScore.userId, userId));

	const byGame: UserStats['byGame'] = {};
	for (const row of rows) {
		const entry = (byGame[row.gameId] ??= { played: 0, wins: 0, best: 0 });
		entry.played++;
		if (row.placement === 1) entry.wins++;
	}
	for (const b of bests) {
		const entry = (byGame[b.gameId] ??= { played: 0, wins: 0, best: 0 });
		entry.best = Math.max(entry.best, b.value);
	}

	const recentRows = rows.slice(0, 10);
	const recent: MatchSummary[] = recentRows.map((r) => ({
		matchId: r.matchId,
		gameId: r.gameId,
		placement: r.placement,
		score: r.score,
		startedAt: r.startedAt.getTime()
	}));

	// attach opponent names for recent matches
	const withOpponents: UserStats['recent'] = [];
	for (const summary of recent) {
		const allRows = await db
			.select({ userId: matchPlayer.userId })
			.from(matchPlayer)
			.where(eq(matchPlayer.matchId, summary.matchId));
		const others = allRows.map((r) => r.userId).filter((id) => id !== userId);
		const profiles = await getProfiles(others);
		withOpponents.push({
			...summary,
			opponentNames: others.map((id) => profiles.get(id)?.displayName ?? 'Unknown')
		});
	}

	return {
		matchesPlayed: rows.length,
		wins: rows.filter((r) => r.placement === 1).length,
		byGame,
		recent: withOpponents
	};
}
