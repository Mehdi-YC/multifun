<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelToggle from './PixelToggle.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelToggle',
		component: PixelToggle
	});
</script>

<script lang="ts">
	let musicOn = $state(true);
</script>

<Story name="Off" args={{ label: 'Sound FX', checked: false }} />

<Story name="On" args={{ label: 'Music', checked: true }} />

<Story name="Interactive" asChild>
	<div class="flex flex-col gap-3 p-6">
		<PixelToggle label="Music" bind:checked={musicOn} />
		<p class="font-body text-sm text-muted">Music: {musicOn ? 'ON' : 'OFF'}</p>
	</div>
</Story>
