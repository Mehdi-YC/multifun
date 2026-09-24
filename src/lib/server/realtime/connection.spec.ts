import { describe, expect, it, vi, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { Connection } from './connection';

function stubSocket() {
	const sent: string[] = [];
	const ws = {
		OPEN: 1,
		readyState: 1,
		send: (data: string) => sent.push(data),
		close: () => {
			ws.readyState = 3;
		},
		terminate: () => {
			ws.readyState = 3;
		},
		ping: () => {}
	};
	return { ws: ws as unknown as WebSocket, sent };
}

describe('Connection', () => {
	afterEach(() => vi.useRealTimers());

	it('serializes messages as JSON', () => {
		const { ws, sent } = stubSocket();
		const conn = new Connection('c1', ws, {
			id: 'u1',
			username: 'neo',
			displayName: 'Neo'
		});
		conn.send({ t: 'err', d: { code: 'x', msg: 'y' } });
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0])).toEqual({ t: 'err', d: { code: 'x', msg: 'y' } });
	});

	it('rate-limits chat with a token bucket that refills', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { ws } = stubSocket();
		const conn = new Connection('c1', ws, {
			id: 'u1',
			username: 'neo',
			displayName: 'Neo'
		});
		for (let i = 0; i < 5; i++) expect(conn.allowChat()).toBe(true);
		expect(conn.allowChat()).toBe(false);
		vi.setSystemTime(new Date('2026-01-01T00:00:11Z'));
		expect(conn.allowChat()).toBe(true);
	});

	it('does not throw when sending on a closed socket', () => {
		const { ws } = stubSocket();
		const conn = new Connection('c1', ws, {
			id: 'u1',
			username: 'neo',
			displayName: 'Neo'
		});
		conn.close();
		expect(() => conn.send({ t: 'err', d: { code: 'x', msg: 'y' } })).not.toThrow();
	});
});
