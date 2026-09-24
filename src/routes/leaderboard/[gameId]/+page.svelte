<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Avatar, PixelButton, PixelPanel, Tabs } from '$lib/ui';
	import { GAME_META } from '$lib/game/meta';
	import { GAME_IDS, type GameId } from '$lib/game/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const tabs = GAME_IDS.map((id) => ({ id, label: GAME_META[id].title }));

	// The tab strip is driven by the route: the getter reads the current game,
	// the setter navigates (mouse click and keyboard selection both land here).
	function selectTab(id: string) {
		if (id !== data.game.id) {
			void goto(resolve('/leaderboard/[gameId]', { gameId: id as GameId }));
		}
	}

	function medalColor(rank: number): string | undefined {
		if (rank === 1) return '#ffd166';
		if (rank === 2) return '#c0c0d0';
		if (rank === 3) return '#c98d61';
		return undefined;
	}

	// NOTE: leaderboard entries only carry `username` while `selfUserId` is a user id,
	// so there is no reliable self-row highlight here. Revisit once entries expose userId.
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
	<Tabs {tabs} bind:active={() => data.game.id, selectTab} />

	<PixelPanel title="Top players" accent={GAME_META[data.game.id].accent}>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 class="font-pixel text-xs text-text">{data.game.title} — Best score</h2>
			<span class="border-2 border-border px-2 py-1 font-pixel text-[8px] text-muted">
				{data.game.players}
			</span>
		</div>

		{#if data.entries.length === 0}
			<div class="flex flex-col items-center gap-4 py-10">
				<p class="font-pixel text-[10px] text-muted">No scores yet — be the first!</p>
				<!-- echo is the only playable module today, so "Play now" heads there -->
				<PixelButton onclick={() => goto(resolve('/play/[gameId]', { gameId: 'echo' }))}>
					Play now
				</PixelButton>
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-3 border-b-4 border-border px-2 pb-2">
					<span class="w-10 text-center font-pixel text-[8px] text-muted">RANK</span>
					<span class="flex-1 font-pixel text-[8px] text-muted">PLAYER</span>
					<span class="font-pixel text-[8px] text-muted">BEST SCORE</span>
				</div>
				{#each data.entries as entry (entry.rank)}
					<div
						class="pixel-border btn-press flex items-center gap-3 bg-surface-2 px-2 py-2 transition-transform hover:-translate-y-0.5"
					>
						<span
							class="w-10 text-center font-pixel text-sm"
							style:color={medalColor(entry.rank) ?? 'var(--color-muted)'}
						>
							{entry.rank}
						</span>
						<Avatar config={entry.avatarJson} size={32} alt="{entry.displayName}'s avatar" />
						<div class="min-w-0 flex-1">
							<p class="truncate font-pixel text-[10px] text-text">{entry.displayName}</p>
							<a
								href={resolve('/profile/[username]', { username: entry.username })}
								class="font-body text-xs text-info underline hover:text-accent"
							>
								@{entry.username}
							</a>
						</div>
						<span class="font-pixel text-sm text-accent">{entry.value}</span>
					</div>
				{/each}
			</div>
		{/if}
	</PixelPanel>
</div>
