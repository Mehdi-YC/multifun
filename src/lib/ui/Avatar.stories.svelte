<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { randomAvatar } from '$lib/game/assets/avatar';
	import Avatar from './Avatar.svelte';

	const { Story } = defineMeta({
		title: 'UI/Avatar',
		component: Avatar
	});
</script>

<Story name="Default" args={{ config: randomAvatar(42), size: 64 }} />

<Story name="Small" args={{ config: randomAvatar(7), size: 32 }} />

<Story name="Large" args={{ config: randomAvatar(1337), size: 128 }} />

<Story name="Grid" asChild>
	<div class="flex flex-wrap gap-4 p-6">
		<Avatar config={randomAvatar(1)} size={64} />
		<Avatar config={randomAvatar(2)} size={64} />
		<Avatar config={randomAvatar(3)} size={64} />
		<Avatar config={randomAvatar(4)} size={64} />
	</div>
</Story>
