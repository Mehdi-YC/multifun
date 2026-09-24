<script lang="ts">
	import { toasts } from './toast';

	const kindClasses: Record<string, string> = {
		info: 'border-l-info text-info',
		success: 'border-l-success text-success',
		error: 'border-l-danger text-danger'
	};
</script>

<div
	class="pointer-events-none fixed right-4 bottom-4 z-60 flex flex-col items-end gap-2"
	aria-live="polite"
>
	{#each $toasts as item (item.id)}
		<div
			role="status"
			class="pixel-border max-w-72 border-l-8 bg-surface px-4 py-3 font-pixel text-[10px] leading-relaxed {kindClasses[
				item.kind
			]}"
			style:animation="pixel-pop 200ms steps(3)"
		>
			{item.message}
		</div>
	{/each}
</div>
