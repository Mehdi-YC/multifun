<script lang="ts">
	interface Option {
		value: string;
		label: string;
	}

	interface Props {
		label?: string;
		value?: string;
		options: Option[];
		name?: string;
		error?: string;
	}

	let { label, value = $bindable(''), options, name, error }: Props = $props();

	const uid = $props.id();
</script>

<div class="flex flex-col gap-1">
	{#if label}
		<label for="{uid}-select" class="font-pixel text-[10px] text-muted">{label}</label>
	{/if}
	<select
		id="{uid}-select"
		{name}
		bind:value
		aria-invalid={error ? true : undefined}
		aria-describedby={error ? `${uid}-error` : undefined}
		class="w-full appearance-none border-4 border-border border-r-border-hi border-b-border-hi bg-surface-2 px-3 py-2 font-body text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent {error
			? 'border-danger'
			: ''}"
	>
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	{#if error}
		<p id="{uid}-error" class="font-body text-xs text-danger">{error}</p>
	{/if}
</div>

<style>
	option {
		background-color: #1c1c33;
		color: #f2f2ff;
	}
</style>
