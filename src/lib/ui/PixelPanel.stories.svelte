<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelPanel from './PixelPanel.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelPanel',
		component: PixelPanel
	});
</script>

<Story name="Plain">A flat surface panel with a chunky beveled border.</Story>

<Story name="Titled" args={{ title: 'Game Lobby' }}>Panel body with a pixel-font title bar.</Story>

<Story name="Custom Accent" args={{ title: 'GeoDash', accent: '#b06bff' }}>
	The title underline bar takes any CSS color.
</Story>

<Story name="Not Padded" args={{ title: 'Tight', padded: false }}>
	Content without body padding.
</Story>

<Story name="With Footer" asChild>
	<PixelPanel title="Ready check">
		{#snippet footer()}
			<span class="font-pixel text-[10px] text-muted">Press START when everyone is ready</span>
		{/snippet}
		Players appear in this panel as they join.
	</PixelPanel>
</Story>
