/**
 * Phase 0 acceptance: two browsers sign up, one creates a lobby, the other
 * joins by code, they chat, ready up, play a match and see results.
 */
import { expect, test, type Page } from '@playwright/test';

let uid = 0;
const nextEmail = () => `e2e-${Date.now()}-${uid++}@test.dev`;

async function signUp(page: Page, name: string, email: string): Promise<void> {
	await page.goto('/signup');
	await page.getByLabel('Display name').fill(name);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill('password123');
	await page.getByLabel('Confirm password').fill('password123');
	await page.getByRole('main').getByRole('button', { name: 'Sign up' }).click();
	await expect(page).toHaveURL('/');
}

test('signs up and edits the pixel avatar + profile', async ({ page }) => {
	const email = nextEmail();
	await signUp(page, 'Alice', email);

	// account chip in the nav leads to the profile page
	await page.getByRole('link', { name: /Alice/ }).first().click();
	await expect(page).toHaveURL(/\/profile\/alice/);
	await expect(page.getByText('No matches yet').first()).toBeVisible();

	// avatar builder
	await page.goto('/profile/edit');
	const preview = page.getByRole('img', { name: /avatar/i }).first();
	await expect(preview).toBeVisible();
	await page.getByRole('button', { name: 'Randomize' }).click();
	await page.getByLabel('Display name').fill('AlicePrime');
	await page.getByRole('button', { name: /Save/ }).click();
	await expect(page).toHaveURL(/\/profile\/alice/);
	await expect(page.getByText('AlicePrime').first()).toBeVisible();
});

test('two players: lobby by code, chat, ready, match with results', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const pageA = await ctxA.newPage();
	const pageB = await ctxB.newPage();

	await signUp(pageA, 'Host', nextEmail());
	await signUp(pageB, 'Guest', nextEmail());

	// --- host creates a lobby from the game page ---
	await pageA.goto('/play/echo');
	await pageA.getByLabel('Lobby name').fill('E2E Lobby');
	await pageA.getByRole('button', { name: 'Create', exact: true }).click();
	await pageA.waitForURL(/\/lobby\/[A-Z0-9]{6}/);
	const code = pageA.url().split('/').pop()!;
	expect(code).toMatch(/^[A-Z0-9]{6}$/);

	// --- guest joins by code from the landing page ---
	await pageB.goto('/');
	await pageB.getByLabel('Lobby code').fill(code);
	await pageB.getByRole('button', { name: 'Join', exact: true }).click();
	await pageB.waitForURL(new RegExp(`/lobby/${code}`));

	// both see both players in the room
	for (const page of [pageA, pageB]) {
		await expect(page.getByText('Host').first()).toBeVisible();
		await expect(page.getByText('Guest').first()).toBeVisible();
	}

	// --- chat ---
	await pageB.getByPlaceholder(/Say something|Reconnecting/).fill('hi host!');
	await pageB.getByRole('button', { name: 'Send' }).click();
	await expect(pageA.getByText('hi host!')).toBeVisible();

	// --- ready up (UI requires everyone, including the host) ---
	await pageB.getByRole('button', { name: 'Ready up' }).click();
	await expect(pageB.getByRole('button', { name: 'Not ready' })).toBeVisible();
	await pageA.getByRole('button', { name: 'Ready up' }).click();
	await expect(pageA.getByRole('button', { name: 'Not ready' })).toBeVisible();

	// --- host starts the match ---
	await pageA.getByRole('button', { name: 'START GAME' }).click();

	// game shell appears on both sides
	await expect(pageA.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
	await expect(pageB.locator('canvas').first()).toBeVisible({ timeout: 15_000 });

	// --- results screen after the 20s match ---
	await expect(pageA.getByText('RESULTS')).toBeVisible({ timeout: 45_000 });
	await expect(pageB.getByText('RESULTS')).toBeVisible({ timeout: 45_000 });
	await expect(pageA.getByText('Back to lobby')).toBeVisible();

	await pageA.getByRole('button', { name: 'Back to lobby' }).click();
	await expect(pageA.getByRole('button', { name: 'Ready up' })).toBeVisible();

	await ctxA.close();
	await ctxB.close();
});
