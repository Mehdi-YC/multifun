<script lang="ts">
	import type { Snippet } from 'svelte';
	import PixelPanel from './PixelPanel.svelte';

	interface Props {
		open?: boolean;
		title?: string;
		children: Snippet;
	}

	let { open = $bindable(false), title, children }: Props = $props();

	const uid = $props.id();

	let backdrop: HTMLDivElement | undefined;

	function attachBackdrop(el: HTMLDivElement) {
		backdrop = el;
		return () => {
			backdrop = undefined;
		};
	}

	// focus the first focusable element (typically a button) when the dialog opens
	function focusFirst(el: HTMLElement) {
		el.querySelector<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		)?.focus();
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') {
			open = false;
		}
	}

	function handleWindowClick(event: MouseEvent) {
		if (open && event.target === backdrop) {
			open = false;
		}
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} onclick={handleWindowClick} />

{#if open}
	<div
		{@attach attachBackdrop}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
		role="presentation"
	>
		<div
			{@attach focusFirst}
			role="dialog"
			aria-modal="true"
			aria-labelledby={title ? `${uid}-title` : undefined}
			aria-label={title ? undefined : 'Dialog'}
			class="w-full max-w-md"
			style:animation="slide-up 150ms steps(3)"
		>
			<PixelPanel {title}>
				{#if title}
					<!-- hidden element referenced by aria-labelledby (the visible title lives in PixelPanel) -->
					<span id="{uid}-title" class="sr-only">{title}</span>
				{/if}
				{@render children()}
			</PixelPanel>
		</div>
	</div>
{/if}
