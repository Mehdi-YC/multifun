<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
		size?: 'sm' | 'md' | 'lg';
		type?: 'button' | 'submit';
		disabled?: boolean;
		onclick?: (e: MouseEvent) => void;
		ariaLabel?: string;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		onclick,
		ariaLabel,
		children
	}: Props = $props();

	const variantClasses: Record<string, string> = {
		primary: 'bg-accent text-bg border-accent',
		secondary: 'bg-surface-2 text-text border-border-hi',
		danger: 'bg-danger text-bg border-danger',
		ghost: 'bg-transparent text-muted border-border'
	};

	const sizeClasses: Record<string, string> = {
		sm: 'px-3 py-2 text-[8px]',
		md: 'px-5 py-3 text-xs',
		lg: 'px-7 py-4 text-base'
	};
</script>

<button
	{type}
	{disabled}
	{onclick}
	aria-label={ariaLabel}
	class="pixel-shadow btn-press inline-flex cursor-pointer items-center justify-center gap-2 border-4 border-t-white/30 border-l-white/30 font-pixel leading-none uppercase select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none {variantClasses[
		variant
	]} {sizeClasses[size]}"
>
	{@render children()}
</button>
