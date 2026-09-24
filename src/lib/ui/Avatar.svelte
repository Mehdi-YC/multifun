<script lang="ts">
	import { AVATAR_SIZE, drawAvatar, type AvatarConfig } from '$lib/game/assets/avatar';

	interface Props {
		config: AvatarConfig;
		size?: number;
		class?: string;
		alt?: string;
	}

	let { config, size = 64, class: className = '', alt = 'Player avatar' }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	function attachCanvas(el: HTMLCanvasElement) {
		canvas = el;
		return () => {
			canvas = undefined;
		};
	}

	// repaint whenever the config changes
	$effect(() => {
		const ctx = canvas?.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
		drawAvatar(ctx, config, 0, 0, 1);
	});
</script>

<span
	role="img"
	aria-label={alt}
	class="inline-block {className}"
	style:width="{size}px"
	style:height="{size}px"
>
	<canvas
		{@attach attachCanvas}
		width={AVATAR_SIZE}
		height={AVATAR_SIZE}
		aria-hidden="true"
		class="pixelated block h-full w-full"
	></canvas>
</span>
