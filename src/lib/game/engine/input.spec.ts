import { describe, expect, it } from 'vitest';
import { InputManager, type GamepadLike, type InputEventLike, type InputTargetLike } from './input';
import { KEY } from '../types';

class FakeTarget implements InputTargetLike {
	private readonly listeners = new Map<string, Set<(ev: InputEventLike) => void>>();

	addEventListener(type: string, listener: (ev: InputEventLike) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: (ev: InputEventLike) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	fire(type: string, ev: InputEventLike = {}): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

function fakeGamepad(axes: number[], pressedButtons: number[], buttonCount = 16): GamepadLike {
	const buttons = Array.from({ length: buttonCount }, (_, i) => ({
		pressed: pressedButtons.includes(i)
	}));
	return { axes, buttons };
}

describe('InputManager keyboard mapping', () => {
	const cases: [string, number][] = [
		['ArrowUp', KEY.UP],
		['ArrowDown', KEY.DOWN],
		['ArrowLeft', KEY.LEFT],
		['ArrowRight', KEY.RIGHT],
		['KeyW', KEY.UP],
		['KeyS', KEY.DOWN],
		['KeyA', KEY.LEFT],
		['KeyD', KEY.RIGHT],
		['Space', KEY.JUMP],
		['KeyZ', KEY.JUMP],
		['KeyK', KEY.JUMP],
		['KeyX', KEY.DRIFT],
		['KeyJ', KEY.DRIFT],
		['KeyC', KEY.SPECIAL],
		['KeyL', KEY.SPECIAL],
		['Enter', KEY.ITEM]
	];

	for (const [code, bit] of cases) {
		it(`maps ${code} to bit ${bit}`, () => {
			const target = new FakeTarget();
			const input = new InputManager({ target });
			target.fire('keydown', { code });
			expect(input.sample().keys).toBe(bit);
			target.fire('keyup', { code });
			expect(input.sample().keys).toBe(0);
		});
	}

	it('falls back to the event key for synthetic events', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		target.fire('keydown', { key: 'w' });
		expect(input.sample().keys).toBe(KEY.UP);
	});

	it('combines simultaneous keys into one bitmask', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		target.fire('keydown', { code: 'ArrowLeft' });
		target.fire('keydown', { code: 'Space' });
		expect(input.sample().keys).toBe(KEY.LEFT | KEY.JUMP);
		expect(input.keys).toBe(KEY.LEFT | KEY.JUMP);
	});

	it('ignores unmapped keys and prevents default on mapped ones', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		let prevented = 0;
		target.fire('keydown', { code: 'F5', preventDefault: () => prevented++ });
		target.fire('keydown', { code: 'ArrowUp', preventDefault: () => prevented++ });
		expect(input.sample().keys).toBe(KEY.UP);
		expect(prevented).toBe(1);
	});
});

describe('InputManager edge detection', () => {
	it('reports wasPressed exactly once per press', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		target.fire('keydown', { code: 'KeyZ' });

		expect(input.sample().keys).toBe(KEY.JUMP);
		expect(input.wasPressed(KEY.JUMP)).toBe(true);
		expect(input.wasPressed(KEY.DRIFT)).toBe(false);

		expect(input.sample().keys).toBe(KEY.JUMP);
		expect(input.wasPressed(KEY.JUMP)).toBe(false);
		expect(input.isDown(KEY.JUMP)).toBe(true);

		target.fire('keyup', { code: 'KeyZ' });
		expect(input.sample().keys).toBe(0);
		expect(input.isDown(KEY.JUMP)).toBe(false);
		expect(input.wasPressed(KEY.JUMP)).toBe(false);
	});

	it('clears held keys on blur', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		target.fire('keydown', { code: 'ArrowRight' });
		target.fire('blur');
		expect(input.sample().keys).toBe(0);
	});
});

describe('InputManager gamepads', () => {
	it('maps stick, dpad and face buttons with the standard mapping', () => {
		const input = new InputManager({ gamepads: () => [] });
		const pad = fakeGamepad([1, -1], [0, 2, 5]); // stick right+up, A, X, RB
		input.pollGamepads([pad]);
		expect(input.sample().keys).toBe(KEY.RIGHT | KEY.UP | KEY.JUMP | KEY.DRIFT | KEY.ITEM);

		const dpad = fakeGamepad([0, 0], [13, 14]); // dpad down + left
		input.pollGamepads([dpad]);
		expect(input.sample().keys).toBe(KEY.DOWN | KEY.LEFT);

		input.pollGamepads([fakeGamepad([0, 0], [])]);
		expect(input.sample().keys).toBe(0);
	});

	it('respects the deadzone and merges with the keyboard', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target, gamepads: () => [] });
		input.pollGamepads([fakeGamepad([0.3, 0], [])]);
		expect(input.sample().keys).toBe(0);

		target.fire('keydown', { code: 'ArrowLeft' });
		input.pollGamepads([fakeGamepad([-1, 0], [0])]);
		expect(input.sample().keys).toBe(KEY.LEFT | KEY.JUMP);
	});
});

describe('InputManager lifecycle', () => {
	it('detaches listeners and releases held keys', () => {
		const target = new FakeTarget();
		const input = new InputManager({ target });
		expect(target.listenerCount('keydown')).toBe(1);

		target.fire('keydown', { code: 'Space' });
		expect(input.sample().keys).toBe(KEY.JUMP);

		input.detach();
		expect(target.listenerCount('keydown')).toBe(0);
		target.fire('keydown', { code: 'Space' });
		expect(input.sample().keys).toBe(0);

		input.attach(target);
		target.fire('keydown', { code: 'Space' });
		expect(input.sample().keys).toBe(KEY.JUMP);
	});
});
