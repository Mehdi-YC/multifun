/** Shim for `$app/server` in the standalone realtime bundle (prod only). */
export function getRequestEvent(): never {
	throw new Error('$app/server is not available in the realtime bundle');
}
