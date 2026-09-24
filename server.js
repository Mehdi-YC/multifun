/**
 * Production entry: SvelteKit handler + realtime WebSocket on one HTTP server.
 * Run after `bun run build`.
 */
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { getRealtimeServer } from './build/realtime.js';

const port = Number(process.env.PORT ?? 3000);
const server = createServer(handler);

getRealtimeServer().attach(server, '/realtime');

server.listen(port, () => {
	console.log(`MultiFun listening on http://localhost:${port}`);
});
