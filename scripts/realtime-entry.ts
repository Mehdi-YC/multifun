/**
 * Standalone realtime entry for production. Bundled to `build/realtime.js`
 * (see package.json `build:realtime`) and mounted by `server.js`.
 */
export { getRealtimeServer } from '$lib/server/realtime/server';
