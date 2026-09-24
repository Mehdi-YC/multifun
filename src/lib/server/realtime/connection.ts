import type { WebSocket } from 'ws';
import type { ServerMessage } from '$lib/net/protocol';

const CHAT_BURST = 5;
const CHAT_REFILL_MS = 10_000;

/** One authenticated WebSocket connection. */
export class Connection {
	readonly id: string;
	readonly userId: string;
	readonly username: string;
	displayName: string;
	readonly rooms = new Set<string>();
	lastSeen = Date.now();
	private chatTokens = CHAT_BURST;
	private chatRefillAt = Date.now();

	constructor(
		id: string,
		private readonly ws: WebSocket,
		user: { id: string; username: string; displayName: string }
	) {
		this.id = id;
		this.userId = user.id;
		this.username = user.username;
		this.displayName = user.displayName;
	}

	get open(): boolean {
		return this.ws.readyState === this.ws.OPEN;
	}

	send(msg: ServerMessage): void {
		if (!this.open) return;
		try {
			this.ws.send(JSON.stringify(msg));
		} catch {
			// socket died mid-send; disconnect handling will clean up
		}
	}

	sendError(code: string, msg: string): void {
		this.send({ t: 'err', d: { code, msg } });
	}

	ack(id: number, ok: boolean, d?: unknown, err?: { code: string; msg: string }): void {
		this.send({ t: 'ack', id, ok, d, err });
	}

	/** Token-bucket rate limit for chat. */
	allowChat(): boolean {
		const now = Date.now();
		if (now - this.chatRefillAt > CHAT_REFILL_MS) {
			this.chatTokens = CHAT_BURST;
			this.chatRefillAt = now;
		}
		if (this.chatTokens <= 0) return false;
		this.chatTokens--;
		return true;
	}

	close(code = 1000, reason = ''): void {
		try {
			this.ws.close(code, reason);
		} catch {
			/* already closed */
		}
	}

	ping(): void {
		try {
			this.ws.ping();
		} catch {
			/* already dead */
		}
	}

	terminate(): void {
		try {
			this.ws.terminate();
		} catch {
			/* already dead */
		}
	}
}
