<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelSelect from './PixelSelect.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelSelect',
		component: PixelSelect
	});

	const modeOptions = [
		{ value: 'solo', label: 'Solo' },
		{ value: 'duo', label: 'Duo' },
		{ value: 'squad', label: 'Squad' }
	];
</script>

<Story
	name="Default"
	args={{ label: 'Game mode', name: 'mode', options: modeOptions, value: 'solo' }}
/>

<Story
	name="Empty Value"
	args={{ label: 'Game mode', name: 'mode', options: modeOptions, value: '' }}
/>

<Story
	name="With Error"
	args={{
		label: 'Region',
		name: 'region',
		options: modeOptions,
		value: '',
		error: 'Pick a region to continue'
	}}
/>
