<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { PixelButton, PixelPanel } from '$lib/ui';
	import { leaveCurrentLobby, realtime, type MatchInfo } from '$lib/stores/realtime';
	import { getGameModule } from '$lib/game/modules';
	import type { GameClient, GameContext, InputFrame } from '$lib/game/types';

	interface Props {
		match: MatchInfo;
		selfId: string;
	}

	let { match, selfId }: Props = $props();

	let paused = $state(false);
	let now = $state(Date.now());

	const msToStart = $derived(match.startAt - now);
	const countdownText = $derived(
		msToStart > 0 ? String(Math.min(3, Math.max(1, Math.ceil(msToStart / 1000)))) : 'GO!'
	);
	const showCountdown = $derived(msToStart > -800);
	const countdownFading = $derived(msToStart <= 0);

	/**
	 * Mount the game client onto the canvas. Runs client-only (like $effect),
	 * and the returned teardown stops the engine + all subscriptions.
	 */
	function mountGame(el: HTMLCanvasElement) {
		let tick = 0;
		let seq = 0;

		const ctx: GameContext = {
			canvas: el,
			selfId,
			players: match.players,
			seed: match.seed,
			config: match.config,
			sendInput: (frame: InputFrame) => {
				realtime().sendInput(match.matchId, tick++, seq++, frame.keys);
			},
			onEnd: () => {}
		};

		const client: GameClient | undefined = getGameModule(match.gameId)?.createClient(ctx);

		const unsubscribers: Array<() => void> = [];
		if (client) {
			unsubscribers.push(
				realtime().on('game.snap', (msg) => {
					if (msg.d.matchId === match.matchId) client.onSnapshot?.(msg.d.state);
				}),
				realtime().on('game.event', (msg) => {
					if (msg.d.matchId === match.matchId) client.onEvent?.(msg.d.ev);
				})
			);
			client.start();
		}

		// the engine's stub client exposes resize(); real modules may too
		const fit = () =>
			(client as { resize?: (w: number, h: number) => void }).resize?.(
				el.clientWidth,
				el.clientHeight
			);
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);

		const timer = setInterval(() => {
			now = Date.now();
		}, 100);

		return () => {
			clearInterval(timer);
			observer.disconnect();
			for (const unsubscribe of unsubscribers) unsubscribe();
			client?.stop();
		};
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			paused = !paused;
		}
	}

	function leaveMatch() {
		leaveCurrentLobby();
		void goto(resolve('/play/[gameId]', { gameId: match.gameId }));
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="flex w-full flex-col gap-2">
	<!-- tabindex lets the engine's keyboard input grab focus right away -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		role="application"
		aria-label="Game view"
		tabindex="0"
		class="pixel-border pixel-shadow relative aspect-video w-full overflow-hidden bg-black"
	>
		<canvas {@attach mountGame} class="pixelated absolute inset-0 h-full w-full"></canvas>

		{#if showCountdown}
			<div
				class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/60"
				class:opacity-0={countdownFading}
				class:transition-opacity={countdownFading}
			>
				<span
					class="font-pixel text-5xl text-accent sm:text-7xl"
					style:animation="pixel-pop 200ms steps(3)">{countdownText}</span
				>
			</div>
		{/if}

		{#if paused}
			<div class="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4">
				<div class="w-full max-w-xs">
					<PixelPanel title="Paused">
						<div class="flex flex-col gap-3">
							<PixelButton onclick={() => (paused = false)}>Resume</PixelButton>
							<PixelButton variant="danger" onclick={leaveMatch}>Leave match</PixelButton>
						</div>
					</PixelPanel>
				</div>
			</div>
		{/if}
	</div>

	<div
		class="border-4 border-border bg-surface-2 px-3 py-2 text-center font-pixel text-[8px] text-muted sm:text-[9px]"
	>
		Move: WASD/Arrows · Jump: Space · Special: C · Esc: pause
	</div>
</section>
