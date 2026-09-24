<script module lang="ts">
	import '../../routes/layout.css';
	import type { ComponentProps } from 'svelte';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { randomAvatar } from '$lib/game/assets/avatar';
	import PlayerChip from './PlayerChip.svelte';

	const { Story } = defineMeta({
		title: 'UI/PlayerChip',
		component: PlayerChip
	});

	type Member = ComponentProps<typeof PlayerChip>['member'];

	const hostMember: Member = {
		displayName: 'Pixel Pete',
		username: 'pete',
		avatarJson: randomAvatar(1),
		role: 'host',
		isReady: true,
		connected: true
	};

	const readyMember: Member = {
		displayName: 'Neon Nia',
		username: 'nia',
		avatarJson: randomAvatar(2),
		role: 'player',
		isReady: true,
		connected: true
	};

	const offlineMember: Member = {
		displayName: 'Ghost Gus',
		username: 'gus',
		avatarJson: randomAvatar(3),
		role: 'player',
		isReady: false,
		connected: false
	};
</script>

<Story name="Host" args={{ member: hostMember }} />

<Story name="Ready Player" args={{ member: readyMember }} />

<Story name="Offline" args={{ member: offlineMember }} />

<Story name="Compact" args={{ member: readyMember, showName: false, size: 48 }} />
