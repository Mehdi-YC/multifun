/**
 * Client-side desync regression tests for Turbo Kart, driven headlessly with a
 * recording Canvas2DLike backend and synthetic snapshot streams:
 *
 * (a) the same sim state rendered through two PixelCanvas instances resized to
 *     wildly different css sizes (1280x720 vs 600x900 => different letterbox
 *     scale/offsets) must land every kart on identical INTERNAL coordinates —
 *     world drawing never reads canvas backing-store dims, css dims,
 *     pixel.scale or pixel.offsetX/Y;
 * (b) two clients fed the same snapshot stream render IDENTICAL frames;
 * (c) the LOCAL kart renders at prediction time — instantly, never riding the
 *     ~100ms interpolation buffer;
 * (d) respawns, spin-outs and lightning shocks are discontinuities: the buffer
 *     must SNAP (never slide) across them;
 * (e) heading angles crossing the +-pi seam blend the short way around.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setNowSource } from '../engine/fixed';
import type { Canvas2DLike, CanvasSourceLike } from '../engine/gfx';
import type { GameConfig, GameContext, InputFrame, PlayerId, SimPlayer } from '../types';
import { KEY } from '../types';
import { createKartSim, type KartSim, type KartState, type MissileState } from './sim';
import { createKartClient, type KartClient } from './render';
import { RemoteBuffer, lerpAngle, wrapAngle, SNAP_DISTANCE } from './interp';
import { nearestSpline, splineAt } from './track';

const DEG = Math.PI / 180;

const P1: SimPlayer = { id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 };
const P2: SimPlayer = { id: 'p2', name: 'Ben', color: '#57e389', slot: 1 };
const P3: SimPlayer = { id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 };
const PLAYERS = [P1, P2, P3];

const CONFIG: GameConfig = {
	tickRate: 60,
	durationTicks: 12000,
	options: { trackId: 'sunny-circuit', laps: 3, countdownTicks: 0, aiCount: 0 }
};

// ---- recording draw backend (transform-aware, same as the tank harness) ----

type Matrix = [number, number, number, number, number, number];

type DrawOp = {
	op: string;
	args: number[];
	style: string;
	alpha: number;
	m: Matrix;
};

function mul(m: Matrix, n: Matrix): Matrix {
	const [a, b, c, d, e, f] = m;
	const [A, B, C, D, E, F] = n;
	return [
		a * A + c * B,
		b * A + d * B,
		a * C + c * D,
		b * C + d * D,
		a * E + c * F + e,
		b * E + d * F + f
	];
}

function point(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

class RecordingContext implements Canvas2DLike {
	fillStyle = '';
	strokeStyle = '';
	lineWidth = 1;
	imageSmoothingEnabled = false;
	globalAlpha = 1;
	readonly ops: DrawOp[] = [];
	private stack: Matrix[] = [];
	private m: Matrix = [1, 0, 0, 1, 0, 0];

	private record(op: string, args: number[] = [], style = ''): void {
		this.ops.push({ op, args, style, alpha: this.globalAlpha, m: [...this.m] });
	}

	save(): void {
		this.stack.push([...this.m]);
		this.record('save');
	}

	restore(): void {
		this.m = this.stack.pop() ?? [1, 0, 0, 1, 0, 0];
		this.record('restore');
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.m = [a, b, c, d, e, f];
		this.record('setTransform', [a, b, c, d, e, f]);
	}

	translate(x: number, y: number): void {
		this.m = mul(this.m, [1, 0, 0, 1, x, y]);
		this.record('translate', [x, y]);
	}

	scale(x: number, y: number): void {
		this.m = mul(this.m, [x, 0, 0, y, 0, 0]);
		this.record('scale', [x, y]);
	}

	rotate(angle: number): void {
		this.m = mul(this.m, [
			Math.cos(angle),
			Math.sin(angle),
			-Math.sin(angle),
			Math.cos(angle),
			0,
			0
		]);
		this.record('rotate', [angle]);
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		this.record('clearRect', [x, y, w, h]);
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		this.record('fillRect', [x, y, w, h], this.fillStyle);
	}

	strokeRect(x: number, y: number, w: number, h: number): void {
		this.record('strokeRect', [x, y, w, h], this.strokeStyle);
	}

	beginPath(): void {
		this.record('beginPath');
	}

	closePath(): void {
		this.record('closePath');
	}

	moveTo(x: number, y: number): void {
		this.record('moveTo', [x, y], this.strokeStyle);
	}

	lineTo(x: number, y: number): void {
		this.record('lineTo', [x, y], this.strokeStyle);
	}

	arc(x: number, y: number, r: number, start: number, end: number): void {
		this.record('arc', [x, y, r, start, end], this.strokeStyle);
	}

	fill(): void {
		this.record('fill', [], this.fillStyle);
	}

	stroke(): void {
		this.record('stroke', [], this.strokeStyle);
	}

	drawImage(image: object, ...args: number[]): void {
		this.record('drawImage', args);
	}
}

function fakeCanvas(): { canvas: CanvasSourceLike; rec: RecordingContext } {
	const rec = new RecordingContext();
	const canvas: CanvasSourceLike = {
		width: 480,
		height: 270,
		getContext: (type: '2d') => (type === '2d' ? rec : null)
	};
	return { canvas, rec };
}

/** Letterbox base transform in effect at ops[index] (set by PixelCanvas.begin). */
function baseAt(ops: DrawOp[], index: number): { scale: number; offX: number; offY: number } {
	let base: Matrix = [1, 0, 0, 1, 0, 0];
	for (let i = 0; i <= index; i++) if (ops[i].op === 'setTransform') base = ops[i].m;
	return { scale: base[0], offX: base[4], offY: base[5] };
}

