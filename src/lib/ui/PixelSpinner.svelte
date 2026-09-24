<script lang="ts">
	let { size = 24, label = 'Loading' }: { size?: number; label?: string } = $props();
</script>

<div
	class="pixel-spinner"
	role="status"
	aria-label={label}
	style:width="{size}px"
	style:height="{size}px"
></div>

<style>
	.pixel-spinner {
		background-color: var(--color-accent, #ffd166);
		box-shadow: inset -4px -4px 0 0 rgb(0 0 0 / 0.3);
		animation: pixel-spin 800ms steps(4) infinite;
	}

	@keyframes pixel-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pixel-spinner {
			animation: none;
		}
	}
</style>
