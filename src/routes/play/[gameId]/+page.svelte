<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { PixelButton, PixelInput, PixelPanel, PixelSelect, PixelToggle, toast } from '$lib/ui';
	import { realtime } from '$lib/stores/realtime';
	import type { GameId } from '$lib/game/types';
	import type { LobbyListItem } from '$lib/net/protocol';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const HOW_TO: Record<GameId, string> = {
		echo: 'Move your square, race for distance before time runs out.',
		tank: 'Drive with WASD/arrows, shoot with Space. 2 lives — last tank standing wins.',
		geodash: 'Jump and flip over the spikes — first to the portal takes the crown.',
		kart: 'Drift the corners, grab boosts and blast past your rivals.',
		brawl: 'Smash opponents off the stage — last pixel standing wins.'
	};

	const MAX_PLAYER_OPTIONS = ['2', '3', '4', '5', '6', '7', '8'].map((value) => ({
		value,
		label: value + ' players'
	}));

	/** Live list once the first refresh lands; falls back to the SSR snapshot. */
	let liveLobbies = $state.raw<LobbyListItem[] | null>(null);
	const lobbies = $derived(liveLobbies ?? data.initialLobbies);

	let lobbyName = $state('');
	let maxPlayers = $state('4');
	let isPublic = $state(true);
	let creating = $state(false);
	let joinCode = $state('');

	/**
	 * Keep the lobby list fresh while the player browses. Attached to the page
	 * root: it re-runs whenever `data.game.id` changes, restarting the poll.
	 */
	function pollLobbies() {
		const gameId = data.game.id;
		liveLobbies = null;
		realtime().connect(); // idempotent — no-op when already connected

		const refresh = () => {
			realtime()
				.request('lobby.list', { gameId })
				.then((ack) => {
					liveLobbies = (ack as { lobbies: LobbyListItem[] }).lobbies;
				})
				.catch(() => {
					/* offline — keep showing the last known list */
				});
		};
		refresh();
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	}

	function friendlyError(err: unknown): string {
		const code = err instanceof Error ? err.message : 'error';
		switch (code) {
			case 'game-unavailable':
				return 'That game is coming soon!';
			case 'not-connected':
			case 'connection closed':
				return 'Not connected to the arena yet — try again in a moment.';
			case 'request-timeout':
				return 'The server took too long — try again.';
			default:
				return 'Could not create the lobby — try again.';
		}
	}

	async function createLobby(event: SubmitEvent) {
		event.preventDefault();
		const name = lobbyName.trim();
		if (!name) {
			toast('Give your lobby a name first!', 'error');
			return;
		}
		creating = true;
		try {
			const ack = (await realtime().request('lobby.create', {
				name,
				gameId: data.game.id,
				maxPlayers: Number(maxPlayers),
				isPublic,
				settings: {}
			})) as { lobby: { code: string } };
			toast('Lobby opened — rally your squad!', 'success');
			await goto(resolve('/lobby/[code]', { code: ack.lobby.code }));
		} catch (err) {
			toast(friendlyError(err), 'error');
		} finally {
			creating = false;
		}
	}

	function joinByCode(event: SubmitEvent) {
		event.preventDefault();
		const code = joinCode.trim().toUpperCase();
		if (code.length < 4) {
			toast('Lobby codes are at least 4 characters.', 'error');
			return;
		}
		void goto(resolve('/lobby/[code]', { code }));
	}
</script>

<div {@attach pollLobbies} class="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
	<!-- game header -->
	<PixelPanel title={data.game.title} accent={data.game.accent}>
		<div class="flex flex-col gap-3">
			<p class="font-body text-sm text-muted">{data.game.tagline}</p>
			<div class="flex flex-wrap items-center gap-2">
				<span class="border-2 border-border px-2 py-1 font-pixel text-[8px] text-muted">
					{data.game.players}
				</span>
				<span
					class="border-2 px-2 py-1 font-pixel text-[8px]"
					style:border-color={data.game.accent}
					style:color={data.game.accent}
				>
					{data.game.status === 'playable' ? 'PLAYABLE' : 'COMING SOON'}
				</span>
			</div>
			<div class="border-4 border-border bg-surface-2 px-3 py-2">
				<h3 class="font-pixel text-[9px] text-accent">HOW TO PLAY</h3>
				<p class="mt-2 font-body text-sm text-text">{HOW_TO[data.game.id]}</p>
			</div>
		</div>
	</PixelPanel>

	<!-- join by code -->
	<PixelPanel title="Join by code" padded={false}>
		<form class="flex flex-wrap items-end gap-3 p-4" onsubmit={joinByCode}>
			<div class="min-w-40 flex-1">
				<PixelInput label="Lobby code" placeholder="ABCD12" bind:value={joinCode} />
			</div>
			<PixelButton type="submit" variant="secondary">Join</PixelButton>
		</form>
	</PixelPanel>

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
		<!-- lobby browser -->
		<PixelPanel title="Open lobbies" accent={data.game.accent}>
			{#if lobbies.length === 0}
				<div class="flex flex-col items-center gap-3 py-10">
					<span class="font-pixel text-[10px] text-muted">No open lobbies — create one!</span>
					<PixelButton
						onclick={() =>
							document.querySelector<HTMLInputElement>('input[name="lobby-name"]')?.focus()}
					>
						Create lobby
					</PixelButton>
				</div>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each lobbies as row (row.id)}
						<li
							class="pixel-border btn-press flex flex-wrap items-center gap-3 bg-surface-2 px-3 py-2 transition-transform hover:-translate-y-0.5"
						>
							<div class="min-w-32 flex-1">
								<p class="font-pixel text-[10px] text-text">{row.name}</p>
								<p class="mt-1 font-body text-xs text-muted">Host: {row.hostName}</p>
							</div>
							<span class="font-pixel text-[8px] text-muted">
								{row.playerCount}/{row.maxPlayers} players
							</span>
							<span
								class="border-2 px-2 py-1 font-pixel text-[8px]"
								class:border-success={row.status === 'open'}
								class:text-success={row.status === 'open'}
								class:border-accent={row.status === 'playing'}
								class:text-accent={row.status === 'playing'}
								class:border-border={row.status === 'closed'}
								class:text-muted={row.status === 'closed'}
							>
								{row.status === 'open' ? 'OPEN' : row.status === 'playing' ? 'IN GAME' : 'CLOSED'}
							</span>
							<PixelButton
								size="sm"
								onclick={() => goto(resolve('/lobby/[code]', { code: row.code }))}
							>
								Join
							</PixelButton>
						</li>
					{/each}
				</ul>
			{/if}
		</PixelPanel>

		<!-- create lobby -->
		<PixelPanel title="Create lobby" accent={data.game.accent}>
			<form class="flex flex-col gap-4" onsubmit={createLobby}>
				<PixelInput
					label="Lobby name"
					name="lobby-name"
					placeholder="My epic lobby"
					bind:value={lobbyName}
				/>
				<PixelSelect label="Max players" options={MAX_PLAYER_OPTIONS} bind:value={maxPlayers} />
				<PixelToggle label="Public lobby" bind:checked={isPublic} />
				<PixelButton type="submit" size="lg" disabled={creating}>
					{creating ? 'Creating...' : 'Create'}
				</PixelButton>
				<p class="font-body text-xs text-muted">
					Public lobbies show up in the list for everyone to join.
				</p>
			</form>
		</PixelPanel>
	</div>
</div>
