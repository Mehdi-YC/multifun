<script lang="ts">
	interface Props {
		title: string;
		tagline: string;
		accent: string;
		players: string;
		href: string;
		disabled?: boolean;
	}

	let { title, tagline, accent, players, href, disabled = false }: Props = $props();
</script>

<!-- GameCard takes fully-formed URLs and passes them to the anchor as-is -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
{#snippet content()}
	<div class="h-2 w-full" style:background-color={accent}></div>
	<div class="flex flex-1 flex-col gap-3 p-5">
		<h3 class="font-pixel text-sm text-text">{title}</h3>
		<p class="font-body text-sm text-muted">{tagline}</p>
		<div class="mt-auto flex items-center justify-between gap-2">
			<span class="border-2 border-border px-2 py-1 font-pixel text-[8px] text-muted">
				{players}
			</span>
			{#if disabled}
				<span class="bg-danger px-2 py-1 font-pixel text-[8px] text-bg">COMING SOON</span>
			{:else}
				<span class="font-pixel text-[10px]" style:color={accent}>PLAY ▶</span>
			{/if}
		</div>
	</div>
{/snippet}

{#if disabled}
	<div
		class="pixel-border pixel-shadow flex flex-col overflow-hidden bg-surface opacity-70 select-none"
		aria-disabled="true"
	>
		{@render content()}
	</div>
{:else}
	<a
		{href}
		class="pixel-border pixel-shadow flex flex-col overflow-hidden bg-surface transition-transform duration-100 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
	>
		{@render content()}
	</a>
{/if}
<!-- eslint-enable svelte/no-navigation-without-resolve -->
