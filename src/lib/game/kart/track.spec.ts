/**
 * Track validation for all three shipped Turbo Kart circuits, plus the AI
 * completeness guarantee: seeded AI karts must finish a full 3-lap race on
 * every track (this is what proves the tracks are actually playable).
 */
import { describe, expect, it } from 'vitest';
import type { GameConfig, InputFrame, PlayerId, SimPlayer } from '../types';
import {
	TILE_SIZE,
	TILE_CHARS,
	TRACKS,
	getTrack,
	hazardAt,
	isDrivableTile,
	nearestSpline,
	splineAt,
	tileAtPx,
	validateTrack
} from './track';
import { createKartSim, type KartSim } from './sim';

const P1: SimPlayer = { id: 'p1', name: 'Ada', color: '#ff5c7a', slot: 0 };
const P2: SimPlayer = { id: 'p2', name: 'Ben', color: '#57e389', slot: 1 };
const P3: SimPlayer = { id: 'p3', name: 'Cy', color: '#6ec6ff', slot: 2 };

const LAPS = 3;

function raceConfig(trackId: string, extra: Record<string, unknown> = {}): GameConfig {
	return {
		tickRate: 60,
		durationTicks: 60 * 300,
		options: { trackId, laps: LAPS, aiCount: 0, countdownTicks: 0, ...extra }
	};
}

describe('track structure', () => {
	it('ships three tracks with stable ids and names', () => {
		expect(TRACKS.map((t) => t.id)).toEqual(['sunny-circuit', 'neon-dojo', 'frostbite-falls']);
		for (const track of TRACKS) {
			expect(typeof track.name).toBe('string');
			expect(track.name.length).toBeGreaterThan(0);
		}
		expect(getTrack('neon-dojo').id).toBe('neon-dojo');
		// Unknown ids fall back to the first track.
		expect(getTrack('does-not-exist').id).toBe('sunny-circuit');
	});

	it('every tile char maps to a known tile type', () => {
		for (const track of TRACKS) {
			for (const tile of track.tiles) {
				expect(Object.values(TILE_CHARS)).toContain(tile);
			}
		}
	});

	it.each(TRACKS.map((t) => t.id))('%s passes every semantic check', (id) => {
		const track = getTrack(id);
		expect(validateTrack(track)).toEqual([]);
	});

	it.each(TRACKS.map((t) => t.id))('%s is a closed loop with sane lap length', (id) => {
		const track = getTrack(id);
		const n = track.spline.length;
		const first = track.spline[0];
		const last = track.spline[n - 1];
		// Closed: the wrap-around segment is a normal sample step.
		expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(18);
		expect(track.lapLength).toBeGreaterThan(600);
		expect(track.lapLength).toBeLessThan(6000);
		// Tangents are unit vectors.
		for (const p of track.spline) {
			expect(Math.hypot(p.tx, p.ty)).toBeCloseTo(1, 5);
		}
		// Arc length strictly increases and ends below the loop length.
		for (let i = 1; i < n; i++) {
			expect(track.spline[i].s).toBeGreaterThan(track.spline[i - 1].s);
		}
		expect(track.spline[n - 1].s).toBeLessThan(track.lapLength);
	});

	it.each(TRACKS.map((t) => t.id))('%s keeps the racing line on drivable ground', (id) => {
		const track = getTrack(id);
		const gapSet = new Set(track.jumpGaps);
		for (const p of track.spline) {
			const tile = tileAtPx(track, p.x, p.y);
			const index = Math.floor(p.y / TILE_SIZE) * track.cols + Math.floor(p.x / TILE_SIZE);
			expect(isDrivableTile(tile) || gapSet.has(index)).toBe(true);
		}
	});

	it.each(TRACKS.map((t) => t.id))('%s respawns and item boxes sit on drivable tiles', (id) => {
		const track = getTrack(id);
		expect(track.respawns.length).toBeGreaterThanOrEqual(12);
		for (const p of track.respawns) expect(isDrivableTile(tileAtPx(track, p.x, p.y))).toBe(true);
		expect(track.itemBoxes.length).toBeGreaterThan(0);
		for (const box of track.itemBoxes) {
			expect(tileAtPx(track, box.x, box.y)).toBe('itembox');
		}
	});

	it('frostbite-falls jump gaps are ramp-flanked water', () => {
		const track = getTrack('frostbite-falls');
		expect(track.jumpGaps.length).toBeGreaterThan(0);
		for (const index of track.jumpGaps) {
			const col = index % track.cols;
			const row = Math.floor(index / track.cols);
			let nearRamp = 0;
			for (let dy = -4; dy <= 4; dy++) {
				for (let dx = -4; dx <= 4; dx++) {
					const tile = tileAtPx(track, (col + dx) * TILE_SIZE + 1, (row + dy) * TILE_SIZE + 1);
					if (tile === 'ramp') nearRamp++;
				}
			}
			expect(nearRamp).toBeGreaterThan(0);
		}
	});

	it('neon-dojo shortcut sits behind breakable walls', () => {
		const track = getTrack('neon-dojo');
		expect(track.breakables.length).toBeGreaterThan(0);
		for (const index of track.breakables) {
			const col = index % track.cols;
			const row = Math.floor(index / track.cols);
			expect(tileAtPx(track, col * TILE_SIZE + 1, row * TILE_SIZE + 1)).toBe('wall');
		}
		// The breakable block must not sit on the racing line (that would cut
		// the track in half until someone smashes it).
		for (const p of track.spline) {
			const tile = tileAtPx(track, p.x, p.y);
			expect(tile).not.toBe('wall');
		}
	});

	it('spline helpers are consistent', () => {
		const track = getTrack('sunny-circuit');
		// splineAt wraps and interpolates within one sample step of the grid.
		const p = splineAt(track, track.lapLength * 0.5);
		const near = nearestSpline(track, p.x, p.y);
		expect(near.distance).toBeLessThan(TILE_SIZE);
		// Arc position round-trips through nearestSpline.
		expect(Math.abs(near.point.s - p.s)).toBeLessThan(20);
		// Out-of-range s wraps.
		const wrapped = splineAt(track, track.lapLength + 50);
		const base = splineAt(track, 50);
		expect(Math.hypot(wrapped.x - base.x, wrapped.y - base.y)).toBeLessThan(2);
		// A far-away query with a bad hint still finds the true nearest.
		const far = nearestSpline(track, -500, -500, 3);
		expect(far.distance).toBeGreaterThan(400);
	});

	it('hazards sweep deterministically along their path', () => {
		const track = getTrack('frostbite-falls');
		const hazard = track.hazards[0];
		const a = hazardAt(hazard, 0);
		const b = hazardAt(hazard, Math.round(hazard.period / 2));
		const c = hazardAt(hazard, hazard.period);
		expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeLessThan(0.001);
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(40);
		// Positions always stay on the path segment (colinear and in range).
		const abx = hazard.x1 - hazard.x0;
		const aby = hazard.y1 - hazard.y0;
		for (let tick = 0; tick <= hazard.period; tick += 7) {
			const p = hazardAt(hazard, tick);
			const cross = (p.x - hazard.x0) * aby - (p.y - hazard.y0) * abx;
			expect(Math.abs(cross)).toBeLessThan(1e-6);
			const dot = (p.x - hazard.x0) * abx + (p.y - hazard.y0) * aby;
			expect(dot).toBeGreaterThanOrEqual(-1e-6);
			expect(dot).toBeLessThanOrEqual(abx * abx + aby * aby + 1e-6);
		}
	});
});

