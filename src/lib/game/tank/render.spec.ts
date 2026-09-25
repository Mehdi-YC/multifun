/**
 * Client-side desync regression tests for Pixel Tanks, driven headlessly with a
 * recording Canvas2DLike backend and synthetic snapshot streams:
 *
 * (a) the same sim state rendered through two PixelCanvas instances resized to
 *     wildly different css sizes (1280x720 vs 600x900 => different letterbox
 *     scale/offsets) must land every tank/shell on identical INTERNAL
 *     coordinates — world drawing never reads canvas backing-store dims,
 *     css dims, pixel.scale or pixel.offsetX/Y;
 * (b) a respawn/teleport in the snapshot stream must SNAP the interpolated
 *     tank (no slide across the map), hide the wreck while waiting, and show
 *     eliminated tanks as gone;
 * (c) hull angles crossing the +-pi seam must interpolate the short way;
 * (d) two clients fed the same snapshot stream render IDENTICAL frames — and
 *     keep doing so when one browser's loop drops ticks under render load
 *     (the classic "bigger window, worse desync" symptom).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setNowSource } from '../engine/fixed';
import type { Canvas2DLike, CanvasSourceLike } from '../engine/gfx';
import type { GameConfig, GameContext, InputFrame, PlayerId, SimPlayer } from '../types';
import { KEY } from '../types';
import { createTankSim, type TankSim } from './sim';
import { createTankClient, type TankClient } from './render';

const DEG = Math.PI / 180;

const P1: SimPlayer = { id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 };
const P2: SimPlayer = { id: 'p2', name: 'Ben', color: '#57e389', slot: 1 };
const P3: SimPlayer = { id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 };
const PLAYERS = [P1, P2, P3];

const CONFIG: GameConfig = {
	tickRate: 60,
	durationTicks: 12000,
	options: { arenaId: 'crossfire', countdownTicks: 0 }
};

// ---- recording draw backend (transform-aware) ----

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
 * Every recorded draw as op|style|alpha|raw-args|internal-coords. The raw args
 * are internal 480x270 coordinates by construction; the mapped points fold the
 * letterbox scale/offset back out of the transform, so two canvases with very
 * different letterboxing must serialize identically. Device-space bookkeeping
 * (clearRect, the letterbox matte fill and setTransform against the backing
 * store) is excluded — that is the only place canvas dimensions legitimately
 * appear (engine `PixelCanvas.clear()` paints the matte over the whole store).
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

/** Tank hull draws: the only 12x8 fillRect in the player's color. */
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

/** Shell cores: 3x3 fills in the bullet color (streams without power-ups). */
function shellDraws(rec: RecordingContext): EntityDraw[] {
	const out: EntityDraw[] = [];
	rec.ops.forEach((op, index) => {
		if (op.op !== 'fillRect' || op.style !== '#ffe066') return;
		const [x, y, w, h] = op.args;
		if (w !== 3 || h !== 3) return;
		const { scale, offX, offY } = baseAt(rec.ops, index);
		const [dx, dy] = point(op.m, x + w / 2, y + h / 2);
		out.push({ x: round((dx - offX) / scale), y: round((dy - offY) / scale), angle: 0 });
	});
	return out;
}

// ---- client harness ----

type Harness = { client: TankClient; rec: RecordingContext };

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
	const client = createTankClient(ctx);
	client.resize(cssW, cssH);
	return { client, rec };
}

function inputMap(keys: Partial<Record<PlayerId, number>>): Map<PlayerId, InputFrame> {
	const map = new Map<PlayerId, InputFrame>();
	for (const [id, mask] of Object.entries(keys)) map.set(id, { keys: mask ?? 0 });
	return map;
}

