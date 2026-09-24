import { describe, expect, it } from 'vitest';
import { ParticleSystem, type ParticleEmitConfig } from './particles';
import type { Canvas2DLike } from './gfx';
import { mulberry32 } from './rng';

function recordingCtx(): { ctx: Canvas2DLike; calls: string[] } {
	const calls: string[] = [];
	const ctx: Canvas2DLike = {
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		imageSmoothingEnabled: false,
		globalAlpha: 1,
		save: () => calls.push('save'),
		restore: () => calls.push('restore'),
		setTransform: () => calls.push('setTransform'),
		translate: () => calls.push('translate'),
		scale: () => calls.push('scale'),
		rotate: () => calls.push('rotate'),
		clearRect: () => calls.push('clearRect'),
		fillRect: () => calls.push('fillRect'),
		strokeRect: () => calls.push('strokeRect'),
		beginPath: () => calls.push('beginPath'),
		closePath: () => calls.push('closePath'),
		moveTo: () => calls.push('moveTo'),
		lineTo: () => calls.push('lineTo'),
		arc: () => calls.push('arc'),
		fill: () => calls.push('fill'),
		stroke: () => calls.push('stroke'),
		drawImage: () => calls.push('drawImage')
	};
	return { ctx, calls };
}

const BURST: ParticleEmitConfig = { kind: 'pop', x: 100, y: 80, count: 20 };

describe('ParticleSystem pool', () => {
	it('never grows beyond its fixed capacity', () => {
		const ps = new ParticleSystem({ capacity: 32, rng: mulberry32(7) });
		ps.emit({ ...BURST, count: 500 });
		expect(ps.capacity).toBe(32);
		expect(ps.particles.length).toBe(32);
		expect(ps.active).toBe(32);
	});

	it('reuses dead slots after particles expire', () => {
		const ps = new ParticleSystem({ capacity: 32, rng: mulberry32(7) });
		ps.emit({ ...BURST, count: 32 });
		expect(ps.active).toBe(32);

		ps.update(10); // everything dies (lifetimes are sub-second)
		expect(ps.active).toBe(0);

		ps.emit({ kind: 'spark', x: 0, y: 0, count: 4 });
		expect(ps.active).toBe(4);
		expect(ps.particles.length).toBe(32);
		expect(ps.capacity).toBe(32);
	});

	it('clear() deactivates everything without freeing the pool', () => {
		const ps = new ParticleSystem({ capacity: 8, rng: mulberry32(3) });
		ps.emit({ ...BURST, count: 8 });
		ps.clear();
		expect(ps.active).toBe(0);
		expect(ps.capacity).toBe(8);
	});
});

describe('ParticleSystem determinism', () => {
	it('replays identical trajectories from the same seed', () => {
		const a = new ParticleSystem({ capacity: 64, rng: mulberry32(1234) });
		const b = new ParticleSystem({ capacity: 64, rng: mulberry32(1234) });
		const configs: ParticleEmitConfig[] = [
			BURST,
			{ kind: 'spark', x: 10, y: 10, count: 8, angle: 1, spread: 0.5 },
			{ kind: 'dust', x: 200, y: 150, count: 6 },
			{ kind: 'trail', x: 30, y: 40, count: 4 },
			{ kind: 'ring', x: 240, y: 135, count: 2 }
		];
		for (const config of configs) {
			a.emit(config);
			b.emit(config);
		}
		for (let step = 0; step < 30; step++) {
			a.update(1 / 60);
			b.update(1 / 60);
		}
		const state = (ps: ParticleSystem) =>
			ps.particles.map((p) => ({ alive: p.alive, x: p.x, y: p.y, life: p.life }));
		expect(state(a)).toEqual(state(b));
		expect(a.active).toBe(b.active);
		expect(a.active).toBeGreaterThan(0);
	});
});

describe('ParticleSystem drawing', () => {
	it('draws live particles through the injected backend', () => {
		const ps = new ParticleSystem({ capacity: 16, rng: mulberry32(5) });
		ps.emit({ kind: 'spark', x: 5, y: 5, count: 3 });
		ps.emit({ kind: 'ring', x: 5, y: 5, count: 1 });
		const { ctx, calls } = recordingCtx();
		ps.draw(ctx);
		expect(calls).toContain('fillRect');
		expect(calls).toContain('arc');
		expect(calls.filter((c) => c === 'arc')).toHaveLength(1);

		ps.update(10);
		calls.length = 0;
		ps.draw(ctx);
		expect(calls.filter((c) => c === 'fillRect')).toHaveLength(0);
	});
});
