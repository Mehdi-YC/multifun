/**
 * Dev/preview wiring for the RealtimeServer:
 * - dev: Vite dev server upgrade hook, app code loaded through the SSR module runner
 * - preview: loads the standalone prod bundle `build/realtime.js` (run `bun run build`
 *   first) so `vite preview` behaves like production
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

interface RealtimeHandle {
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

type RealtimeModule = {
	getRealtimeServer(): RealtimeHandle;
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

/** `.env` values for the standalone bundle (vite preview does not set process.env). */
async function loadPreviewEnv(root: string, mode: string): Promise<void> {
	const { loadEnv } = await import('vite');
	const fileEnv = loadEnv(mode, root, '');
	for (const key of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'PORT']) {
		if (!process.env[key] && fileEnv[key]) process.env[key] = fileEnv[key];
	}
	process.env.DATABASE_URL ||= 'local.db';
}

function loadPreviewBundle(root: string): Promise<RealtimeModule | null> {
	const bundle = path.join(root, 'build', 'realtime.js');
	if (!existsSync(bundle)) {
		console.warn(
			'[realtime] build/realtime.js not found — run `bun run build` for multiplayer in preview'
		);
		return Promise.resolve(null);
	}
	return import(pathToFileURL(bundle).href) as Promise<RealtimeModule>;
}

export function multifunRealtime(): Plugin {
	let root = process.cwd();
	return {
		name: 'multifun-realtime',
		configResolved(config) {
			root = config.root;
		},
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
		},
		configurePreviewServer(server: PreviewServer) {
			const httpServer = server.httpServer;
			if (!httpServer) return;
			const ready = (async () => {
				try {
					await loadPreviewEnv(root, server.config?.mode ?? 'production');
					return await loadPreviewBundle(root);
				} catch (err) {
					console.error('[realtime] failed to load preview bundle', err);
					return null;
				}
			})();
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
