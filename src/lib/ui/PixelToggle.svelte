<script lang="ts">
	interface Props {
		label: string;
		checked?: boolean;
		name?: string;
	}

	let { label, checked = $bindable(false), name }: Props = $props();

	const uid = $props.id();
</script>

<label for="{uid}-toggle" class="inline-flex cursor-pointer items-center gap-3 select-none">
	<input id="{uid}-toggle" type="checkbox" {name} bind:checked class="pixel-toggle" />
	<span class="font-pixel text-[10px] text-text">{label}</span>
</label>

<style>
	.pixel-toggle {
		appearance: none;
		position: relative;
		display: inline-block;
		width: 56px;
		height: 28px;
		flex: none;
		cursor: pointer;
		background-color: var(--color-surface-2, #262647);
		border: 4px solid var(--color-border, #3b3b66);
		border-top-color: var(--color-border-hi, #5a5a96);
		border-left-color: var(--color-border-hi, #5a5a96);
	}

	.pixel-toggle::after {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		width: 20px;
		height: 20px;
		background-color: var(--color-muted, #a0a0cc);
		box-shadow: inset -2px -2px 0 0 rgb(0 0 0 / 0.3);
		transition: transform 80ms steps(2);
	}

	.pixel-toggle:checked {
		background-color: var(--color-success, #57e389);
	}

	.pixel-toggle:checked::after {
		transform: translateX(24px);
		background-color: var(--color-bg, #101020);
	}

	.pixel-toggle:focus-visible {
		outline: 3px solid var(--color-accent, #ffd166);
		outline-offset: 2px;
	}
</style>
