import { eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { profile } from '$lib/server/db/schema';
import { randomAvatar, type AvatarConfig } from '$lib/game/assets/avatar';
import { avatarConfigSchema } from '$lib/net/protocol';

export interface ProfileRow {
	userId: string;
	username: string;
	displayName: string;
	avatarJson: string;
	bio: string;
	createdAt: Date;
	lastSeenAt: Date;
}

export function parseAvatar(json: string): AvatarConfig {
	const parsed = avatarConfigSchema.safeParse(JSON.parse(json));
	if (parsed.success) return parsed.data;
	return randomAvatar(1);
}

function sanitizeUsername(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '')
		.slice(0, 16);
}

async function uniqueUsername(base: string): Promise<string> {
	const root = sanitizeUsername(base) || 'player';
	for (let attempt = 0; attempt < 50; attempt++) {
		const candidate = attempt === 0 ? root : `${root}${attempt + 1}`;
		const existing = await db
			.select({ userId: profile.userId })
			.from(profile)
			.where(eq(profile.username, candidate))
			.limit(1);
		if (existing.length === 0) return candidate;
	}
	return `${root}_${Date.now().toString(36)}`;
}

/** Create a profile on first login; idempotent. */
export async function ensureProfile(userId: string, fallbackName: string): Promise<ProfileRow> {
	const existing = await getProfile(userId);
	if (existing) return existing;
	const username = await uniqueUsername(fallbackName);
	const [row] = await db
		.insert(profile)
		.values({
			userId,
			username,
			displayName: fallbackName.slice(0, 24) || username,
			avatarJson: JSON.stringify(randomAvatar())
		})
		.returning();
	return row;
}

export async function getProfile(userId: string): Promise<ProfileRow | null> {
	const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
	return row ?? null;
}

export async function getProfileByUsername(username: string): Promise<ProfileRow | null> {
	const [row] = await db
		.select()
		.from(profile)
		.where(eq(profile.username, username.toLowerCase()))
		.limit(1);
	return row ?? null;
}

export async function getProfiles(userIds: string[]): Promise<Map<string, ProfileRow>> {
	const map = new Map<string, ProfileRow>();
	if (userIds.length === 0) return map;
	const rows = await db.select().from(profile).where(inArray(profile.userId, userIds));
	for (const row of rows) map.set(row.userId, row);
	return map;
}

export interface ProfilePatch {
	username?: string;
	displayName?: string;
	bio?: string;
	avatarJson?: string;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<ProfileRow> {
	if (patch.username) {
		const wanted = sanitizeUsername(patch.username);
		const taken = await db
			.select({ userId: profile.userId })
			.from(profile)
			.where(eq(profile.username, wanted))
			.limit(1);
		if (taken.length > 0 && taken[0].userId !== userId) {
			throw new Error('username-taken');
		}
		patch.username = wanted;
	}
	const [row] = await db
		.update(profile)
		.set({ ...patch, lastSeenAt: new Date() })
		.where(eq(profile.userId, userId))
		.returning();
	if (!row) throw new Error('profile-not-found');
	return row;
}

export async function touchLastSeen(userId: string): Promise<void> {
	await db.update(profile).set({ lastSeenAt: new Date() }).where(eq(profile.userId, userId));
}
