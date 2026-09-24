import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { GAME_META, isGameId } from '$lib/game/meta';
import { leaderboard } from '$lib/server/scores';
import { parseAvatar } from '$lib/server/profile';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!isGameId(params.gameId)) error(404, 'Unknown game');
	const rows = await leaderboard({
		gameId: params.gameId,
		mode: 'casual',
		key: 'global',
		limit: 50
	});
	return {
		game: GAME_META[params.gameId],
		entries: rows.map((r) => ({
			rank: r.rank,
			username: r.username,
			displayName: r.displayName,
			avatarJson: parseAvatar(r.avatarJson),
			value: r.value
		})),
		selfUserId: locals.user?.id ?? null
	};
};