// ---- AI completeness: the playability guarantee ----

describe('track AI completeness', () => {
	function runAiRace(trackId: string): KartSim {
		const config = raceConfig(trackId, {
			aiCount: 3,
			aiDifficulty: 'medium',
			durationTicks: 60 * 300
		});
		const sim = createKartSim(20250925, config, [P1, P2, P3]);
		const inputs = new Map<PlayerId, InputFrame>();
		// Humans idle in the pit lane; only the AI drives.
		for (const p of [P1, P2, P3]) inputs.set(p.id, { keys: 0 });
		const deadline = config.durationTicks;
		while (!sim.finished && sim.tick < deadline) sim.tickOnce(inputs);
		return sim;
	}

	it.each(TRACKS.map((t) => t.id))(
		'AI karts finish 3 laps on %s',
		(id) => {
			const sim = runAiRace(id);
			const ai = sim.karts.filter((k) => k.id.startsWith('ai-'));
			expect(ai.length).toBe(3);
			for (const kart of ai) {
				expect(kart.lap).toBe(LAPS);
				expect(kart.finished).toBe(true);
				expect(kart.finishTimeMs).toBeGreaterThan(0);
			}
			expect(sim.finished).toBe(true);
		},
		60_000
	);

	it('AI racers also complete on the hard difficulty', () => {
		const config = raceConfig('neon-dojo', {
			aiCount: 2,
			aiDifficulty: 'hard',
			durationTicks: 60 * 300
		});
		const sim = createKartSim(99, config, [P1]);
		const inputs = new Map<PlayerId, InputFrame>([[P1.id, { keys: 0 }]]);
		while (!sim.finished && sim.tick < config.durationTicks) sim.tickOnce(inputs);
		for (const kart of sim.karts.filter((k) => k.id.startsWith('ai-'))) {
			expect(kart.finished).toBe(true);
		}
	}, 60_000);
});
