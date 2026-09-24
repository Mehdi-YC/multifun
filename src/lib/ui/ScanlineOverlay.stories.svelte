<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelPanel from './PixelPanel.svelte';
	import ScanlineOverlay from './ScanlineOverlay.svelte';

	const { Story } = defineMeta({
		title: 'UI/ScanlineOverlay',
		component: ScanlineOverlay
	});
</script>

<Story name="Default" args={{ opacity: 0.08 }} />

<Story name="Heavy" args={{ opacity: 0.25 }} />

<Story name="Over Content" asChild>
	<div class="p-8">
		<PixelPanel title="CRT Effect">
			The scanline overlay sits above all content but never blocks pointer events.
		</PixelPanel>
		<ScanlineOverlay opacity={0.12} />
	</div>
</Story>
