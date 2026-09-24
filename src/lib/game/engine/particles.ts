/**
 * Pooled particle system. The pool is allocated once up front and `update()`
 * never allocates, so a busy match produces zero GC pressure. Emitting draws
 * from a seeded rng, so particle fields replay deterministically.
 */
import type { Canvas2DLike } from './gfx';
import { integrate } from './fixed';
import { mulberry32, type Rng } from './rng';

export type ParticleKind = 'spark' | 'dust' | 'trail' | 'pop' | 'ring';

export interface ParticleEmitConfig {
	kind: ParticleKind;
	x: number;
	y: number;
	/** Particles spawned by this call (default 1). */
	count?: number;
	/** Base speed in units/second (default depends on kind). */
	speed?: number;
	/** Direction in radians for directional kinds (default: full circle). */
	angle?: number;
	/** Random direction spread in radians around `angle` (default: Math.PI). */
	spread?: number;
	/** Lifetime in seconds (default depends on kind). */
	life?: number;
	/** Particle size in pixels (default depends on kind). */
	size?: number;
	color?: string;
	/** Gravity in units/second^2 (default depends on kind). */
	gravity?: number;
}

export interface ParticleSystemOptions {
	/** Fixed pool size (default 256). The pool never grows. */
	capacity?: number;
	/** Seeded rng (default: mulberry32(1)). */
	rng?: Rng;
	/** Fallback color. */
	defaultColor?: string;
}

export interface Particle {
	alive: boolean;
	kind: ParticleKind;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Seconds left to live. */
	life: number;
	maxLife: number;
	size: number;
	gravity: number;
	color: string;
}

interface KindDefaults {
	speed: number;
	life: number;
	size: number;
	gravity: number;
	color: string;
}

const KIND_DEFAULTS: Record<ParticleKind, KindDefaults> = {
	spark: { speed: 90, life: 0.3, size: 3, gravity: 220, color: '#ffd166' },
	dust: { speed: 25, life: 0.6, size: 2, gravity: -14, color: '#8b97b5' },
	trail: { speed: 8, life: 0.25, size: 3, gravity: 0, color: '#6ec6ff' },
	pop: { speed: 120, life: 0.35, size: 3, gravity: 300, color: '#ffffff' },
	ring: { speed: 0, life: 0.4, size: 24, gravity: 0, color: '#ffffff' }
};

const TAU = Math.PI * 2;

export class ParticleSystem {
	/** Fixed pool. Indexed directly; read-only for tests/debugging. */
	readonly particles: readonly Particle[];

	private readonly rng: Rng;
	private readonly defaultColor: string;
	private cursor = 0;
	private aliveCount = 0;

	constructor(options: ParticleSystemOptions = {}) {
		const capacity = options.capacity ?? 256;
		this.rng = options.rng ?? mulberry32(1);
		this.defaultColor = options.defaultColor ?? '#ffffff';
		const pool: Particle[] = [];
		for (let i = 0; i < capacity; i++) {
			pool.push({
				alive: false,
				kind: 'spark',
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				life: 0,
				maxLife: 1,
				size: 1,
				gravity: 0,
				color: this.defaultColor
			});
		}
		this.particles = pool;
	}

	get capacity(): number {
		return this.particles.length;
	}

	get active(): number {
		return this.aliveCount;
	}

	/** Spawn `count` particles; extras are dropped once the pool is full. */
	emit(config: ParticleEmitConfig): void {
		const defaults = KIND_DEFAULTS[config.kind];
		const count = config.count ?? 1;
		const spread = config.spread ?? Math.PI;
		const baseAngle = config.angle ?? this.rng() * TAU;
		for (let i = 0; i < count; i++) {
			const p = this.claimSlot();
			if (!p) return;
			const direction = baseAngle + (this.rng() * 2 - 1) * spread;
			const speed = (config.speed ?? defaults.speed) * (0.5 + this.rng());
			const life = (config.life ?? defaults.life) * (0.75 + this.rng() * 0.5);
			p.alive = true;
			p.kind = config.kind;
			p.x = config.x;
			p.y = config.y;
			if (config.kind === 'ring') {
				p.vx = 0;
				p.vy = 0;
			} else {
				p.vx = Math.cos(direction) * speed;
				p.vy = Math.sin(direction) * speed;
			}
			p.life = life;
			p.maxLife = life;
			p.size = config.size ?? defaults.size;
			p.gravity = config.gravity ?? defaults.gravity;
			p.color = config.color ?? defaults.color ?? this.defaultColor;
			this.aliveCount++;
		}
	}

	/** Advance all particles. Allocates nothing. */
	update(dt: number): void {
		if (dt <= 0) return;
		let count = 0;
		for (const p of this.particles) {
			if (!p.alive) continue;
			p.life -= dt;
			if (p.life <= 0) {
				p.alive = false;
				continue;
			}
			p.vy += p.gravity * dt;
			p.x = integrate(p.x, p.vx, dt);
			p.y = integrate(p.y, p.vy, dt);
			count++;
		}
		this.aliveCount = count;
	}

	draw(ctx: Canvas2DLike): void {
		for (const p of this.particles) {
			if (!p.alive) continue;
			const t = 1 - p.life / p.maxLife; // 0 -> 1 over the lifetime
			if (p.kind === 'ring') {
				const radius = Math.max(1, p.size * t);
				ctx.globalAlpha = 1 - t;
				ctx.strokeStyle = p.color;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(p.x, p.y, radius, 0, TAU);
				ctx.stroke();
				continue;
			}
			const shrink = p.kind === 'dust' ? 1 : 1 - t * 0.7;
			const size = Math.max(1, p.size * shrink);
			ctx.globalAlpha = p.kind === 'spark' ? 1 - t : 1 - t * 0.6;
			ctx.fillStyle = p.color;
			ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
		}
		ctx.globalAlpha = 1;
	}

	/** Deactivate every particle (keeps the pool). */
	clear(): void {
		for (const p of this.particles) p.alive = false;
		this.aliveCount = 0;
	}

	/** First dead slot from the rolling cursor (reuses slots, never grows). */
	private claimSlot(): Particle | null {
		const pool = this.particles;
		for (let i = 0; i < pool.length; i++) {
			const index = (this.cursor + i) % pool.length;
			if (!pool[index].alive) {
				this.cursor = (index + 1) % pool.length;
				return pool[index];
			}
		}
		return null;
	}
}
