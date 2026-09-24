<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import GameCard from './GameCard.svelte';

	const { Story } = defineMeta({
		title: 'UI/GameCard',
		component: GameCard
	});
</script>

<Story
	name="GeoDash"
	args={{
		title: 'GeoDash Rush',
		tagline: 'Jump the neon gauntlet',
		accent: '#b06bff',
		players: '2-8 players',
		href: '#'
	}}
/>

<Story
	name="Kart"
	args={{
		title: 'Kart Clash',
		tagline: 'Drift through pixel circuits',
		accent: '#ff5c5c',
		players: '2-4 players',
		href: '#'
	}}
/>

<Story
	name="Disabled"
	args={{
		title: 'Brawl Box',
		tagline: 'Couch chaos is brewing...',
		accent: '#ff9f43',
		players: '2-6 players',
		href: '#',
		disabled: true
	}}
/>

<Story name="Card Row" asChild>
	<div class="grid grid-cols-3 gap-6 p-8">
		<GameCard
			title="GeoDash Rush"
			tagline="Jump the neon gauntlet"
			accent="#b06bff"
			players="2-8 players"
			href="#"
		/>
		<GameCard
			title="Kart Clash"
			tagline="Drift through pixel circuits"
			accent="#ff5c5c"
			players="2-4 players"
			href="#"
		/>
		<GameCard
			title="Echo Arena"
			tagline="Out-sound your rivals"
			accent="#2de2e6"
			players="2-8 players"
			href="#"
			disabled={true}
		/>
	</div>
</Story>
