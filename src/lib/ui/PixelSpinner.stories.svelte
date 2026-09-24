<script module>
	import '../../routes/layout.css';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import PixelSpinner from './PixelSpinner.svelte';

	const { Story } = defineMeta({
		title: 'UI/PixelSpinner',
		component: PixelSpinner
	});
</script>

<Story name="Default" args={{ size: 24 }} />

<Story name="Large" args={{ size: 48, label: 'Loading game assets' }} />

<Story name="Sizes" asChild>
	<div class="flex items-center gap-6 p-8">
		<PixelSpinner size={16} />
		<PixelSpinner size={24} />
		<PixelSpinner size={48} />
	</div>
</Story>
