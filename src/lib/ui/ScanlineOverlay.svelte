<script lang="ts">
	let { opacity = 0.08 }: { opacity?: number } = $props();
</script>

<div
	class="scanlines pointer-events-none fixed inset-0 z-70"
	style:opacity
	aria-hidden="true"
></div>

<style>
	.scanlines {
		background-image: repeating-linear-gradient(
			to bottom,
			rgb(0 0 0 / 0.9) 0px,
			rgb(0 0 0 / 0.9) 1px,
			transparent 1px,
			transparent 3px
		);
	}

	@media (prefers-reduced-motion: reduce) {
		.scanlines {
			display: none;
		}
	}
</style>
