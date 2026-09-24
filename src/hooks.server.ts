import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { ensureProfile } from '$lib/server/profile';

/** Users whose profile row is known to exist (avoids a query per request). */
const profiled = new Set<string>();

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
		if (!profiled.has(session.user.id)) {
			await ensureProfile(
				session.user.id,
				session.user.name || session.user.email?.split('@')[0] || 'player'
			);
			profiled.add(session.user.id);
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
