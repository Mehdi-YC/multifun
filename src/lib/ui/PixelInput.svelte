<script lang="ts">
	import type { FullAutoFill } from 'svelte/elements';

	interface Props {
		label?: string;
		value?: string;
		type?: 'text' | 'email' | 'password' | 'number';
		name?: string;
		placeholder?: string;
		error?: string;
		disabled?: boolean;
		required?: boolean;
		autocomplete?: string;
		oninput?: (e: Event) => void;
	}

	let {
		label,
		value = $bindable(''),
		type = 'text',
		name,
		placeholder,
		error,
		disabled = false,
		required = false,
		autocomplete,
		oninput
	}: Props = $props();

	const uid = $props.id();
</script>

<div class="flex flex-col gap-1">
	{#if label}
		<label for="{uid}-input" class="font-pixel text-[10px] text-muted">{label}</label>
	{/if}
	<input
		id="{uid}-input"
		{type}
		{name}
		{placeholder}
		{disabled}
		{required}
		autocomplete={autocomplete as FullAutoFill | undefined}
		bind:value
		{oninput}
		aria-invalid={error ? true : undefined}
		aria-describedby={error ? `${uid}-error` : undefined}
		class="w-full border-4 border-border border-r-border-hi border-b-border-hi bg-surface-2 px-3 py-2 font-body text-sm text-text placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 {error
			? 'border-danger'
			: ''}"
	/>
	{#if error}
		<p id="{uid}-error" class="font-body text-xs text-danger">{error}</p>
	{/if}
</div>
