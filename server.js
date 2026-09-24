/**
 * Production entry: SvelteKit handler + realtime WebSocket on one HTTP server.
 * Run after `bun run build`: `bun run start` (or `bun run preview`).
 *
 * Accepts `--port <n>` / `-p <n>` (also PORT env). ORIGIN must be a valid URL
 * for adapter-node; default it before the handler module is imported. Set ORIGIN
 * explicitly when deploying behind a proxy.
 */
const argPort = (() => {
	const args = process.argv.slice(2);
	const idx = args.findIndex((a) => a === '--port' || a === '-p');
	if (idx !== -1 && args[idx + 1]) return Number(args[idx + 1]);
	const inline = args.find((a) => a.startsWith('--port='));
	if (inline) return Number(inline.slice('--port='.length));
	return NaN;
})();

const port = Number.isFinite(argPort) && argPort > 0 ? argPort : Number(process.env.PORT ?? 3000);
process.env.PORT = String(port);
process.env.ORIGIN ||= `http://localhost:${port}`;
process.env.DATABASE_URL ||= 'local.db';

const { createServer } = await import('node:http');
const { handler } = await import('./build/handler.js');
const { getRealtimeServer } = await import('./build/realtime.js');

const server = createServer(handler);

getRealtimeServer().attach(server, '/realtime');

server.listen(port, () => {
	console.log(`MultiFun listening on ${process.env.ORIGIN}`);
});
