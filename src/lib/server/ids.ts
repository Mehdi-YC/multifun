/**
 * Readable join-code alphabet: no 0/O/1/I/L to avoid transcription errors.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function lobbyCode(length = 6): string {
	let code = '';
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	for (let i = 0; i < length; i++) {
		code += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return code;
}

export function randomSeed(): number {
	const bytes = new Uint32Array(1);
	crypto.getRandomValues(bytes);
	return bytes[0] >>> 0;
}
