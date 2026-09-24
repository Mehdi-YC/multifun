<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { GAME_META, isGameId } from '$lib/game/meta';
	import { Avatar, PixelButton, PixelPanel, toast } from '$lib/ui';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const joined = $derived(
		new Date(data.profile.createdAt).toLocaleDateString('en-US', {
			month: 'long',
			year: 'numeric'
		})
	);

	function gameTitle(id: string): string {
		return isGameId(id) ? GAME_META[id].title : id;
	}

	function gameAccent(id: string): string {
		return isGameId(id) ? GAME_META[id].accent : 'var(--color-accent)';
	}

	function ordinal(n: number): string {
		const suffix =
			n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
		return `${n}${suffix}`;
	}

	function placementClass(n: number): string {
		if (n === 1) return 'border-accent bg-accent text-bg';
		if (n <= 3) return 'border-border-hi bg-surface text-muted';
		return 'border-border bg-surface text-muted';
	}

	function timeAgo(ts: number): string {
		const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
		const years = Math.floor(months / 12);
		return `${years} year${years === 1 ? '' : 's'} ago`;
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(window.location.href);
			toast('Link copied', 'success');
		} catch {
			toast('Could not copy link', 'error');
		}
	}
</script>

<svelte:head>
	<title>{data.profile.displayName} (@{data.profile.username}) — MultiFun</title>
</svelte:head>

<div class="flex flex-col gap-8 py-6">
	<PixelPanel accent="var(--color-accent)">
		<div class="flex flex-wrap items-start gap-6">
			<div class="pixel-border bg-surface-2 p-3">
				<Avatar
					config={data.profile.avatarJson}
					size={128}
					alt="{data.profile.displayName}'s avatar"
				/>
			</div>
			<div class="flex min-w-52 flex-1 flex-col gap-2">
				<h1 class="font-pixel text-xl text-text">{data.profile.displayName}</h1>
				<p class="font-body text-sm text-muted">@{data.profile.username}</p>
				{#if data.profile.bio}
					<p class="font-body text-sm text-text">{data.profile.bio}</p>
				{/if}
				<p class="font-pixel text-[9px] text-muted">Joined {joined}</p>
				<div class="mt-2 flex flex-wrap gap-3">
					{#if data.isSelf}
						<PixelButton size="sm" onclick={() => goto(resolve('/profile/edit'))}>
							Edit profile
						</PixelButton>
					{/if}
					<PixelButton variant="secondary" size="sm" onclick={copyLink}
						>Copy profile link</PixelButton
					>
				</div>
			</div>
			<div class="flex flex-col items-center gap-1 border-4 border-border bg-surface-2 px-5 py-3">
				<span class="font-pixel text-2xl text-accent">{data.stats.wins}</span>
				<span class="font-pixel text-[8px] text-muted">WINS</span>
				<span class="mt-2 font-pixel text-2xl text-text">{data.stats.matchesPlayed}</span>
				<span class="font-pixel text-[8px] text-muted">MATCHES</span>
			</div>
		</div>
	</PixelPanel>

	<section class="flex flex-col gap-4">
		<div class="flex items-end gap-4">
			<h2 class="font-pixel text-sm text-text">STATS BY GAME</h2>
			<div class="h-2 flex-1 bg-border"></div>
		</div>
		{#if Object.keys(data.stats.byGame).length === 0}
			<PixelPanel accent="var(--color-success)">
				<p class="font-pixel text-[10px] text-text">No matches yet — go play!</p>
				<p class="mt-2 font-body text-sm text-muted">
					Your stats will show up here after your first match.
				</p>
			</PixelPanel>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{#each Object.entries(data.stats.byGame) as [gameId, stat] (gameId)}
					<PixelPanel accent={gameAccent(gameId)}>
						<h3 class="font-pixel text-[10px]" style:color={gameAccent(gameId)}>
							{gameTitle(gameId)}
						</h3>
						<dl class="mt-3 flex flex-col gap-2">
							<div class="flex items-center justify-between gap-2">
								<dt class="font-pixel text-[8px] text-muted">PLAYED</dt>
								<dd class="font-pixel text-xs text-text">{stat.played}</dd>
							</div>
							<div class="flex items-center justify-between gap-2">
								<dt class="font-pixel text-[8px] text-muted">WINS</dt>
								<dd class="font-pixel text-xs text-success">{stat.wins}</dd>
							</div>
							<div class="flex items-center justify-between gap-2">
								<dt class="font-pixel text-[8px] text-muted">BEST</dt>
								<dd class="font-pixel text-xs text-accent">{stat.best}</dd>
							</div>
						</dl>
					</PixelPanel>
				{/each}
			</div>
		{/if}
	</section>

	<section class="flex flex-col gap-4">
		<div class="flex items-end gap-4">
			<h2 class="font-pixel text-sm text-text">RECENT MATCHES</h2>
			<div class="h-2 flex-1 bg-border"></div>
		</div>
		{#if data.stats.recent.length === 0}
			<PixelPanel accent="var(--color-info)">
				<p class="font-pixel text-[10px] text-text">No matches yet — go play!</p>
				<p class="mt-2 font-body text-sm text-muted">
					Hop into a lobby and your match history will appear here.
				</p>
			</PixelPanel>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each data.stats.recent as match (match.matchId)}
					<li
						class="pixel-border flex flex-wrap items-center gap-3 bg-surface px-4 py-3"
						style:animation="slide-up 200ms steps(3)"
					>
						<span
							class="min-w-14 border-2 px-2 py-1 text-center font-pixel text-[9px] {placementClass(
								match.placement
							)}"
						>
							{ordinal(match.placement)}
						</span>
						<span class="font-pixel text-[10px]" style:color={gameAccent(match.gameId)}>
							{gameTitle(match.gameId)}
						</span>
						<span class="border-2 border-border px-2 py-1 font-pixel text-[8px] text-text">
							{match.score} PTS
						</span>
						<span class="min-w-0 flex-1 truncate font-body text-sm text-muted">
							{match.opponentNames.length > 0 ? `vs ${match.opponentNames.join(', ')}` : 'solo run'}
						</span>
						<span class="font-body text-xs text-muted">{timeAgo(match.startedAt)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
