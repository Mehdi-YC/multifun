<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Toast from './Toast.svelte';

	const { Story } = defineMeta({
		title: 'UI/Toast',
		component: Toast
	});
</script>

<script lang="ts">
	import { toast } from './toast';
</script>

<Story name="Empty Stack" />

<Story name="Trigger Toasts" asChild>
	<div class="flex flex-col gap-3 p-8">
		<button
			type="button"
			class="cursor-pointer border-4 border-success bg-success px-4 py-2 font-pixel text-[10px] text-bg"
			onclick={() => toast('Game saved', 'success')}
		>
			SUCCESS TOAST
		</button>
		<button
			type="button"
			class="cursor-pointer border-4 border-danger bg-danger px-4 py-2 font-pixel text-[10px] text-bg"
			onclick={() => toast('Connection lost', 'error')}
		>
			ERROR TOAST
		</button>
		<button
			type="button"
			class="cursor-pointer border-4 border-info bg-info px-4 py-2 font-pixel text-[10px] text-bg"
			onclick={() => toast('Waiting for players...', 'info')}
		>
			INFO TOAST
		</button>
		<Toast />
	</div>
</Story>

<Story name="Overflow (max 3)" asChild>
	<div class="flex flex-col gap-3 p-8">
		<button
			type="button"
			class="cursor-pointer border-4 border-accent bg-accent px-4 py-2 font-pixel text-[10px] text-bg"
			onclick={() => {
				toast('One', 'info');
				toast('Two', 'info');
				toast('Three', 'info');
				toast('Four (replaces oldest)', 'info');
			}}
		>
			SPAM TOASTS
		</button>
		<Toast />
	</div>
</Story>
