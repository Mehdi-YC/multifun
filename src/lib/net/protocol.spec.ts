import { describe, expect, it } from 'vitest';
import { clientMessageSchema, parseClientMessage, requestPayloads } from './protocol';

describe('protocol', () => {
	it('parses a valid req envelope', () => {
		const msg = parseClientMessage(
			JSON.stringify({ t: 'req', id: 1, d: { t: 'lobby.list', d: {} } })
		);
		expect(msg?.t).toBe('req');
	});

	it('rejects unknown message types', () => {
		expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toBeNull();
		expect(parseClientMessage('not json')).toBeNull();
		expect(parseClientMessage(JSON.stringify({ t: 'chat', d: { text: '' } }))).toBeNull();
	});

	it('rejects chat messages that are too long', () => {
		const long = 'x'.repeat(301);
		const result = clientMessageSchema.safeParse({ t: 'chat', d: { lobbyId: 'l', text: long } });
		expect(result.success).toBe(false);
	});

	it('applies defaults on lobby.create', () => {
		const parsed = requestPayloads['lobby.create'].parse({ name: 'Race', gameId: 'echo' });
		expect(parsed.maxPlayers).toBe(4);
		expect(parsed.isPublic).toBe(true);
	});

	it('validates username format on profile.save', () => {
		expect(requestPayloads['profile.save'].safeParse({ username: 'Cool_Player' }).success).toBe(
			true
		);
		expect(requestPayloads['profile.save'].safeParse({ username: 'no spaces' }).success).toBe(false);
		expect(requestPayloads['profile.save'].safeParse({ username: 'ab' }).success).toBe(false);
	});
});
