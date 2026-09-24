<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { createAuthClient } from 'better-auth/client';
	import { Avatar, PixelButton, ScanlineOverlay, Toast } from '$lib/ui';
	import { connection } from '$lib/stores/realtime';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const authClient = createAuthClient();

	const status = $derived(
		$connection === 'open'
			? { label: 'online', color: '#57e389' }
			: $connection === 'connecting'
				? { label: 'connecting', color: '#ffd166' }
				: { label: 'offline', color: '#ff5c7a' }
	);

	async function logout() {
		try {
			await authClient.signOut();
		} catch {
			// signing out with a dead session is fine — drop the local state anyway
		}
		await invalidateAll();
		await goto(resolve('/'));
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<ScanlineOverlay opacity={0.05} />

<div class="flex min-h-screen flex-col">
	<header class="sticky top-0 z-50 border-b-4 border-border bg-bg/95">
		<div
			class="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3"
		>
			<a
				href={resolve('/')}
				class="pixel-shadow btn-press bg-accent px-3 py-2 font-pixel text-sm text-bg select-none"
			>
				MULTIFUN
			</a>

			<nav class="flex items-center gap-4" aria-label="Main">
				<a
					href={resolve('/play/[gameId]', { gameId: 'echo' })}
					class="font-pixel text-[10px] text-text hover:text-accent"
				>
					PLAY
				</a>
				<a
					href={resolve('/leaderboard/[gameId]', { gameId: 'echo' })}
					class="font-pixel text-[10px] text-text hover:text-accent"
				>
					LEADERBOARDS
				</a>
			</nav>

			<div class="flex items-center gap-3">
				{#if data.user}
					<span
						class="inline-flex items-center gap-2 border-2 border-border px-2 py-1"
						title="Realtime connection: {status.label}"
					>
						<span
							class="inline-block h-2 w-2"
							style:background-color={status.color}
							style:animation={$connection === 'connecting'
								? 'blink 900ms steps(2) infinite'
								: undefined}
						></span>
						<span class="font-pixel text-[8px] text-muted">{status.label}</span>
					</span>
				{/if}

				{#if data.user && data.profile}
					<a
						href={resolve('/profile/[username]', { username: data.profile.username })}
						class="inline-flex items-center gap-2 border-4 border-border border-t-border-hi border-l-border-hi bg-surface-2 px-2 py-1 hover:border-accent"
					>
						<Avatar
							config={data.profile.avatarJson}
							size={28}
							alt="{data.profile.displayName}'s avatar"
						/>
						<span class="font-pixel text-[9px] text-text">{data.profile.displayName}</span>
					</a>
					<a
						href={resolve('/profile/edit')}
						aria-label="Settings"
						title="Settings"
						class="inline-flex h-10 w-10 items-center justify-center border-4 border-border border-t-border-hi border-l-border-hi bg-surface-2 text-lg hover:border-accent"
					>
						&#9881;
					</a>
					<PixelButton variant="ghost" size="sm" onclick={logout}>Log out</PixelButton>
				{:else if data.user}
					<a
						href={resolve('/profile/edit')}
						class="inline-flex items-center gap-2 border-4 border-border border-t-border-hi border-l-border-hi bg-surface-2 px-2 py-1 font-pixel text-[9px] text-text hover:border-accent"
					>
						SET UP PROFILE
					</a>
					<PixelButton variant="ghost" size="sm" onclick={logout}>Log out</PixelButton>
				{:else}
					<PixelButton variant="secondary" size="sm" onclick={() => goto(resolve('/login'))}>
						Log in
					</PixelButton>
					<PixelButton size="sm" onclick={() => goto(resolve('/signup'))}>Sign up</PixelButton>
				{/if}
			</div>
		</div>
	</header>

	<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
		{@render children()}
	</main>

	<footer class="border-t-4 border-border py-6">
		<div class="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4">
			<p class="font-pixel text-[8px] text-muted">MULTIFUN - pixel multiplayer</p>
			<a href={resolve('/')} class="font-pixel text-[8px] text-accent underline">HOME</a>
		</div>
	</footer>
</div>

<Toast />