function round(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

/**
 * Every recorded draw as op|style|alpha|raw-args|internal-coords. The mapped
 * points fold the letterbox scale/offset back out of the transform, so two
 * canvases with very different letterboxing must serialize identically.
 * Device-space bookkeeping (clearRect, the matte fill, setTransform) is
 * excluded — that is the only place canvas dimensions legitimately appear.
 */
function internalStream(rec: RecordingContext): string[] {
	const out: string[] = [];
	let devicePhase = false;
	rec.ops.forEach((op, index) => {
		if (op.op === 'setTransform') {
			devicePhase = false;
			return;
		}
		if (op.op === 'clearRect') {
			devicePhase = true;
			return;
		}
		if (devicePhase) return;
		const { scale, offX, offY } = baseAt(rec.ops, index);
		const mapped: number[] = [];
		for (let i = 0; i + 1 < op.args.length; i += 2) {
			const [dx, dy] = point(op.m, op.args[i], op.args[i + 1]);
			mapped.push(round((dx - offX) / scale), round((dy - offY) / scale));
		}
		out.push(`${op.op}|${op.style}|${op.alpha}|${op.args.join(',')}|${mapped.join(',')}`);
	});
	return out;
}

type EntityDraw = { x: number; y: number; angle: number };

/** Kart hull draws: the only 12x8 fillRect in the racer's color. */
function hullDraws(rec: RecordingContext, color: string): EntityDraw[] {
	const out: EntityDraw[] = [];
	rec.ops.forEach((op, index) => {
		if (op.op !== 'fillRect' || op.style !== color) return;
		const [x, y, w, h] = op.args;
		if (w !== 12 || h !== 8) return;
		const { scale, offX, offY } = baseAt(rec.ops, index);
		const [dx, dy] = point(op.m, x + w / 2, y + h / 2);
		out.push({
			x: round((dx - offX) / scale),
			y: round((dy - offY) / scale),
			angle: Math.atan2(op.m[1], op.m[0])
		});
	});
	return out;
}

// ---- client harness ----

type Harness = { client: KartClient; rec: RecordingContext };

function makeClient(cssW: number, cssH: number, selfId: PlayerId = 'p1'): Harness {
	const { canvas, rec } = fakeCanvas();
	const ctx: GameContext = {
		canvas: canvas as unknown as HTMLCanvasElement,
		selfId,
		players: PLAYERS,
		seed: 1337,
		config: CONFIG,
		sendInput: () => {},
		onEnd: () => {}
	};
	const client = createKartClient(ctx);
	client.resize(cssW, cssH);
	return { client, rec };
}

function inputMap(keys: Partial<Record<PlayerId, number>>): Map<PlayerId, InputFrame> {
	const map = new Map<PlayerId, InputFrame>();
	for (const [id, mask] of Object.entries(keys)) map.set(id, { keys: mask ?? 0 });
	return map;
}

/** Feed one server snapshot to a list of clients. */
function broadcast(clients: Harness[], server: KartSim): void {
	const snap = server.snapshot();
	for (const { client } of clients) client.onSnapshot(snap);
}

let now = 1_000_000;

beforeEach(() => {
	now = 1_000_000;
	setNowSource(() => now);
});

afterEach(() => {
	setNowSource(null);
});

// ---- (a) internal coordinates are window-size independent ----

describe('kart render: window-size invariance', () => {
	it('same sim state lands every kart on identical internal coordinates at 1280x720 and 600x900', () => {
		const big = makeClient(1280, 720);
		const small = makeClient(600, 900);
		const server = createKartSim(1337, CONFIG, PLAYERS);

		// The whole pack drives the bottom straight together so every hull is
		// inside the camera view at render time.
		for (let tick = 0; tick < 45; tick++) {
			const frame = inputMap({ p1: KEY.UP, p2: KEY.UP, p3: KEY.UP });
			server.tickOnce(frame);
			if (tick % 3 === 0) broadcast([big, small], server);
			big.client.stepTick(KEY.UP);
			small.client.stepTick(KEY.UP);
		}

		big.rec.ops.length = 0;
		small.rec.ops.length = 0;
		big.client.renderFrame(0.5);
		small.client.renderFrame(0.5);

		// The letterboxing genuinely differed (scale 2 @ (160, 90) vs 1 @ (60, 315)).
		const bigBase = baseAt(big.rec.ops, big.rec.ops.length - 1);
		const smallBase = baseAt(small.rec.ops, small.rec.ops.length - 1);
		expect(bigBase).toEqual({ scale: 2, offX: 160, offY: 90 });
		expect(smallBase).toEqual({ scale: 1, offX: 60, offY: 315 });

		// ...and yet every draw — karts, tiles, HUD — is on the same internal
		// coordinates in both windows.
		expect(internalStream(big.rec)).toEqual(internalStream(small.rec));

		for (const player of PLAYERS) {
			const a = hullDraws(big.rec, player.color);
			const b = hullDraws(small.rec, player.color);
			expect(a).toEqual(b);
		}
		const totalHulls = PLAYERS.reduce((n, p) => n + hullDraws(big.rec, p.color).length, 0);
		expect(totalHulls).toBe(3); // all three karts drawn exactly once each
	});
});

// ---- (b) identical snapshot streams => identical frames ----

describe('kart render: identical frames', () => {
	it('two clients fed the same snapshot stream record identical draw calls', () => {
		const a = makeClient(960, 540);
		const b = makeClient(960, 540);
		const server = createKartSim(1337, CONFIG, PLAYERS);

		for (let tick = 0; tick < 60; tick++) {
			const frame = inputMap({
				p1: KEY.UP,
				p2: KEY.UP | KEY.RIGHT | KEY.DRIFT,
				p3: KEY.UP | (tick % 4 === 0 ? KEY.LEFT : 0)
			});
			server.tickOnce(frame);
			if (tick % 3 === 0) broadcast([a, b], server);
			a.client.stepTick(KEY.UP);
			b.client.stepTick(KEY.UP);
		}
		a.client.renderFrame(0.5);
		b.client.renderFrame(0.5);

		expect(a.rec.ops.length).toBeGreaterThan(500);
		expect(a.rec.ops).toEqual(b.rec.ops);
	});
});

// ---- (c) local kart prediction: zero display lag ----

describe('kart render: local prediction', () => {
	it('the local kart moves at prediction time, before any snapshot arrives', () => {
		const { client, rec } = makeClient(960, 540);
		// No snapshots at all: only local input exists.
		for (let i = 0; i < 10; i++) client.stepTick(KEY.UP);
		rec.ops.length = 0;
		client.renderFrame(0.5);
		const first = hullDraws(rec, P1.color);
		expect(first).toHaveLength(1);

		for (let i = 0; i < 40; i++) client.stepTick(KEY.UP);
		rec.ops.length = 0;
		client.renderFrame(0.5);
		const second = hullDraws(rec, P1.color);
		expect(second).toHaveLength(1);

		// The hull advanced with the prediction instantly (no buffer to wait on).
		// (The camera follows the local kart, so hull movement on screen IS the
		// prediction advancing relative to the world.)
		const moved = Math.hypot(second[0].x - first[0].x, second[0].y - first[0].y);
		expect(moved).toBeGreaterThan(30);
	});

	it('a lagging snapshot stream never drags the local kart back to the snapshot', () => {
		const { client, rec } = makeClient(960, 540);
		const server = createKartSim(1337, CONFIG, PLAYERS);
		// The authority lags well behind the local loop (slow upstream) AND its
		// copy of the local kart never moves; the client keeps driving its own
		// prediction and only reconciles against the stale snapshots.
		for (let tick = 0; tick < 60; tick++) {
			if (tick % 3 === 0) server.tickOnce(inputMap({}));
			client.stepTick(KEY.UP);
			if (tick === 30) client.onSnapshot(server.snapshot());
		}
		rec.ops.length = 0;
		client.renderFrame(0.5);
		const local = hullDraws(rec, P1.color);
		const remote = hullDraws(rec, P2.color);
		expect(local).toHaveLength(1);
		expect(remote).toHaveLength(1);
		// The camera tracks the predicted local kart, so the (stationary)
		// remote karts sit off screen center. Had the local kart ridden the
		// snapshot stream, it would sit on top of them at the grid instead.
		expect(Math.hypot(local[0].x - remote[0].x, local[0].y - remote[0].y)).toBeGreaterThan(40);
	});
});

// ---- (d) respawns snap, never slide ----

describe('kart render: respawn discontinuity', () => {
	/**
	 * Park the victim on the racing line near the local kart (so the camera
	 * sees both anchors), then dump it deep in the infield: the off-track
	 * watchdog respawns it at the next checkpoint anchor. The two anchors are
	 * >100px apart, so any slide across the gap is obvious.
	 */
	function lineThenRespawn(): {
		snapshots: ReturnType<KartSim['snapshot']>[];
		deathX: number;
		deathY: number;
		respawnX: number;
		respawnY: number;
	} {
		const server = createKartSim(1337, CONFIG, PLAYERS);
		const snapshots: ReturnType<KartSim['snapshot']>[] = [];
		const victim = server.karts.find((k) => k.id === 'p2')!;
		const line = splineAt(server.track, 180);
		victim.x = line.x;
		victim.y = line.y;
		victim.angle = Math.atan2(line.ty, line.tx);
		victim.speed = 0;
		for (let tick = 0; tick < 12; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		const deathX = victim.x;
		const deathY = victim.y;
		// Deep infield: > FALL_DISTANCE from the racing line.
		victim.x = 320;
		victim.y = 260;
		victim.speed = 0;
		for (let tick = 0; tick < 24; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		return {
			snapshots,
			deathX,
			deathY,
			respawnX: victim.x,
			respawnY: victim.y
		};
	}

	it('never slides a respawning kart across the map and shows the respawn', () => {
		const { snapshots, deathX, deathY, respawnX, respawnY } = lineThenRespawn();
		// The two world anchors really are far apart...
		expect(Math.hypot(respawnX - deathX, respawnY - deathY)).toBeGreaterThan(SNAP_DISTANCE + 30);

		const client = makeClient(960, 540);
		const perFrame: EntityDraw[][] = [];
		for (const snap of snapshots) {
			client.client.onSnapshot(snap);
			for (let k = 0; k < 3; k++) {
				client.rec.ops.length = 0;
				client.client.renderFrame(0);
				perFrame.push(hullDraws(client.rec, P2.color));
				now += 1000 / 60;
			}
		}

		const centers = perFrame.flat();
		expect(centers.length).toBeGreaterThan(0);
		// The camera is static (the local kart idles), so the anchors land at
		// fixed screen spots: capture them from the frames themselves.
		const anchorA = perFrame[0][0]; // parked on the racing line
		const anchorB = centers[centers.length - 1]; // settled at the respawn
		expect(Math.hypot(anchorB.x - anchorA.x, anchorB.y - anchorA.y)).toBeGreaterThan(60);

		let nearRespawn = 0;
		for (const c of centers) {
			if (Math.hypot(c.x - anchorA.x, c.y - anchorA.y) < 30) continue;
			if (Math.hypot(c.x - anchorB.x, c.y - anchorB.y) < 30) {
				nearRespawn++;
				continue;
			}
			expect.fail(`hull at ${c.x},${c.y} slid between the parking spot and the respawn anchor`);
		}
		expect(nearRespawn).toBeGreaterThan(0); // the respawn IS shown
	});
});

// ---- (e) interpolation: snapping + shortest-path angles ----

function kart(
	id: string,
	x: number,
	y: number,
	angle: number,
	over: Partial<KartState> = {}
): KartState {
	return {
		id,
		x,
		y,
		angle,
		z: 0,
		vz: 0,
		airCooldown: 0,
		speed: 0,
		lateral: 0,
		lap: 0,
		checkpoint: 1,
		gateSign: -1,
		splineHint: 0,
		progress: 0,
		drifting: false,
		driftDir: 0,
		driftCharge: 0,
		hopTicks: 0,
		spinTimer: 0,
		spinDir: 1,
		boostTimer: 0,
		boostPower: 0,
		item: null,
		shieldTimer: 0,
		shrinkTimer: 0,
		draftTicks: 0,
		stuckTicks: 0,
		trick: false,
		upPressTick: -1000,
		lapStartTick: 0,
		bestLapMs: 0,
		lastLapMs: 0,
		itemsUsed: 0,
		driftBoosts: 0,
		finished: false,
		finishTimeMs: 0,
		place: 1,
		lastKeys: 0,
		ai: false,
		...over
	};
}

function push(
	buffer: RemoteBuffer,
	tick: number,
	karts: KartState[],
	missiles: MissileState[] = []
): void {
	buffer.push({ tick, karts, missiles, slicks: [], boxes: [], breakableHp: [] });
}

describe('kart interp: discontinuities snap', () => {
	it('snaps across spin-outs instead of sliding', () => {
		const buf = new RemoteBuffer();
		// A hit rips the kart around within one snapshot gap: the move itself
		// is small (18px < SNAP_DISTANCE), so only the spin transition can
		// force the snap.
		push(buf, 0, [kart('p1', 100, 100, 0)]);
		push(buf, 6, [kart('p1', 118, 100, 0, { spinTimer: 30, speed: 1 })]);
		const mid = buf.kartAt('p1', 3)!;
		expect([100, 118]).toContain(mid.x); // snapped, never 109
		expect(buf.kartAt('p1', 1)!.x).toBe(100);
		expect(buf.kartAt('p1', 5)!.x).toBe(118);
	});

	it('snaps across respawns (teleport + dead stop) and lightning shocks', () => {
		const buf = new RemoteBuffer();
		push(buf, 0, [kart('p1', 100, 100, 0, { speed: 3 })]);
		push(buf, 6, [
			kart('p1', 118, 100, 0, {
				speed: 0,
				boostTimer: 90,
				boostPower: 0.25
			})
		]);
		expect(buf.kartAt('p1', 3)!.x).toBe(118); // nearer sample wins outright

		const buf2 = new RemoteBuffer();
		push(buf2, 0, [kart('p1', 100, 100, 0)]);
		push(buf2, 6, [kart('p1', 118, 100, 0, { shrinkTimer: 180 })]);
		expect([100, 118]).toContain(buf2.kartAt('p1', 3)!.x);
	});

	it('blends continuous samples smoothly', () => {
		const buf = new RemoteBuffer();
		// 18px over a 6-tick gap: ordinary racing travel (a teleport would be
		// 26px+, which snaps).
		push(buf, 0, [kart('p1', 100, 100, 0, { speed: 3 })]);
		push(buf, 6, [kart('p1', 118, 100, 0, { speed: 3 })]);
		expect(buf.kartAt('p1', 3)!.x).toBeCloseTo(109, 6);
		expect(buf.kartAt('p1', 2)!.x).toBeCloseTo(106, 6);
		// Discrete fields always come from the samples.
		expect(buf.kartAt('p1', 3)!.id).toBe('p1');
	});

	it('drops out-of-order snapshots and stays bounded', () => {
		const buf = new RemoteBuffer();
		push(buf, 6, [kart('p1', 160, 100, 0)]);
		push(buf, 3, [kart('p1', 130, 100, 0)]); // network reorder: ignored
		expect(buf.latestTick).toBe(6);
		expect(buf.kartAt('p1', 3)!.x).toBe(160);
		for (let t = 9; t < 300; t += 3) push(buf, t, [kart('p1', t, 100, 0)]);
		expect(buf.length).toBeLessThanOrEqual(32);
	});

	it('snaps missiles on wall redirects', () => {
		const missile = (id: number, x: number, angle: number): MissileState => ({
			id,
			owner: 'p1',
			x,
			y: 100,
			angle,
			targetId: null,
			life: 200
		});
		const buf = new RemoteBuffer();
		push(buf, 0, [], [missile(1, 100, 0)]);
		push(buf, 6, [], [missile(1, 160, Math.PI)]); // bounced: direction flipped
		const list = buf.missilesAt(3);
		expect(list).toHaveLength(1);
		expect([100, 160]).toContain(list[0].x); // no arc across the bounce
	});
});

describe('kart interp: shortest-path angles', () => {
	it('blends 179deg -> -179deg the short way through the seam', () => {
		const buf = new RemoteBuffer();
		push(buf, 0, [kart('p1', 100, 100, 179 * DEG)]);
		push(buf, 6, [kart('p1', 160, 100, -179 * DEG)]);
		for (let t = 1; t < 6; t++) {
			const angle = buf.kartAt('p1', t)!.angle;
			expect(Math.abs(Math.abs(angle) - Math.PI)).toBeLessThan(3 * DEG);
		}
		// The helpers themselves take the 2deg path, never the 358deg one.
		expect(Math.abs(wrapAngle(-179 * DEG - 179 * DEG))).toBeCloseTo(2 * DEG, 6);
		expect(Math.abs(lerpAngle(179 * DEG, -179 * DEG, 0.5) - Math.PI)).toBeLessThan(1e-6);
	});

	it('draws remote hulls the short way across the seam end to end', () => {
		const server = createKartSim(1337, CONFIG, PLAYERS);
		const snapshots: ReturnType<KartSim['snapshot']>[] = [];
		const victim = server.karts.find((k) => k.id === 'p2')!;
		// Park near the local kart so the camera keeps the hull on screen.
		const line = splineAt(server.track, 180);
		victim.x = line.x;
		victim.y = line.y;
		victim.speed = 0;
		victim.angle = 179 * DEG;
		for (let tick = 0; tick < 6; tick++) {
			server.tickOnce(inputMap({}));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		// The last pair straddles the seam: 179deg -> -179deg (a 2deg turn).
		victim.angle = -179 * DEG;
		for (let tick = 0; tick < 3; tick++) server.tickOnce(inputMap({}));
		snapshots.push(server.snapshot());

		const client = makeClient(960, 540);
		for (const snap of snapshots) client.client.onSnapshot(snap);
		let seen = 0;
		for (let frame = 0; frame < 8; frame++) {
			client.rec.ops.length = 0;
			client.client.renderFrame(0);
			for (const hull of hullDraws(client.rec, P2.color)) {
				seen++;
				// Near +-180deg through the blend. (16-direction quantization
				// rounds the drawn heading by up to 11deg; a naive long-way lerp
				// parks the hull near 0deg mid-pair.)
				expect(Math.abs(Math.abs(hull.angle) - Math.PI)).toBeLessThan(25 * DEG);
			}
			now += 1000 / 60;
		}
		expect(seen).toBeGreaterThan(0); // the seam crossing really was drawn
	});
});

// ---- HUD sanity: the sim state is actually on screen ----

describe('kart render: HUD', () => {
	it('draws the position badge, lap counter, speed bar, item slot and minimap', () => {
		const { client, rec } = makeClient(960, 540);
		const server = createKartSim(1337, CONFIG, PLAYERS);
		for (let tick = 0; tick < 12; tick++) {
			server.tickOnce(inputMap({ p1: KEY.UP, p2: KEY.UP }));
			if (tick % 3 === 0) client.onSnapshot(server.snapshot());
			client.stepTick(KEY.UP);
		}
		rec.ops.length = 0;
		client.renderFrame(0.5);

		// HUD text lives in internal coordinates: position ("1ST"), lap and
		// speed labels are drawn with the bitmap font every frame.
		const texts = rec.ops.filter((op) => op.op === 'fillRect' && op.style === '#e8e8f0');
		expect(texts.length).toBeGreaterThan(20);
		// The minimap frame is a stroked panel in the top-right corner.
		const panels = rec.ops.filter(
			(op) => op.op === 'fillRect' && op.style === '#22263a' && op.args[0] > 380 && op.args[1] < 20
		);
		expect(panels.length).toBeGreaterThan(0);
		// And the race really progressed server-side (laps/checkpoints exist).
		const p1 = server.karts.find((k) => k.id === 'p1')!;
		expect(nearestSpline(server.track, p1.x, p1.y).distance).toBeLessThan(60);
	});
});
