import { writable } from 'svelte/store';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
	id: number;
	message: string;
	kind: ToastKind;
}

export const toasts = writable<ToastItem[]>([]);

let nextId = 1;

/** Show a toast notification. Auto-dismisses after 3s; at most 3 are visible. */
export function toast(message: string, kind: ToastKind = 'info'): void {
	const id = nextId++;
	toasts.update((list) => [...list, { id, message, kind }].slice(-3));
	setTimeout(() => {
		toasts.update((list) => list.filter((item) => item.id !== id));
	}, 3000);
}
