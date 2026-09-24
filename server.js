/**
 * Production entry: SvelteKit handler + realtime WebSocket on one HTTP server.
 * Run after `bun run build`.
 *
 * ORIGIN must be a valid URL for adapter-node; default it before the handler
 * module is imported. Set ORIGIN explicitly when deploying behind a proxy.
 */
const port = Number(process.env.PORT ?? 3000);
process.env.ORIGIN ||= `http://localhost:${port}`;

const { createServer } = await import('node:http');
const { handler } = await import('./build/handler.js');
const { getRealtimeServer } = await import('./build/realtime.js');

const server = createServer(handler);

getRealtimeServer().attach(server, '/realtime');

server.listen(port, () => {
	console.log(`MultiFun listening on ${process.env.ORIGIN}`);
});
