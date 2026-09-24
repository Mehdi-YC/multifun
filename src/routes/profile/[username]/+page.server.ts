import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfileByUsername, parseAvatar } from '$lib/server/profile';
import { userStats } from '$lib/server/stats';

export const load: PageServerLoad = async ({ params, locals }) => {
	const row = await getProfileByUsername(params.username);
	if (!row) error(404, 'Player not found');
	const stats = await userStats(row.userId);
	return {
		profile: {
			username: row.username,
			displayName: row.displayName,
			avatarJson: parseAvatar(row.avatarJson),
			bio: row.bio,
			createdAt: row.createdAt.getTime()
		},
		stats,
		isSelf: locals.user?.id === row.userId
	};
};
