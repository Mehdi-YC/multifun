<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GameShell from '$lib/game/GameShell.svelte';
	import {
		Avatar,
		PixelButton,
		PixelInput,
		PixelModal,
		PixelPanel,
		PixelSelect,
		PixelToggle,
		PlayerChip,
		toast
	} from '$lib/ui';
	import {
		activeMatch,
		chat,
		connection,
		getLobbyId,
		leaveCurrentLobby,
		lobby,
		matchResults,
		realtime,
		selfMember
	} from '$lib/stores/realtime';
	import { GAME_META, isGameId } from '$lib/game/meta';
	import { LEVELS } from '$lib/game/geodash/levels';
	import { ARENAS } from '$lib/game/tank/arena';
	import type { AvatarConfig } from '$lib/game/assets/avatar';
	import type { GameId } from '$lib/game/types';
	import type { MemberSnapshot } from '$lib/net/protocol';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const FALLBACK_AVATAR: AvatarConfig = {
		version: 1,
		seed: 0,
		skin: '#c8d2e8',
		hair: '#5a5a96',
		eyes: '#1a1c2c',
		outfit: '#262647',
		bg: '#1c1c33',
		style: 'square',
		hairStyle: 'bald'
	};

	const MAX_PLAYER_OPTIONS = ['2', '3', '4', '5', '6', '7', '8'].map((value) => ({
		value,
		label: value + ' players'
	}));

	// only games with a real sim can be picked for a lobby
	const PLAYABLE_GAME_IDS: GameId[] = ['echo', 'tank', 'geodash'];
	const GAME_OPTIONS = PLAYABLE_GAME_IDS.map((id) => ({ value: id, label: GAME_META[id].title }));

	// ---- game-content options (which level / arena the match is played on) ----

	function asRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	}

	function prettifyId(id: string): string {
		return id
			.split(/[-_]/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function difficultyPips(difficulty: unknown): string {
		const n = Math.round(Number(difficulty));
		const filled = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
		return `[${'#'.repeat(filled)}${'.'.repeat(5 - filled)}]`;
	}

	function settingString(
		settings: Record<string, unknown> | null | undefined,
		key: string
	): string {
		const value = settings?.[key];
		return typeof value === 'string' && value ? value : '';
	}

	function pickOption(
		value: string,
		fallback: string,
		options: ReadonlyArray<{ value: string }>
	): string {
		if (options.some((option) => option.value === value)) return value;
		if (options.some((option) => option.value === fallback)) return fallback;
		return options[0]?.value ?? fallback;
	}

	const levelOptions = $derived(
		LEVELS.map((level, index) => {
			const entry = asRecord(level);
			const id = String(entry.id || `level-${index + 1}`);
			const name = String(entry.name || prettifyId(id));
			return {
				value: id,
				label: `Level ${index + 1}: ${name} — ${difficultyPips(entry.difficulty)}`
			};
		})
	);

	const arenaOptions = $derived(
		ARENAS.map((arena, index) => {
			const entry = asRecord(arena);
			const id = String(entry.id || `arena-${index + 1}`);
			return { value: id, label: String(entry.name || prettifyId(id)) };
		})
	);

	let joinError = $state<string | null>(null);
	let draft = $state('');
	let busy = $state(false);
	let settingsOpen = $state(false);
	let settingsName = $state('');
	let settingsGame = $state('echo');
	let settingsMax = $state('4');
	let settingsPublic = $state(true);
	let settingsLevel = $state('level-1');
	let settingsArena = $state('crossfire');
	let deleteOpen = $state(false);

	const room = $derived($lobby ?? data.lobby);
	const gameMeta = $derived(GAME_META[room?.gameId ?? 'echo']);
	const isHost = $derived(!!room && room.hostUserId === data.selfUserId);
	const me = $derived(room ? selfMember(data.selfUserId, room) : null);
	const code = $derived(room?.code ?? '');
	const allReady = $derived(
		(room?.members ?? []).length > 0 && (room?.members ?? []).every((m) => m.isReady)
	);
	const slots = $derived.by(() => {
		const list: Array<MemberSnapshot | null> = Array.from({ length: 8 }, () => null);
		for (const member of room?.members ?? []) {
			if (member.slot >= 0 && member.slot < 8) list[member.slot] = member;
		}
		return list;
	});
	const ranked = $derived(
		[...($matchResults?.results ?? [])].sort((a, b) => a.placement - b.placement)
	);
	// Read-only label for the settings summary line: which level / arena this
	// lobby is set to play (resolved through LEVELS / ARENAS for its name).
	const matchContentLabel = $derived.by(() => {
		if (!room) return '';
		if (room.gameId === 'geodash') {
			const id = settingString(room.settings, 'levelId') || 'level-1';
			const level = LEVELS.map(asRecord).find((entry) => String(entry.id ?? '') === id);
			return String(level?.name || prettifyId(id));
		}
		if (room.gameId === 'tank') {
			const id = settingString(room.settings, 'arenaId') || 'crossfire';
			const arena = ARENAS.map(asRecord).find((entry) => String(entry.id ?? '') === id);
			return String(arena?.name || prettifyId(id));
		}
		return '';
	});

	// Membership can be revoked at any time (kick / lobby deleted / lobby
	// closed): the store drops the lobby (or just this member) when that
	// happens, and the stale SSR snapshot must not resurrect the room.
	let removed = false;

	function handleRemoval(): void {
		if (removed) return;
		removed = true;
		toast('You were removed from the lobby.', 'error');
		void goto(resolve('/play/[gameId]', { gameId: gameMeta.id }));
	}

	onMount(() => {
		// Seed chat from server history exactly once; the store appends live lines afterwards.
		const names = new Map((data.lobby?.members ?? []).map((m) => [m.userId, m.displayName]));
		chat.set(
			data.messages.map((m) => ({
				from: m.userId,
				fromName: names.get(m.userId) ?? '—',
				text: m.text,
				ts: m.sentAt
			}))
		);

		realtime().connect(); // idempotent — no-op when already connected
		const target = data.lobby;
		if (target && getLobbyId() !== target.id) {
			realtime()
				.request('lobby.join', { code: target.code })
				.catch((err: unknown) => {
					const errCode = err instanceof Error ? err.message : 'error';
					joinError =
						errCode === 'lobby-full'
							? 'That lobby is full — try another one.'
							: errCode === 'match-in-progress'
								? 'A match is already running here — wait for it to end.'
								: 'Could not join this lobby — it may have closed.';
				});
		}

		// Watch for the membership being revoked (kicked / lobby deleted /
		// closed). The SSR snapshot still has the room, so only a live snapshot
		// that drops it — or drops us from it — is proof. First load is safe:
		// nothing counts as "seen" until this lobby appears in the store.
		let sawLobby = false;
		return lobby.subscribe((snap) => {
			if (removed) return;
			if (snap && target && snap.id === target.id) {
				sawLobby = true;
				if (!snap.members.some((m) => m.userId === data.selfUserId)) handleRemoval();
			} else if (!snap && sawLobby) {
				handleRemoval();
			}
		});
	});

	// keep chat pinned to the newest lines (store subscription, cleaned up on detach)
	function autoScroll(el: HTMLElement) {
		return chat.subscribe(() => {
			el.scrollTop = el.scrollHeight;
		});
	}

	function timeLabel(ts: number): string {
		const d = new Date(ts);
		const hh = d.getHours().toString().padStart(2, '0');
		const mm = d.getMinutes().toString().padStart(2, '0');
		return `${hh}:${mm}`;
	}

	function avatarOf(userId: string): AvatarConfig {
		return room?.members.find((m) => m.userId === userId)?.avatarJson ?? FALLBACK_AVATAR;
	}

	function nameOf(userId: string): string {
		return (
			room?.members.find((m) => m.userId === userId)?.displayName ??
			$activeMatch?.players.find((p) => p.id === userId)?.name ??
			'Player'
		);
	}

	function medalColor(placement: number): string | undefined {
		if (placement === 1) return '#ffd166';
		if (placement === 2) return '#c0c0d0';
		if (placement === 3) return '#c98d61';
		return undefined;
	}

	function requestToast(err: unknown, fallback: string): void {
		const errCode = err instanceof Error ? err.message : 'error';
		if (errCode === 'not-everyone-ready') toast('Everyone must be ready first!', 'error');
		else if (errCode === 'not-connected' || errCode === 'connection closed')
			toast('Connection lost — hang tight.', 'error');
		else if (errCode === 'game-unavailable') toast('That game is not available yet', 'error');
		else if (errCode === 'too-many-players')
			toast('Too many players for that game — remove some first', 'error');
		else if (errCode === 'too-few-players') toast('This lobby is too small for that game', 'error');
		else toast(fallback, 'error');
	}

	function sendChat(event: SubmitEvent) {
		event.preventDefault();
		const text = draft.trim().slice(0, 300);
		if (!text || !room) return;
		realtime().sendChat(room.id, text);
		draft = '';
	}

	async function toggleReady() {
		if (!room || busy) return;
		busy = true;
		try {
			await realtime().request('lobby.ready', {
				lobbyId: room.id,
				ready: !(me?.isReady ?? false)
			});
		} catch (err) {
			requestToast(err, 'Could not update ready state.');
		} finally {
			busy = false;
		}
	}

	async function startMatch() {
		if (!room || busy) return;
		busy = true;
		try {
			await realtime().request('lobby.start', { lobbyId: room.id });
		} catch (err) {
			requestToast(err, 'Could not start the match.');
		} finally {
			busy = false;
		}
	}

	async function deleteLobby(event: SubmitEvent) {
		event.preventDefault();
		if (!room || busy) return;
		busy = true;
		// Deliberate teardown — the closing broadcast must not look like a kick.
		removed = true;
		try {
			await realtime().request('lobby.delete', { lobbyId: room.id });
			deleteOpen = false;
			toast('Lobby deleted.', 'success');
			void goto(resolve('/play/[gameId]', { gameId: gameMeta.id }));
		} catch (err) {
			removed = false;
			requestToast(err, 'Could not delete the lobby.');
		} finally {
			busy = false;
		}
	}

	async function kick(userId: string) {
		if (!room) return;
		try {
			await realtime().request('lobby.kick', { lobbyId: room.id, userId });
		} catch (err) {
			requestToast(err, 'Could not remove that player.');
		}
	}

	function openSettings() {
		if (!room) return;
		settingsName = room.name;
		settingsGame = room.gameId;
		settingsMax = String(room.maxPlayers);
		// visibility is not part of the snapshot, so the host re-picks it here
		settingsPublic = true;
		// prefill the game-content selection from the room's saved settings
		settingsLevel = pickOption(settingString(room.settings, 'levelId'), 'level-1', levelOptions);
		settingsArena = pickOption(settingString(room.settings, 'arenaId'), 'crossfire', arenaOptions);
		settingsOpen = true;
	}

	async function saveSettings(event: SubmitEvent) {
		event.preventDefault();
		if (!room) return;
		// the select only offers playable game ids, so this always narrows
		const gameId: GameId = isGameId(settingsGame) ? settingsGame : room.gameId;
		// preserve any other stored keys and persist the game-content selection
		const settings: Record<string, unknown> = { ...room.settings };
		if (gameId === 'geodash') settings.levelId = settingsLevel;
		else if (gameId === 'tank') settings.arenaId = settingsArena;
		try {
			await realtime().request('lobby.settings', {
				lobbyId: room.id,
				name: settingsName.trim() || room.name,
				gameId,
				maxPlayers: Number(settingsMax),
				isPublic: settingsPublic,
				settings
			});
			settingsOpen = false;
			toast('Lobby settings saved.', 'success');
		} catch (err) {
			requestToast(err, 'Could not save settings.');
		}
	}

	async function copyInvite() {
		const link = `${location.origin}/lobby/${code}`;
		try {
			await navigator.clipboard.writeText(link);
			toast('Invite link copied — send it to your squad!', 'success');
		} catch {
			toast('Could not copy — grab the link from the address bar.', 'error');
		}
	}

	function leaveLobby() {
		removed = true; // leaving on purpose — don't treat the store reset as a kick
		leaveCurrentLobby();
		void goto(resolve('/play/[gameId]', { gameId: gameMeta.id }));
	}
</script>

<svelte:head>
	<title>{room ? `${room.name} — MultiFun` : 'Lobby — MultiFun'}</title>
</svelte:head>

<!-- connection banner -->
{#if $connection !== 'open'}
	<div
		class="border-b-4 px-4 py-2 text-center font-pixel text-[9px] {$connection === 'closed'
			? 'border-danger bg-danger/15 text-danger'
			: 'border-accent bg-accent/10 text-accent'}"
	>
		{$connection === 'closed' ? 'Connection lost — reconnecting...' : 'Reconnecting...'}
	</div>
{/if}

{#if !room}
	<div class="mx-auto w-full max-w-md p-8">
		<PixelPanel title="Lobby not found">
			<p class="font-body text-sm text-muted">This lobby has closed or never existed.</p>
			<div class="mt-4">
				<a href={resolve('/play/echo')} class="font-pixel text-[10px] text-accent underline">
					Back to games
				</a>
			</div>
		</PixelPanel>
	</div>
{:else if joinError}
	<div class="mx-auto w-full max-w-md p-8">
		<PixelPanel title="Cannot join">
			<p class="font-body text-sm text-text">{joinError}</p>
			<div class="mt-4">
				<a
					href={resolve('/play/[gameId]', { gameId: room.gameId })}
					class="font-pixel text-[10px] text-accent underline"
				>
					Back to games
				</a>
			</div>
		</PixelPanel>
	</div>
{:else if $activeMatch}
	<!-- live match: full-width game shell with a slim top bar -->
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4">
		<div class="pixel-border flex flex-wrap items-center gap-3 bg-surface px-4 py-2">
			<div class="h-3 w-3" style:background-color={gameMeta.accent}></div>
			<span class="font-pixel text-[10px] text-text">{room.name}</span>
			<span class="font-pixel text-[8px] text-muted">
				PLAYERS ALIVE: {$activeMatch.players.length}
			</span>
			<span class="ml-auto font-pixel text-[8px]" style:color={gameMeta.accent}
				>{gameMeta.title}</span
			>
		</div>
		{#key $activeMatch.matchId}
			<GameShell match={$activeMatch} selfId={data.selfUserId} />
		{/key}
	</div>
{:else}
	<div
		class="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]"
	>
		<!-- room stage -->
		<div class="flex min-w-0 flex-col gap-4">
			<PixelPanel title={room.name} accent={gameMeta.accent} padded={false}>
				<div class="h-2 w-full" style:background-color={gameMeta.accent}></div>
				<div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
					<h2 class="font-pixel text-sm text-text">{gameMeta.title}</h2>
					<span class="font-pixel text-[8px] text-muted">{gameMeta.tagline}</span>
				</div>
			</PixelPanel>

			<!-- player slots -->
			<PixelPanel title="Players">
				<div class="grid grid-cols-2 gap-2 md:grid-cols-4">
					{#each slots as slot, index (slot?.userId ?? 'empty-' + index)}
						{#if slot}
							<div class="relative" style:animation="pixel-pop 220ms steps(3)">
								<PlayerChip member={slot} size={36} />
								{#if isHost && slot.userId !== data.selfUserId}
									<button
										type="button"
										class="btn-press absolute -top-2 -right-2 h-6 w-6 cursor-pointer border-2 border-danger bg-danger font-pixel text-[8px] text-bg"
										aria-label="Remove {slot.displayName} from the lobby"
										onclick={() => kick(slot.userId)}
									>
										x
									</button>
								{/if}
							</div>
						{:else}
							<div
								class="flex min-h-16 items-center justify-center border-4 border-dashed border-border px-2 py-3"
							>
								<span class="font-pixel text-[8px] text-muted">Waiting...</span>
							</div>
						{/if}
					{/each}
				</div>
			</PixelPanel>

			<!-- invite + settings summary -->
			<PixelPanel title="Invite">
				<div class="flex flex-wrap items-center gap-3">
					<span
						class="border-4 border-border bg-surface-2 px-4 py-2 font-pixel text-lg text-accent"
					>
						{code}
					</span>
					<PixelButton variant="secondary" onclick={copyInvite}>Copy invite link</PixelButton>
					<span class="font-body text-xs text-muted">
						{gameMeta.players} · {gameMeta.title}{matchContentLabel
							? ` · ${matchContentLabel}`
							: ''}
					</span>
				</div>
			</PixelPanel>

			<!-- controls bar -->
			<div class="pixel-border flex flex-wrap items-center gap-3 bg-surface p-4">
				<PixelButton
					variant={me?.isReady ? 'ghost' : 'primary'}
					disabled={busy}
					onclick={toggleReady}
				>
					{me?.isReady ? 'Not ready' : 'Ready up'}
				</PixelButton>

				{#if isHost}
					<PixelButton size="lg" disabled={!allReady || busy} onclick={startMatch}>
						START GAME
					</PixelButton>
					<PixelButton variant="secondary" onclick={openSettings}>Settings</PixelButton>
					<PixelButton variant="danger" disabled={busy} onclick={() => (deleteOpen = true)}>
						Delete lobby
					</PixelButton>
					{#if !allReady}
						<span
							class="font-pixel text-[8px] text-muted"
							style:animation="blink 1s steps(2) infinite"
						>
							WAITING FOR PLAYERS...
						</span>
					{/if}
				{/if}

				<PixelButton variant="danger" onclick={leaveLobby}>Leave lobby</PixelButton>
			</div>
		</div>

		<!-- chat sidebar -->
		<div class="flex min-h-0 flex-col">
			<PixelPanel title="Chat" padded={false}>
				<div
					{@attach autoScroll}
					class="flex h-80 flex-col gap-2 overflow-y-auto p-3"
					aria-live="polite"
				>
					{#if $chat.length === 0}
						<p class="font-pixel text-[8px] text-muted">Chat is quiet — say hi!</p>
					{:else}
						{#each $chat as line (line.ts + '-' + line.from + '-' + line.text)}
							<div class="flex items-start gap-2">
								<Avatar config={avatarOf(line.from)} size={16} alt="" class="mt-0.5" />
								<div class="min-w-0 flex-1">
									<p class="flex flex-wrap items-baseline gap-2">
										<span
											class="font-pixel text-[8px]"
											class:text-accent={line.from === data.selfUserId}
											class:text-info={line.from !== data.selfUserId}
										>
											{line.fromName}
										</span>
										<span class="font-body text-[10px] text-muted">{timeLabel(line.ts)}</span>
									</p>
									<p class="font-body text-sm break-words text-text">{line.text}</p>
								</div>
							</div>
						{/each}
					{/if}
				</div>
				<form class="flex items-end gap-2 border-t-4 border-border p-3" onsubmit={sendChat}>
					<div class="min-w-0 flex-1">
						<PixelInput
							name="chat"
							placeholder={$connection === 'open' ? 'Say something...' : 'Reconnecting...'}
							disabled={$connection !== 'open'}
							bind:value={draft}
						/>
					</div>
					<PixelButton type="submit" disabled={$connection !== 'open' || !draft.trim()}>
						Send
					</PixelButton>
				</form>
			</PixelPanel>
		</div>
	</div>
{/if}

<!-- host settings modal -->
<PixelModal title="Lobby settings" bind:open={settingsOpen}>
	<form class="flex flex-col gap-4" onsubmit={saveSettings}>
		<PixelInput label="Lobby name" bind:value={settingsName} />
		<PixelSelect label="Game" options={GAME_OPTIONS} bind:value={settingsGame} />
		{#if settingsGame === 'geodash'}
			<PixelSelect label="Level" options={levelOptions} bind:value={settingsLevel} />
		{:else if settingsGame === 'tank'}
			<PixelSelect label="Arena" options={arenaOptions} bind:value={settingsArena} />
		{/if}
		<PixelSelect label="Max players" options={MAX_PLAYER_OPTIONS} bind:value={settingsMax} />
		<PixelToggle label="Public lobby" bind:checked={settingsPublic} />
		<div class="flex justify-end gap-2">
			<PixelButton variant="ghost" onclick={() => (settingsOpen = false)}>Cancel</PixelButton>
			<PixelButton type="submit">Save</PixelButton>
		</div>
	</form>
</PixelModal>

<!-- delete lobby confirm modal -->
<PixelModal title="Delete this lobby?" bind:open={deleteOpen}>
	<form class="flex flex-col gap-4" onsubmit={deleteLobby}>
		<p class="font-body text-sm text-muted">
			Everyone will be removed and the lobby closes for good.
		</p>
		<div class="flex justify-end gap-2">
			<PixelButton variant="ghost" onclick={() => (deleteOpen = false)}>Cancel</PixelButton>
			<PixelButton variant="danger" type="submit" disabled={busy}>Delete</PixelButton>
		</div>
	</form>
</PixelModal>

<!-- pixel results screen -->
{#if $matchResults}
	<div class="fixed inset-0 z-60 flex items-center justify-center bg-black/80 p-4">
		<div class="w-full max-w-lg" style:animation="slide-up 200ms steps(3)">
			<PixelPanel accent="#ffd166">
				<h2
					class="mb-4 text-center font-pixel text-2xl text-accent"
					style:animation="pixel-pop 300ms steps(3)"
				>
					RESULTS
				</h2>
				<ol class="flex flex-col gap-2">
					{#each ranked as result (result.player)}
						<li
							class="pixel-border flex items-center gap-3 bg-surface-2 px-3 py-2"
							style:animation="slide-up 200ms steps(3)"
						>
							<span
								class="w-8 text-center font-pixel text-sm"
								style:color={medalColor(result.placement) ?? 'var(--color-muted)'}
							>
								{result.placement}
							</span>
							<Avatar config={avatarOf(result.player)} size={32} alt="" />
							<span class="min-w-0 flex-1 truncate font-pixel text-[10px] text-text">
								{nameOf(result.player)}
							</span>
							<span class="font-pixel text-xs text-accent">{result.score}</span>
						</li>
					{/each}
				</ol>
				<div class="mt-6 flex flex-wrap justify-center gap-3">
					<PixelButton variant="ghost" onclick={() => matchResults.set(null)}>
						Back to lobby
					</PixelButton>
					{#if isHost}
						<PixelButton size="lg" disabled={busy} onclick={startMatch}>Play again</PixelButton>
					{/if}
				</div>
			</PixelPanel>
		</div>
	</div>
{/if}
