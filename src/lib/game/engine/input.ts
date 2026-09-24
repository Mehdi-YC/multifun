/**
 * Keyboard + Gamepad input sampling. Produces `InputFrame` bitmasks (one per
 * fixed tick) with edge detection for "was pressed this tick" queries.
 *
 * DOM listeners are optional: the module imports fine in node. Gamepad polling
 * is pull-based and must be called from the game loop.
 */
import type { InputFrame } from '../types';
import { KEY } from '../types';

/** The slice of KeyboardEvent we care about (synthetic events work too). */
export interface InputEventLike {
	code?: string;
	key?: string;
	preventDefault?: () => void;
}

/** The slice of EventTarget we care about (window, an element, or a fake). */
export interface InputTargetLike {
	addEventListener(type: string, listener: (ev: InputEventLike) => void): void;
	removeEventListener(type: string, listener: (ev: InputEventLike) => void): void;
}

/** The slice of Gamepad we care about (standard mapping). */
export interface GamepadLike {
	readonly axes: readonly number[];
	readonly buttons: readonly { readonly pressed: boolean }[];
}

export interface InputManagerOptions {
	/** Element/window to listen on. Defaults to `window` when it exists. */
	target?: InputTargetLike | null;
	/** Axis magnitude above which a stick counts as pressed (default 0.5). */
	deadzone?: number;
	/** Gamepad source. Defaults to `navigator.getGamepads()` when available. */
	gamepads?: () => readonly (GamepadLike | null)[];
}

const CODE_TO_KEY: Record<string, number> = {
	ArrowUp: KEY.UP,
	ArrowDown: KEY.DOWN,
	ArrowLeft: KEY.LEFT,
	ArrowRight: KEY.RIGHT,
	KeyW: KEY.UP,
	KeyS: KEY.DOWN,
	KeyA: KEY.LEFT,
	KeyD: KEY.RIGHT,
	Space: KEY.JUMP,
	KeyZ: KEY.JUMP,
	KeyK: KEY.JUMP,
	KeyX: KEY.DRIFT,
	KeyJ: KEY.DRIFT,
	KeyC: KEY.SPECIAL,
	KeyL: KEY.SPECIAL,
	Enter: KEY.ITEM,
	NumpadEnter: KEY.ITEM
};

const CHAR_TO_KEY: Record<string, number> = {
	w: KEY.UP,
	s: KEY.DOWN,
	a: KEY.LEFT,
	d: KEY.RIGHT,
	' ': KEY.JUMP,
	z: KEY.JUMP,
	k: KEY.JUMP,
	x: KEY.DRIFT,
	j: KEY.DRIFT,
	c: KEY.SPECIAL,
	l: KEY.SPECIAL,
	enter: KEY.ITEM
};

/** Standard-mapping gamepad buttons: A, B, X, RB, RT, dpad. */
const BUTTON_TO_KEY: Record<number, number> = {
	0: KEY.JUMP,
	1: KEY.SPECIAL,
	2: KEY.DRIFT,
	5: KEY.ITEM,
	7: KEY.ITEM,
	12: KEY.UP,
	13: KEY.DOWN,
	14: KEY.LEFT,
	15: KEY.RIGHT
};

function resolveBit(ev: InputEventLike): number {
	if (ev.code !== undefined && CODE_TO_KEY[ev.code] !== undefined) return CODE_TO_KEY[ev.code];
	const ch = (ev.key ?? '').toLowerCase();
	return CHAR_TO_KEY[ch] ?? 0;
}

function defaultGamepads(): readonly (GamepadLike | null)[] {
	if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
	const pads = navigator.getGamepads();
	return (pads ?? []) as readonly (GamepadLike | null)[];
}

export class InputManager {
	private readonly deadzone: number;
	private readonly gamepadSource: () => readonly (GamepadLike | null)[];

	private target: InputTargetLike | null = null;
	private keyboard = 0;
	private pad = 0;
	private previous = 0;
	private edges = 0;

	constructor(options: InputManagerOptions = {}) {
		this.deadzone = options.deadzone ?? 0.5;
		this.gamepadSource = options.gamepads ?? defaultGamepads;
		if (options.target !== undefined) this.attach(options.target);
	}

	/** Start listening on a target (defaults to `window` when it exists). */
	attach(target?: InputTargetLike | null): void {
		this.detach();
		const resolved =
			target === undefined
				? typeof window !== 'undefined'
					? (window as unknown as InputTargetLike)
					: null
				: target;
		if (!resolved) return;
		this.target = resolved;
		resolved.addEventListener('keydown', this.onKeyDown);
		resolved.addEventListener('keyup', this.onKeyUp);
		resolved.addEventListener('blur', this.onBlur);
	}

	/** Remove DOM listeners and release all held keys. */
	detach(): void {
		if (!this.target) return;
		this.target.removeEventListener('keydown', this.onKeyDown);
		this.target.removeEventListener('keyup', this.onKeyUp);
		this.target.removeEventListener('blur', this.onBlur);
		this.target = null;
		this.keyboard = 0;
		this.pad = 0;
	}

	/** Pull-based gamepad state; call once per tick before `sample()`. */
	pollGamepads(gamepads?: readonly (GamepadLike | null)[]): void {
		const pads = gamepads ?? this.gamepadSource();
		let mask = 0;
		for (const pad of pads) {
			if (!pad) continue;
			const ax = pad.axes[0] ?? 0;
			const ay = pad.axes[1] ?? 0;
			if (ax <= -this.deadzone) mask |= KEY.LEFT;
			if (ax >= this.deadzone) mask |= KEY.RIGHT;
			if (ay <= -this.deadzone) mask |= KEY.UP;
			if (ay >= this.deadzone) mask |= KEY.DOWN;
			for (const [index, bit] of Object.entries(BUTTON_TO_KEY)) {
				const button = pad.buttons[Number(index)];
				if (button && button.pressed) mask |= bit;
			}
		}
		this.pad = mask;
	}

	/** Snapshot the current input as a bitmask and advance the edge state. */
	sample(): InputFrame {
		const keys = this.keyboard | this.pad;
		this.edges = keys & ~this.previous;
		this.previous = keys;
		return { keys };
	}

	/** True when the key bit was pressed since the previous `sample()`. */
	wasPressed(key: number): boolean {
		return (this.edges & key) !== 0;
	}

	/** True while the key bit is currently held (keyboard or gamepad). */
	isDown(key: number): boolean {
		return ((this.keyboard | this.pad) & key) !== 0;
	}

	/** Current bitmask without advancing the edge state. */
	get keys(): number {
		return this.keyboard | this.pad;
	}

	/** Release everything (also resets edge state). */
	clear(): void {
		this.keyboard = 0;
		this.pad = 0;
		this.previous = 0;
		this.edges = 0;
	}

	private readonly onKeyDown = (ev: InputEventLike): void => {
		const bit = resolveBit(ev);
		if (bit === 0) return;
		this.keyboard |= bit;
		ev.preventDefault?.();
	};

	private readonly onKeyUp = (ev: InputEventLike): void => {
		const bit = resolveBit(ev);
		if (bit === 0) return;
		this.keyboard &= ~bit;
	};

	private readonly onBlur = (): void => {
		this.keyboard = 0;
	};
}
