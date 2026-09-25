<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { PixelButton, PixelPanel, PixelInput, GameCard, toast } from '$lib/ui';
	import { GAME_META } from '$lib/game/meta';
	import type { GameId } from '$lib/game/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const GAME_ORDER: GameId[] = ['tank', 'geodash', 'echo', 'kart', 'brawl'];
	const games = GAME_ORDER.map((id) => GAME_META[id]);

	const STEPS = [
		{
			n: '1',
			title: 'Make a profile',
			text: 'Pick a name, build a pixel avatar and you are in. No downloads.'
		},
		{
			n: '2',
			title: 'Create or join a lobby',
			text: 'Open a lobby and share the code — or punch in a friend’s code to jump right in.'
		},
		{
			n: '3',
			title: 'Play together',
			text: 'One lobby, every game. Scores and wins land on your profile.'
		}
	];

	let code = $state('');

	function joinLobby() {
		const id = code.trim().toUpperCase();
		if (!id) {
			toast('Enter a lobby code first', 'error');
			return;
		}
		goto(resolve('/lobby/[code]', { code: id }));
	}
</script>

<svelte:head><title>MultiFun — pixel multiplayer</title></svelte:head>

<section class="flex flex-col items-start gap-5 py-12">
	<h1 class="font-pixel text-4xl leading-tight text-text sm:text-6xl">MULTIFUN</h1>
	<p class="font-pixel text-xs text-muted sm:text-sm">Pixel multiplayer. One lobby. Every game.</p>
	<div class="h-3 w-72 max-w-full bg-accent" style:animation="pixel-pop 300ms steps(3)"></div>
	<div class="mt-2 flex flex-wrap gap-3">
		<PixelButton size="lg" onclick={() => goto(resolve('/play/[gameId]', { gameId: 'echo' }))}>
			Play now
		</PixelButton>
		{#if !data.user}
			<PixelButton variant="secondary" size="lg" onclick={() => goto(resolve('/signup'))}>
				Create account
			</PixelButton>
		{/if}
	</div>
</section>

<section class="grid gap-6 py-6 md:grid-cols-2">
	<div class="pixel-border pixel-shadow bg-surface">
		<div class="border-b-4 border-border px-4 pt-3 pb-2">
			<h2 class="font-pixel text-xs text-text">QUICK JOIN</h2>
			<div class="mt-2 h-1 w-16 bg-accent"></div>
		</div>
		<div class="flex flex-col gap-3 p-4">
			<p class="font-body text-sm text-muted">
				Got a lobby code from a friend? Punch it in and jump straight to the action.
			</p>
			<div class="flex flex-wrap items-end gap-3">
				<div class="min-w-48 flex-1">
					<PixelInput
						label="Lobby code"
						placeholder="e.g. AB12CD"
						bind:value={code}
						oninput={() => (code = code.toUpperCase())}
					/>
				</div>
				<PixelButton onclick={joinLobby}>Join</PixelButton>
			</div>
		</div>
	</div>

	<div class="pixel-border pixel-shadow flex flex-col bg-surface">
		<div class="border-b-4 border-border px-4 pt-3 pb-2">
			<h2 class="font-pixel text-xs text-text">HOW IT WORKS</h2>
			<div class="mt-2 h-1 w-16 bg-info"></div>
		</div>
		<ol class="flex flex-1 flex-col gap-3 p-4">
			{#each STEPS as step (step.n)}
				<li class="flex items-start gap-3">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center border-4 border-border bg-surface-2 font-pixel text-xs text-accent"
					>
						{step.n}
					</span>
					<div>
						<h3 class="font-pixel text-[10px] text-text">{step.title}</h3>
						<p class="mt-1 font-body text-sm text-muted">{step.text}</p>
					</div>
				</li>
			{/each}
		</ol>
	</div>
</section>

<section class="flex flex-col gap-5 py-10">
	<div class="flex items-end justify-between gap-4">
		<h2 class="font-pixel text-lg text-text">GAMES</h2>
		<div class="h-2 flex-1 bg-border"></div>
	</div>
	<div class="grid gap-5 sm:grid-cols-2">
		{#each games as game (game.id)}
			<GameCard
				title={game.title}
				tagline={game.tagline}
				accent={game.accent}
				players={game.players}
				href={resolve('/play/[gameId]', { gameId: game.id })}
				disabled={game.status === 'coming'}
			/>
		{/each}
	</div>
</section>

<section class="flex flex-col items-start gap-4 py-10">
	<PixelPanel title="READY PLAYER ONE?" accent="var(--color-echo)">
		<div class="flex flex-wrap items-center gap-4">
			<p class="font-body text-sm text-muted">
				{data.user
					? 'Your lobby is waiting. Jump in and chase the high score.'
					: 'Create a free account, build your avatar and start playing with friends.'}
			</p>
			{#if data.user}
				<PixelButton onclick={() => goto(resolve('/play/[gameId]', { gameId: 'echo' }))}>
					Play now
				</PixelButton>
			{:else}
				<PixelButton onclick={() => goto(resolve('/signup'))}>Sign up free</PixelButton>
			{/if}
		</div>
	</PixelPanel>
</section>