/** Feed one server snapshot to a list of clients. */
function broadcast(clients: Harness[], server: TankSim): void {
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

describe('tank render: window-size invariance', () => {
	it('same sim state lands every tank and shell on identical internal coordinates at 1280x720 and 600x900', () => {
		const big = makeClient(1280, 720);
		const small = makeClient(600, 900);
		const server = createTankSim(1337, CONFIG, PLAYERS);

		for (let tick = 0; tick < 90; tick++) {
			const frame = inputMap({
				p2: (tick % 3 === 0 ? KEY.RIGHT : 0) | (tick % 5 === 0 ? KEY.UP : 0),
				p3: (tick % 4 === 0 ? KEY.LEFT : 0) | (tick % 7 === 0 || tick >= 79 ? KEY.JUMP : 0)
			});
			if (tick === 79) {
				// Guarantee shells in flight at render time: revive the shooter
				// in open ground with a loaded cannon, firing east. (The shot
				// must predate the render tick by the ~100ms interpolation
				// delay to be visible in the frame.)
				const shooter = server.tanks.find((t) => t.id === 'p3')!;
				shooter.alive = true;
				shooter.x = 240;
				shooter.y = 136;
				shooter.angle = 0;
				shooter.reloadTimer = 0;
			}
			server.tickOnce(frame);
			if (tick % 3 === 0) broadcast([big, small], server);
			big.client.stepTick(0);
			small.client.stepTick(0);
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

		// ...and yet every draw — tanks, shells, arena — is on the same
		// internal coordinates in both windows.
		expect(internalStream(big.rec)).toEqual(internalStream(small.rec));

		for (const player of PLAYERS) {
			const a = hullDraws(big.rec, player.color);
			const b = hullDraws(small.rec, player.color);
			expect(a).toEqual(b);
		}
		// At least one tank and one shell really were drawn at internal coords.
		const totalHulls = PLAYERS.reduce((n, p) => n + hullDraws(big.rec, p.color).length, 0);
		expect(totalHulls).toBeGreaterThan(0);
		expect(shellDraws(big.rec).length).toBeGreaterThan(0);
		expect(shellDraws(big.rec)).toEqual(shellDraws(small.rec));
	});
});

// ---- (d) identical snapshot streams => identical frames ----

describe('tank render: identical frames', () => {
	it('two clients fed the same snapshot stream record identical draw calls', () => {
		const a = makeClient(960, 540);
		const b = makeClient(960, 540);
		const server = createTankSim(1337, CONFIG, PLAYERS);

		for (let tick = 0; tick < 90; tick++) {
			const frame = inputMap({
				p2: (tick % 3 === 0 ? KEY.RIGHT : 0) | (tick % 5 === 0 ? KEY.UP : 0),
				p3: (tick % 4 === 0 ? KEY.LEFT : 0) | (tick % 7 === 0 ? KEY.JUMP : 0)
			});
			server.tickOnce(frame);
			if (tick % 3 === 0) broadcast([a, b], server);
			a.client.stepTick(0);
			b.client.stepTick(0);
		}
		a.client.renderFrame(0.5);
		b.client.renderFrame(0.5);

		expect(a.rec.ops.length).toBeGreaterThan(500);
		expect(a.rec.ops).toEqual(b.rec.ops);
	});

	it('dropped local ticks (slow window) do NOT desync remote rendering', () => {
		// Browser A keeps up with its 60Hz loop; browser B is twice as slow and
		// drops ticks (bigger window, heavier fill rate). Both receive the same
		// snapshot stream. Remote tanks must still land on the same world
		// positions — the render clock comes from the snapshot stream, not from
		// the local tick counter.
		const fast = makeClient(1280, 720, 'p3');
		const slow = makeClient(600, 900, 'p3');
		const server = createTankSim(1337, CONFIG, PLAYERS);

		for (let tick = 0; tick < 90; tick++) {
			server.tickOnce(
				inputMap({
					p1: (tick % 3 === 0 ? KEY.RIGHT : 0) | (tick % 5 === 0 ? KEY.UP : 0),
					p2: (tick % 4 === 0 ? KEY.LEFT : 0) | (tick % 7 === 0 ? KEY.UP : 0)
				})
			);
			if (tick % 3 === 0) broadcast([fast, slow], server);
			fast.client.stepTick(0);
			if (tick % 3 !== 0) slow.client.stepTick(0); // drops 2 of every 3 ticks
		}
		fast.rec.ops.length = 0;
		slow.rec.ops.length = 0;
		fast.client.renderFrame(0.5);
		slow.client.renderFrame(0.5);

		for (const player of [P1, P2]) {
			const a = hullDraws(fast.rec, player.color);
			const b = hullDraws(slow.rec, player.color);
			expect(a.length).toBeGreaterThan(0);
			expect(a).toEqual(b); // remote tanks: identical world positions
		}
		expect(shellDraws(fast.rec)).toEqual(shellDraws(slow.rec));
	});
});

// ---- (b) respawn discontinuity snaps ----

describe('tank render: respawn discontinuity', () => {
	/**
	 * Drive the server so `p2` dies at a known far-from-spawns spot and
	 * respawns at a spawn point a few snapshots later. The victim sits still
	 * so every pre-death hull draws exactly at the death anchor.
	 */
	function deathAndRespawn(): {
		snapshots: ReturnType<TankSim['snapshot']>[];
		deathX: number;
		deathY: number;
	} {
		const server = createTankSim(1337, CONFIG, PLAYERS);
		const snapshots: ReturnType<TankSim['snapshot']>[] = [];
		// Park the victim near the arena middle: at least ~100px from every
		// spawn point, so a respawn is a guaranteed teleport.
		const victim = server.tanks.find((t) => t.id === 'p2')!;
		victim.x = 240;
		victim.y = 136;
		for (let tick = 0; tick < 12; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		const deathX = victim.x;
		const deathY = victim.y;
		// A crafted death (as the server's hit would leave it), short respawn.
		victim.alive = false;
		victim.lives = 1;
		victim.respawnTimer = 12;
		for (let tick = 0; tick < 18; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		// The respawn flash makes the hull blink; scrub it so the test is
		// about positions (the blink has its own draw logic).
		for (const snap of snapshots) {
			const tank = (snap.tanks as { id: string; invulnTimer: number }[]).find((t) => t.id === 'p2');
			if (tank) tank.invulnTimer = 0;
		}
		return { snapshots, deathX, deathY };
	}

	it('never slides a respawning tank across the map and shows the respawn', () => {
		const { snapshots, deathX, deathY } = deathAndRespawn();
		const client = makeClient(960, 540);

		// Interleave like a real client: 3 frames per snapshot interval sweep
		// the render clock through every interpolation gap.
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

		// The respawn landed far from the death spot.
		const last = snapshots[snapshots.length - 1];
		const finalTank = (last.tanks as { id: string; x: number; y: number }[]).find(
			(t) => t.id === 'p2'
		)!;
		expect(Math.hypot(finalTank.x - deathX, finalTank.y - deathY)).toBeGreaterThan(50);

		const centers = perFrame.flat();
		expect(centers.length).toBeGreaterThan(0);
		let nearSpawn = 0;
		for (const c of centers) {
			if (Math.hypot(c.x - deathX, c.y - deathY) < 30) continue;
			if (Math.hypot(c.x - finalTank.x, c.y - finalTank.y) < 30) {
				nearSpawn++;
				continue;
			}
			expect.fail(`hull at ${c.x},${c.y} slid between the death spot and the spawn point`);
		}
		// The respawn IS shown (not just the wreck)...
		expect(nearSpawn).toBeGreaterThan(0);
		// ...and the dead stretch drew no hull at all.
		expect(perFrame.some((list) => list.length === 0)).toBe(true);
	});

	it('shows no wreck while dead and nothing at all when eliminated', () => {
		const server = createTankSim(1337, CONFIG, PLAYERS);
		const snapshots: ReturnType<TankSim['snapshot']>[] = [];
		for (let tick = 0; tick < 9; tick++) {
			server.tickOnce(inputMap({ p2: KEY.UP, p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		const victim = server.tanks.find((t) => t.id === 'p2')!;
		victim.alive = false;
		victim.lives = 1;
		victim.respawnTimer = 120; // long wait: stays dead through the whole buffer
		for (let tick = 0; tick < 9; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		const client = makeClient(960, 540);
		for (const snap of snapshots) client.client.onSnapshot(snap);
		for (let frame = 0; frame < 8; frame++) {
			client.rec.ops.length = 0;
			client.client.renderFrame(0);
			// Waiting to respawn: the wreck/ghost is hidden (no hull, ever).
			expect(hullDraws(client.rec, P2.color)).toHaveLength(0);
			now += 1000 / 60;
		}

		// Eliminated: nothing at all, and no phantom "RESPAWNING" wreck.
		victim.lives = 0;
		victim.respawnTimer = 0;
		for (let tick = 0; tick < 15; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) client.client.onSnapshot(server.snapshot());
		}
		for (let frame = 0; frame < 4; frame++) {
			client.rec.ops.length = 0;
			client.client.renderFrame(0);
			expect(hullDraws(client.rec, P2.color)).toHaveLength(0);
			now += 1000 / 60;
		}
	});
});

// ---- (c) hull angles across the +-pi seam ----

describe('tank render: angle seam', () => {
	it('rotates the short way when a remote hull crosses 180 degrees', () => {
		const server = createTankSim(1337, CONFIG, PLAYERS);
		const snapshots: ReturnType<TankSim['snapshot']>[] = [];
		const victim = server.tanks.find((t) => t.id === 'p2')!;
		victim.angle = 179 * DEG; // every sample rides the seam
		for (let tick = 0; tick < 6; tick++) {
			server.tickOnce(inputMap({ p3: KEY.RIGHT }));
			if (tick % 3 === 0) snapshots.push(server.snapshot());
		}
		// The last pair straddles the seam: 179deg -> -179deg (a 2deg turn).
		victim.angle = -179 * DEG;
		for (let tick = 0; tick < 3; tick++) server.tickOnce(inputMap({ p3: KEY.RIGHT }));
		snapshots.push(server.snapshot());

		const client = makeClient(960, 540);
		for (const snap of snapshots) client.client.onSnapshot(snap);
		for (let frame = 0; frame < 8; frame++) {
			client.rec.ops.length = 0;
			client.client.renderFrame(0);
			for (const hull of hullDraws(client.rec, P2.color)) {
				// Always near +-180deg; a naive lerp parks near 0deg mid-pair.
				expect(Math.abs(Math.abs(hull.angle) - Math.PI)).toBeLessThan(15 * DEG);
			}
			now += 1000 / 60;
		}
	});

	it('blends prediction corrections for the local tank the short way too', () => {
		// Prediction reaches +178.5deg by turning right in place; authority
		// sits just over the seam at -180.5deg. The correction is a ~1deg step,
		// never the 359deg spin a naive (after - before) offset would carry.
		const client = makeClient(960, 540);
		const server = createTankSim(1337, CONFIG, PLAYERS);
		for (let i = 0; i < 51; i++) client.client.stepTick(KEY.RIGHT); // 51 * 3.5deg
		for (let i = 0; i < 52; i++) server.tickOnce(new Map()); // snapshot ahead of prediction
		server.tanks[0].angle = -180.5 * DEG;
		client.client.onSnapshot(server.snapshot());

		for (let frame = 0; frame < 6; frame++) {
			client.rec.ops.length = 0;
			client.client.renderFrame(0);
			const hulls = hullDraws(client.rec, P1.color);
			expect(hulls.length).toBe(1);
			// Stays near +-180deg through the correction decay. A 359deg
			// offset whips the hull through 90deg within a frame or two.
			expect(Math.abs(Math.abs(hulls[0].angle) - Math.PI)).toBeLessThan(20 * DEG);
			now += 1000 / 60;
		}
	});
});
