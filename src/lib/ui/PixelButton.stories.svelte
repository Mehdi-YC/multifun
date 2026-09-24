<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelButton from './PixelButton.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelButton',
		component: PixelButton
	});
</script>

<Story name="Primary" args={{ variant: 'primary' }}>PLAY</Story>

<Story name="Secondary" args={{ variant: 'secondary' }}>OPTIONS</Story>

<Story name="Danger" args={{ variant: 'danger' }}>QUIT</Story>

<Story name="Ghost" args={{ variant: 'ghost' }}>CANCEL</Story>

<Story name="Small" args={{ variant: 'primary', size: 'sm' }}>SMALL</Story>

<Story name="Large" args={{ variant: 'primary', size: 'lg' }}>START GAME</Story>

<Story name="Disabled" args={{ variant: 'primary', disabled: true }}>LOCKED</Story>

<Story name="Disabled Danger" args={{ variant: 'danger', disabled: true }}>DELETE</Story>
