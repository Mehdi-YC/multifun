<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		accent?: string;
		padded?: boolean;
		footer?: Snippet;
		children: Snippet;
	}

	let {
		title,
		accent = 'var(--color-accent, #ffd166)',
		padded = true,
		footer,
		children
	}: Props = $props();
</script>

<section class="pixel-border bg-surface">
	{#if title}
		<header class="border-b-4 border-border px-4 pt-3 pb-2">
			<h2 class="font-pixel text-xs text-text">{title}</h2>
			<div class="mt-2 h-1 w-16" style:background-color={accent}></div>
		</header>
	{/if}
	<div class={padded ? 'p-4' : ''}>
		{@render children()}
	</div>
	{#if footer}
		<footer class="border-t-4 border-border px-4 py-3">
			{@render footer()}
		</footer>
	{/if}
</section>
