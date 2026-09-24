/**
 * WebAudio SFX. Everything is synthesized (oscillator blips + noise bursts):
 * no samples, no network. Lazily creates the AudioContext, resumes it from a
 * user gesture via `unlock()`, and no-ops safely where WebAudio doesn't exist
 * (node tests, SSR).
 */
import { mulberry32 } from './rng';

export interface AudioVolumes {
	music: number;
	sfx: number;
}

export interface AudioManagerOptions {
	/** AudioContext factory override (tests). Return null to disable audio. */
	createContext?: () => AudioContext | null;
}

export interface Sfx {
	jump(): void;
	death(): void;
	boost(): void;
	click(): void;
	countdown(): void;
	finish(): void;
}

function defaultCreateContext(): AudioContext | null {
	if (typeof globalThis.AudioContext === 'undefined') return null;
	try {
		return new AudioContext();
	} catch {
		return null;
	}
}

interface ToneSpec {
	type: OscillatorType;
	from: number;
	to: number;
	duration: number;
	gain: number;
	delay?: number;
}

export class AudioManager {
	readonly sfx: Sfx;

	private readonly createContext: () => AudioContext | null;
	private ctx: AudioContext | null = null;
	private sfxGain: GainNode | null = null;
	private musicGain: GainNode | null = null;
	private noiseBuffer: AudioBuffer | null = null;
	private musicVolume = 0.5;
	private sfxVolume = 0.7;

	constructor(options: AudioManagerOptions = {}) {
		this.createContext = options.createContext ?? defaultCreateContext;
		this.sfx = {
			jump: () => this.tone({ type: 'square', from: 300, to: 620, duration: 0.12, gain: 0.16 }),
			death: () => {
				this.tone({ type: 'square', from: 420, to: 70, duration: 0.35, gain: 0.2 });
				this.noise(0.25, 0.12);
			},
			boost: () => this.tone({ type: 'triangle', from: 180, to: 780, duration: 0.18, gain: 0.18 }),
			click: () => this.tone({ type: 'square', from: 900, to: 720, duration: 0.04, gain: 0.1 }),
			countdown: () =>
				this.tone({ type: 'square', from: 440, to: 440, duration: 0.09, gain: 0.14 }),
			finish: () => {
				this.tone({ type: 'triangle', from: 523, to: 523, duration: 0.12, gain: 0.16 });
				this.tone({
					type: 'triangle',
					from: 659,
					to: 659,
					duration: 0.12,
					gain: 0.16,
					delay: 0.12
				});
				this.tone({
					type: 'triangle',
					from: 784,
					to: 784,
					duration: 0.12,
					gain: 0.16,
					delay: 0.24
				});
				this.tone({
					type: 'triangle',
					from: 1046,
					to: 1046,
					duration: 0.3,
					gain: 0.18,
					delay: 0.36
				});
			}
		};
	}

	/** Call from a user gesture (click/keydown) to satisfy autoplay policies. */
	unlock(): void {
		const ctx = this.ensure();
		if (ctx && ctx.state === 'suspended') void ctx.resume();
	}

	get unlocked(): boolean {
		return this.ctx !== null && this.ctx.state === 'running';
	}

	setMusicVolume(volume: number): void {
		this.musicVolume = Math.max(0, Math.min(1, volume));
		if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
	}

	setSfxVolume(volume: number): void {
		this.sfxVolume = Math.max(0, Math.min(1, volume));
		if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
	}

	getVolumes(): AudioVolumes {
		return { music: this.musicVolume, sfx: this.sfxVolume };
	}

	/** Tear down the context (match over / component unmount). */
	dispose(): void {
		if (this.ctx) void this.ctx.close();
		this.ctx = null;
		this.sfxGain = null;
		this.musicGain = null;
		this.noiseBuffer = null;
	}

	private ensure(): AudioContext | null {
		if (this.ctx) return this.ctx;
		const ctx = this.createContext();
		if (!ctx) return null;
		this.ctx = ctx;
		this.sfxGain = ctx.createGain();
		this.sfxGain.gain.value = this.sfxVolume;
		this.sfxGain.connect(ctx.destination);
		this.musicGain = ctx.createGain();
		this.musicGain.gain.value = this.musicVolume;
		this.musicGain.connect(ctx.destination);
		return ctx;
	}

	private tone(spec: ToneSpec): void {
		const ctx = this.ensure();
		if (!ctx || !this.sfxGain) return;
		const t0 = ctx.currentTime + (spec.delay ?? 0);
		const osc = ctx.createOscillator();
		osc.type = spec.type;
		osc.frequency.setValueAtTime(spec.from, t0);
		osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.duration);
		const env = ctx.createGain();
		env.gain.setValueAtTime(Math.max(0.001, spec.gain), t0);
		env.gain.exponentialRampToValueAtTime(0.001, t0 + spec.duration);
		osc.connect(env);
		env.connect(this.sfxGain);
		osc.start(t0);
		osc.stop(t0 + spec.duration + 0.01);
	}

	private noise(duration: number, gain: number): void {
		const ctx = this.ensure();
		if (!ctx || !this.sfxGain) return;
		const buffer = this.noiseBuffer ?? this.makeNoise(ctx);
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		const env = ctx.createGain();
		const t0 = ctx.currentTime;
		env.gain.setValueAtTime(Math.max(0.001, gain), t0);
		env.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
		src.connect(env);
		env.connect(this.sfxGain);
		src.start(t0);
		src.stop(t0 + duration);
	}

	private makeNoise(ctx: AudioContext): AudioBuffer {
		const length = Math.ceil(ctx.sampleRate * 0.25);
		const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const data = buffer.getChannelData(0);
		// Deterministic noise source; no Math.random needed.
		const rnd = mulberry32(0x5eed);
		for (let i = 0; i < length; i++) data[i] = rnd() * 2 - 1;
		this.noiseBuffer = buffer;
		return buffer;
	}
}
