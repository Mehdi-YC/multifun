import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { buildLobbySnapshot, getLobbyByCode, recentMessages } from '$lib/server/lobby';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	const row = await getLobbyByCode(params.code);
	if (!row || row.status === 'closed') error(404, 'Lobby not found');
	const snapshot = await buildLobbySnapshot(row.id);
	const messages = await recentMessages(row.id, 50);
	return {
		lobby: snapshot,
		messages,
		selfUserId: locals.user.id
	};
};
