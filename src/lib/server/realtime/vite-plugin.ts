/**
 * Dev-only wiring: mounts the RealtimeServer on the Vite dev server's HTTP
 * server for `/realtime` WebSocket upgrades. In production, `server.js` mounts
 * it directly (see repo root).
 *
 * App code ($lib, $env, $app) is loaded through Vite's SSR module runner so
 * SvelteKit virtual modules resolve correctly.
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

type RealtimeModule = {
	getRealtimeServer(): {
		attach(httpServer: unknown, path?: string): void;
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
	};
};

async function loadRealtime(server: ViteDevServer): Promise<RealtimeModule | null> {
	const entry = '/src/lib/server/realtime/server.ts';
	try {
		// Vite 6+ environments API
		const env = (
			server as unknown as {
				environments?: { ssr?: { runner?: { import(id: string): Promise<unknown> } } };
			}
		).environments?.ssr;
		if (env?.runner) {
			return (await env.runner.import(entry)) as RealtimeModule;
		}
	} catch (err) {
		console.error('[realtime] failed to load via module runner', err);
	}
	try {
		// Legacy SSR loader
		const mod = server as unknown as {
			ssrLoadModule(id: string): Promise<unknown>;
		};
		return (await mod.ssrLoadModule(entry)) as RealtimeModule;
	} catch (err) {
		console.error('[realtime] failed to load via ssrLoadModule', err);
		return null;
	}
}

export function multifunRealtime(): Plugin {
	return {
		name: 'multifun-realtime',
		configureServer(server) {
			const httpServer = server.httpServer;
			if (!httpServer) return;
			const ready = loadRealtime(server);
			httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
				if (!(req.url ?? '').startsWith('/realtime')) return;
				void ready.then((mod) => {
					if (mod) {
						void mod.getRealtimeServer().handleUpgrade(req, socket, head);
					} else {
						socket.destroy();
					}
				});
			});
		}
	};
}
