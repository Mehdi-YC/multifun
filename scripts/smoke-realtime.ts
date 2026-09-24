/**
 * End-to-end smoke of the realtime stack against a running dev server:
 *   bun run dev  (in another shell)
 *   bun scripts/smoke-realtime.ts
 * Verifies: auth handshake on upgrade, lobby.create/list/ready, chat,
 * game launch through the stub sim (snapshots + events + results), clean leave.
 */
import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const WS_URL = BASE.replace(/^http/, 'ws') + '/realtime';

type Frame = {
	t: string;
	id?: number;
	ok?: boolean;
	d?: {
		lobby?: { id: string; code: string; members: unknown[] };
		lobbies?: { code: string }[];
		matchId?: string;
		tick?: number;
		players?: unknown[];
		results?: { placement: number; score: number }[];
	};
	err?: { code: string; msg: string };
};

function log(step: string, detail: unknown = ''): void {
	console.log(`✓ ${step}`, detail);
}

async function signup(): Promise<string> {
	const email = `smoke-${Date.now()}@test.dev`;
	const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'Smokey', email, password: 'password123' })
	});
	if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
	const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
	const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
	if (!cookie) throw new Error('no session cookie returned');
	log('signup + session cookie');
	return cookie;
}

class Wire {
	readonly messages: Frame[] = [];
	private pending: { predicate: (m: Frame) => boolean; resolve: (m: Frame) => void }[] = [];

	constructor(private readonly ws: WebSocket) {
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString()) as Frame;
			this.messages.push(msg);
			for (let i = this.pending.length - 1; i >= 0; i--) {
				if (this.pending[i].predicate(msg)) {
					this.pending[i].resolve(msg);
					this.pending.splice(i, 1);
				}
			}
		});
	}

	waitFor(predicate: (m: Frame) => boolean, timeoutMs = 5000, label = 'message'): Promise<Frame> {
		const found = this.messages.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
			this.pending.push({
				predicate,
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				}
			});
		});
	}

	send(msg: unknown): void {
		this.ws.send(JSON.stringify(msg));
	}

	async req(name: string, d: unknown): Promise<Frame> {
		const id = this.nextId++;
		const waiter = this.waitFor((m) => m.t === 'ack' && m.id === id, 5000, `ack:${name}`);
		this.send({ t: 'req', id, d: { t: name, d } });
		const ack = await waiter;
		if (!ack.ok) throw new Error(`${name} failed: ${JSON.stringify(ack.err)}`);
		return ack;
	}

	private nextId = 1;
}

async function main(): Promise<void> {
	const cookie = await signup();
	const ws = new WebSocket(WS_URL, { headers: { cookie } });
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
	const wire = new Wire(ws);
	log('ws connected');
	await wire.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
	log('welcome received');

	const create = await wire.req('lobby.create', {
		name: 'Smoke Lobby',
		gameId: 'echo',
		maxPlayers: 4,
		isPublic: true,
		settings: {}
	});
	const lobbyState = create.d?.lobby;
	if (!lobbyState) throw new Error('no lobby in create ack');
	log('lobby.create', `code=${lobbyState.code} members=${lobbyState.members.length}`);

	const list = await wire.req('lobby.list', {});
	const listed = (list.d?.lobbies ?? []).some((l) => l.code === lobbyState.code);
	if (!listed) throw new Error('created lobby not in public list');
	log('lobby.list shows the new lobby');

	await wire.req('lobby.ready', { lobbyId: lobbyState.id, ready: true });
	log('lobby.ready');

	wire.send({ t: 'chat', d: { lobbyId: lobbyState.id, text: 'hello world' } });
	await wire.waitFor((m) => m.t === 'chat.msg', 5000, 'chat.msg');
	log('chat round-trip');

	await wire.req('lobby.start', { lobbyId: lobbyState.id });
	const gameStart = await wire.waitFor((m) => m.t === 'game.start', 8000, 'game.start');
	const matchId = gameStart.d?.matchId;
	if (!matchId) throw new Error('no matchId in game.start');
	log('game.start', `match=${matchId} players=${gameStart.d?.players?.length}`);

	let seq = 0;
	const inputTimer = setInterval(() => {
		wire.send({
			t: 'input',
			d: { matchId, tick: seq, seq, keys: 8 | 16 }
		});
		seq++;
	}, 100);

	const snap = await wire.waitFor((m) => m.t === 'game.snap', 8000, 'game.snap');
	log('game.snap flowing', `tick=${snap.d?.tick}`);
	const gameEnd = await wire.waitFor((m) => m.t === 'game.end', 35000, 'game.end');
	clearInterval(inputTimer);
	log(
		'game.end',
		`results=${JSON.stringify((gameEnd.d?.results ?? []).map((r) => [r.placement, r.score]))}`
	);

	// host deletes the lobby at the end — cleans up after the test itself
	await wire.req('lobby.delete', { lobbyId: lobbyState.id });
	log('lobby.delete');
	ws.close();
	console.log('\nSMOKE OK — full realtime pipeline verified');
	process.exit(0);
}

main().catch((err) => {
	console.error('\nSMOKE FAILED:', err);
	process.exit(1);
});
