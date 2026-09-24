import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'bun run build && bun run start',
		port: 4173,
		timeout: 180_000,
		reuseExistingServer: true,
		env: { PORT: '4173' }
	},
	use: { baseURL: 'http://localhost:4173' },
	testMatch: '**/*.e2e.{ts,js}',
	timeout: 90_000
});
