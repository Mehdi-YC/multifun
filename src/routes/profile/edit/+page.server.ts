import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getProfile, parseAvatar, updateProfile } from '$lib/server/profile';
import { avatarConfigSchema } from '$lib/net/protocol';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	const row = await getProfile(locals.user.id);
	if (!row) redirect(302, '/login');
	return {
		profile: {
			username: row.username,
			displayName: row.displayName,
			avatarJson: parseAvatar(row.avatarJson),
			bio: row.bio
		}
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		const form = await request.formData();
		const username = String(form.get('username') ?? '');
		const displayName = String(form.get('displayName') ?? '');
		const bio = String(form.get('bio') ?? '');
		const avatarRaw = String(form.get('avatarJson') ?? '');

		let avatarJson: string | undefined;
		if (avatarRaw) {
			const parsed = avatarConfigSchema.safeParse(JSON.parse(avatarRaw));
			if (!parsed.success) return fail(400, { message: 'Invalid avatar' });
			avatarJson = JSON.stringify(parsed.data);
		}

		try {
			await updateProfile(locals.user.id, {
				username: username || undefined,
				displayName: displayName || undefined,
				bio,
				avatarJson
			});
		} catch (err) {
			const code = err instanceof Error ? err.message : 'error';
			return fail(400, {
				message: code === 'username-taken' ? 'That username is taken' : 'Could not save profile'
			});
		}

		redirect(303, `/profile/${username.toLowerCase()}`);
	}
};
