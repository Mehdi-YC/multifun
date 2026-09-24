import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { GAME_META, isGameId } from '$lib/game/meta';
import { listPublicLobbies } from '$lib/server/lobby';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	if (!isGameId(params.gameId)) error(404, 'Unknown game');
	const meta = GAME_META[params.gameId];
	const lobbies = await listPublicLobbies(params.gameId);
	return { game: meta, initialLobbies: lobbies };
};
