/**
 * Reset test/pollution data in the SQLite DB:
 *
 *   bun run db:reset-test-data
 *
 * Deletes ALL lobbies (members, messages), matches (players), runs and best
 * scores, plus every account registered with an @test.dev email (smoke/e2e
 * probes). Real accounts are kept.
 *
 * Runs directly against better-sqlite3 (no app imports) so it works outside
 * the Vite/SvelteKit runtime.
 */
import Database from 'better-sqlite3';

const db = new Database(process.env.DATABASE_URL ?? 'local.db');
db.pragma('foreign_keys = ON');

const counts: Record<string, number> = {};
const wipe = (table: string) => {
	const info = db.prepare(`DELETE FROM ${table}`).run();
	counts[table] = info.changes;
};

const reset = db.transaction(() => {
	// test accounts (profiles/sessions/best scores cascade with them)
	counts['user (@test.dev)'] = db
		.prepare(`DELETE FROM user WHERE email LIKE '%@test.dev'`)
		.run().changes;
	// everything lobby/match related (members/messages/match players cascade
	// from lobby and match, but delete explicitly for a guaranteed clean slate)
	for (const table of [
		'lobby_message',
		'lobby_member',
		'lobby',
		'match_player',
		'match',
		'run',
		'best_score'
	]) {
		wipe(table);
	}
});

reset();

console.log('Test data reset:');
for (const [table, n] of Object.entries(counts)) {
	console.log(`  ${table}: ${n} row(s) deleted`);
}
db.close();
