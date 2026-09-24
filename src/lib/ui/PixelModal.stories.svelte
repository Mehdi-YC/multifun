<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelButton from './PixelButton.svelte';
	import PixelModal from './PixelModal.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelModal',
		component: PixelModal
	});
</script>

<Story name="Closed" args={{ open: false, title: 'Quit game?' }}>
	Progress since the last checkpoint will be lost.
</Story>

<Story name="Open" args={{ open: true, title: 'Quit game?' }}>
	Progress since the last checkpoint will be lost.
</Story>

<Story name="Open With Buttons" asChild>
	<PixelModal open={true} title="Delete save?">
		<div class="flex flex-col gap-3">
			<p class="font-body text-sm text-muted">This cannot be undone.</p>
			<div class="flex gap-2">
				<PixelButton variant="danger">DELETE</PixelButton>
				<PixelButton variant="ghost">CANCEL</PixelButton>
			</div>
		</div>
	</PixelModal>
</Story>

<Story name="Untitled" args={{ open: true }}>An untitled dialog gets an aria-label fallback.</Story>
