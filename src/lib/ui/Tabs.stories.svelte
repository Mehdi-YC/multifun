<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Tabs from './Tabs.svelte';

	const { Story } = defineMeta({
		title: 'UI/Tabs',
		component: Tabs
	});
</script>

<script lang="ts">
	const tabList = [
		{ id: 'lobby', label: 'Lobby' },
		{ id: 'games', label: 'Games' },
		{ id: 'profile', label: 'Profile' }
	];
	let active = $state('lobby');
</script>

<Story name="Default" args={{ tabs: tabList, active: 'lobby' }} />

<Story name="Second Selected" args={{ tabs: tabList, active: 'games' }} />

<Story name="Interactive (arrow keys)" asChild>
	<div class="flex flex-col gap-4 p-6">
		<Tabs tabs={tabList} bind:active />
		<p class="font-body text-sm text-muted">Active tab: {active}</p>
	</div>
</Story>
