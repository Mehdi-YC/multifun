/**
 * Realtime WebSocket client: request/ack with timeouts, event subscriptions,
 * automatic reconnect with backoff. Framework-free.
 */
import type { ClientMessage, RequestName, RequestPayload, ServerMessage } from '$lib/net/protocol';
import { PROTOCOL_VERSION } from '$lib/net/protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

type Handler = (msg: ServerMessage) => void;
type StatusHandler = (status: ConnectionStatus) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export class RealtimeClient {
	private ws: WebSocket | null = null;
	private url: string;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private handlers = new Map<string, Set<Handler>>();
	private statusHandlers = new Set<StatusHandler>();
	private backoffIndex = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private closedByUser = false;

	status: ConnectionStatus = 'idle';

	constructor(url?: string) {
		this.url = url ?? (typeof location !== 'undefined' ? wsUrl() : 'ws://localhost/realtime');
	}

	connect(): void {
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
		) {
			return;
		}
		this.closedByUser = false;
		this.setStatus('connecting');
		const ws = new WebSocket(this.url);
		this.ws = ws;

		ws.onopen = () => {
			this.backoffIndex = 0;
			this.setStatus('open');
			this.send({ t: 'hello', d: { token: '', version: PROTOCOL_VERSION } });
			this.startHeartbeat();
		};
		ws.onmessage = (event) => this.receive(String(event.data));
		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			this.stopHeartbeat();
			this.setStatus('closed');
			this.failAllPending('connection closed');
			if (!this.closedByUser) this.scheduleReconnect();
		};
		ws.onerror = () => {
			/* close handler deals with it */
		};
	}

	disconnect(): void {
		this.closedByUser = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.stopHeartbeat();
		this.ws?.close();
		this.ws = null;
		this.setStatus('closed');
	}

	/** Keep the server-side connection sweep happy (server drops 30s-silent conns). */
	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.send({ t: 'ping', d: { ts: Date.now() } });
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	/** Resolves when the socket is open (connects if needed), rejects on timeout. */
	waitForOpen(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
		if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
		this.connect();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error('not-connected'));
			}, timeoutMs);
			const off = this.onStatus((status) => {
				if (status === 'open') {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)];
		this.backoffIndex++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const handler of this.statusHandlers) handler(status);
	}

	send(msg: ClientMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(msg));
	}

	/** Request/ack round trip. Resolves with `ack.d`, rejects on `ack.err`. */
	async request<N extends RequestName>(name: N, payload: RequestPayload<N>): Promise<unknown> {
		await this.waitForOpen();
		return new Promise((resolve, reject) => {
			const ws = this.ws;
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error('not-connected'));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('request-timeout'));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ t: 'req', id, d: { t: name, d: payload } }));
		});
	}

	/** Convenience passthroughs. */
	sendChat(lobbyId: string, text: string): void {
		this.send({ t: 'chat', d: { lobbyId, text } });
	}

	sendInput(matchId: string, tick: number, seq: number, keys: number): void {
		this.send({ t: 'input', d: { matchId, tick, seq, keys } });
	}

	/** Subscribe to a server message type. Returns an unsubscribe fn. */
	on<T extends ServerMessage['t']>(
		type: T,
		handler: (msg: Extract<ServerMessage, { t: T }>) => void
	): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		const wrapped = handler as Handler;
		set.add(wrapped);
		return () => {
			set?.delete(wrapped);
		};
	}

	onStatus(handler: StatusHandler): () => void {
		this.statusHandlers.add(handler);
		return () => {
			this.statusHandlers.delete(handler);
		};
	}

	private receive(raw: string): void {
		let msg: ServerMessage;
		try {
			msg = JSON.parse(raw) as ServerMessage;
		} catch {
			return;
		}
		if (msg.t === 'ack') {
			const pending = this.pending.get(msg.id);
			if (pending) {
				this.pending.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.d);
				else pending.reject(new Error(msg.err?.code ?? 'request-failed'));
			}
			return;
		}
		const set = this.handlers.get(msg.t);
		if (set) {
			for (const handler of set) handler(msg);
		}
	}

	private failAllPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

function wsUrl(): string {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.host}/realtime`;
}
