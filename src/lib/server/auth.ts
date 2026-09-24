import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

export const auth = betterAuth({
	// Empty ORIGIN => infer from the request, so any dev port works.
	// Set ORIGIN explicitly in production.
	baseURL: env.ORIGIN || undefined,
	secret: env.BETTER_AUTH_SECRET,
	// better-auth falls back to a single shared rate-limit bucket when it can't
	// resolve a client IP, and its built-in auth rule is 3 sign-ins/ups per 10s —
	// way too tight for tests and busy lobbies. Custom rules override by path.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 500,
		customRules: {
			'/sign-in/email': { window: 60, max: 30 },
			'/sign-up/email': { window: 60, max: 30 }
		}
	},
	database: drizzleAdapter(db, { provider: 'sqlite' }),
	emailAndPassword: { enabled: true },
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
