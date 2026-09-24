/** Shim for `$env/dynamic/private` in the standalone realtime bundle (prod only). */
export const env: Record<string, string | undefined> = process.env;
