<script lang="ts">
	import type { AvatarConfig } from '$lib/game/assets/avatar';
	import Avatar from './Avatar.svelte';

	interface Member {
		displayName: string;
		username: string;
		avatarJson: AvatarConfig;
		role?: 'host' | 'player';
		isReady?: boolean;
		connected?: boolean;
	}

	interface Props {
		member: Member;
		size?: number;
		showName?: boolean;
	}

	let { member, size = 40, showName = true }: Props = $props();
</script>

<div
	class="inline-flex items-center gap-2 border-4 border-border border-t-border-hi border-l-border-hi bg-surface-2 px-2 py-1"
	class:opacity-50={member.connected === false}
>
	<Avatar config={member.avatarJson} {size} alt="{member.displayName}'s avatar" />
	{#if showName}
		<div class="flex flex-col gap-1">
			<span class="font-pixel text-[10px] text-text">{member.displayName}</span>
			<span class="font-body text-xs text-muted">@{member.username}</span>
			<div class="flex flex-wrap gap-1">
				{#if member.role === 'host'}
					<span
						class="border-2 border-accent bg-accent/15 px-1 py-0.5 font-pixel text-[8px] text-accent"
					>
						♛ HOST
					</span>
				{/if}
				{#if member.isReady}
					<span
						class="border-2 border-success bg-success/15 px-1 py-0.5 font-pixel text-[8px] text-success"
					>
						READY
					</span>
				{/if}
				{#if member.connected === false}
					<span class="border-2 border-muted/50 px-1 py-0.5 font-pixel text-[8px] text-muted">
						OFFLINE
					</span>
				{/if}
			</div>
		</div>
	{/if}
</div>
