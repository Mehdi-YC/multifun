/**
 * World-unit camera with smoothed follow, velocity look-ahead and
 * deterministic trauma-based shake (offsets come from a seeded rng).
 */
import type { Canvas2DLike } from './gfx';
import { clamp } from './fixed';
import { mulberry32, type Rng } from './rng';

export interface CameraOptions {
	/** Viewport size in screen pixels. */
	width: number;
	height: number;
	zoom?: number;
	/** Seeded rng for shake offsets (default: mulberry32(1)). */
	rng?: Rng;
	/** Exponential follow smoothing rate per second (higher = snappier). */
	smoothing?: number;
	/** Seconds of velocity look-ahead. 0 disables look-ahead. */
	lookAhead?: number;
	/** Clamp on look-ahead offset in world units. */
	maxLookAhead?: number;
	/** Trauma lost per second. */
	shakeDecay?: number;
	/** Shake offset in screen pixels at trauma = 1. */
	shakeScale?: number;
	/** Shake rotation in radians at trauma = 1. */
	shakeAngle?: number;
}

export type Point = { x: number; y: number };

export class Camera {
	/** Camera center in world units. */
	x = 0;
	y = 0;
	zoom: number;

	/** Current shake intensity in [0, 1]. */
	trauma = 0;

	private readonly width: number;
	private readonly height: number;
	private readonly rng: Rng;
	private readonly smoothing: number;
	private readonly lookAhead: number;
	private readonly maxLookAhead: number;
	private readonly shakeDecay: number;
	private readonly shakeScale: number;
	private readonly shakeAngle: number;

	private shakeX = 0;
	private shakeY = 0;
	private shakeRot = 0;

	constructor(options: CameraOptions) {
		this.width = options.width;
		this.height = options.height;
		this.zoom = options.zoom ?? 1;
		this.rng = options.rng ?? mulberry32(1);
		this.smoothing = options.smoothing ?? 8;
		this.lookAhead = options.lookAhead ?? 0.25;
		this.maxLookAhead = options.maxLookAhead ?? 48;
		this.shakeDecay = options.shakeDecay ?? 1.5;
		this.shakeScale = options.shakeScale ?? 8;
		this.shakeAngle = options.shakeAngle ?? 0.02;
	}

	setPosition(x: number, y: number): void {
		this.x = x;
		this.y = y;
	}

	/**
	 * Smoothly follow a world position, optionally leading by velocity.
	 * Also advances shake (call once per frame with the frame dt).
	 */
	follow(x: number, y: number, dt: number, vx = 0, vy = 0): void {
		const leadX = clamp(vx * this.lookAhead, -this.maxLookAhead, this.maxLookAhead);
		const leadY = clamp(vy * this.lookAhead, -this.maxLookAhead, this.maxLookAhead);
		const t = 1 - Math.exp(-this.smoothing * Math.max(0, dt));
		this.x += (x + leadX - this.x) * t;
		this.y += (y + leadY - this.y) * t;

		this.trauma = Math.max(0, this.trauma - this.shakeDecay * Math.max(0, dt));
		const shake = this.trauma * this.trauma;
		this.shakeX = (this.rng() * 2 - 1) * this.shakeScale * shake;
		this.shakeY = (this.rng() * 2 - 1) * this.shakeScale * shake;
		this.shakeRot = (this.rng() * 2 - 1) * this.shakeAngle * shake;
	}

	/** Raise shake intensity (clamped to [0, 1]); 0.1..0.4 feels right. */
	addTrauma(amount: number): void {
		this.trauma = clamp(this.trauma + amount, 0, 1);
	}

	/** Compose the world transform (call after PixelCanvas.begin()). */
	applyTo(ctx: Canvas2DLike): void {
		ctx.translate(this.width / 2 + this.shakeX, this.height / 2 + this.shakeY);
		if (this.shakeRot !== 0) ctx.rotate(this.shakeRot);
		ctx.scale(this.zoom, this.zoom);
		ctx.translate(-this.x, -this.y);
	}

	/** World units -> screen pixels (shake rotation is ignored). */
	worldToScreen(wx: number, wy: number): Point {
		return {
			x: (wx - this.x) * this.zoom + this.width / 2 + this.shakeX,
			y: (wy - this.y) * this.zoom + this.height / 2 + this.shakeY
		};
	}

	/** Screen pixels -> world units (shake is ignored). */
	screenToWorld(sx: number, sy: number): Point {
		return {
			x: (sx - this.width / 2 - this.shakeX) / this.zoom + this.x,
			y: (sy - this.height / 2 - this.shakeY) / this.zoom + this.y
		};
	}
}
