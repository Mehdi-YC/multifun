<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelInput from './PixelInput.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelInput',
		component: PixelInput
	});
</script>

<Story
	name="Default"
	args={{ label: 'Username', name: 'username', value: '', placeholder: 'player_one' }}
/>

<Story name="Email" args={{ label: 'Email', name: 'email', type: 'email', value: 'a@b.co' }} />

<Story
	name="Password"
	args={{ label: 'Password', name: 'password', type: 'password', value: 'secret' }}
/>

<Story
	name="With Error"
	args={{
		label: 'Email',
		name: 'email',
		type: 'email',
		value: 'not-an-email',
		error: 'Enter a valid email address'
	}}
/>

<Story name="Disabled" args={{ label: 'Room code', value: 'ABCD', disabled: true }} />

<Story name="Required" args={{ label: 'Display name', required: true, value: '' }} />
