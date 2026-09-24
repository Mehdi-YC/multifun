<script lang="ts">
	interface Tab {
		id: string;
		label: string;
	}

	interface Props {
		tabs: Tab[];
		active?: string;
	}

	let { tabs, active = $bindable('') }: Props = $props();

	let strip: HTMLDivElement | undefined;

	function attachStrip(el: HTMLDivElement) {
		strip = el;
		return () => {
			strip = undefined;
		};
	}

	function selectTab(id: string) {
		active = id;
		strip?.querySelector<HTMLButtonElement>(`button[data-tab-id="${id}"]`)?.focus();
	}

	function handleKeydown(event: KeyboardEvent, index: number) {
		let next: number | null = null;
		if (event.key === 'ArrowRight') {
			next = (index + 1) % tabs.length;
		} else if (event.key === 'ArrowLeft') {
			next = (index - 1 + tabs.length) % tabs.length;
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = tabs.length - 1;
		}
		if (next !== null && tabs[next]) {
			event.preventDefault();
			selectTab(tabs[next].id);
		}
	}
</script>

<div {@attach attachStrip} role="tablist" class="flex flex-wrap gap-1">
	{#each tabs as tab, index (tab.id)}
		<button
			type="button"
			role="tab"
			id="tab-{tab.id}"
			data-tab-id={tab.id}
			aria-selected={active === tab.id}
			tabindex={active === tab.id ? 0 : -1}
			onclick={() => selectTab(tab.id)}
			onkeydown={(event) => handleKeydown(event, index)}
			class="cursor-pointer border-4 border-b-0 border-border px-4 py-2 font-pixel text-[10px] uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent {active ===
			tab.id
				? 'border-t-border-hi border-l-border-hi bg-surface-2 text-accent'
				: 'bg-surface text-muted hover:text-text'}"
		>
			{tab.label}
		</button>
	{/each}
</div>
