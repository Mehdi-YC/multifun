import type { LayoutServerLoad } from './$types';
import { getProfile, parseAvatar } from '$lib/server/profile';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		return { user: null, profile: null };
	}
	const row = await getProfile(locals.user.id);
	return {
		user: {
			id: locals.user.id,
			email: locals.user.email,
			name: locals.user.name
		},
		profile: row
			? {
					username: row.username,
					displayName: row.displayName,
					avatarJson: parseAvatar(row.avatarJson),
					bio: row.bio
				}
			: null
	};
};
