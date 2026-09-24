<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { createAuthClient } from 'better-auth/client';
	import { PixelButton, PixelInput, PixelPanel, PixelSpinner, toast } from '$lib/ui';

	const authClient = createAuthClient();

	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let pending = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		if (!EMAIL_RE.test(email)) {
			error = 'That email does not look right';
			toast(error, 'error');
			return;
		}
		if (password.length < 8) {
			error = 'Password must be at least 8 characters';
			toast(error, 'error');
			return;
		}

		pending = true;
		try {
			const result = await authClient.signIn.email({ email, password });
			if (result.error) {
				error = result.error.message || 'Could not log in';
				toast(error, 'error');
				return;
			}
			await invalidateAll();
			await goto(resolve('/'));
		} catch {
			error = 'Something went wrong — try again';
			toast(error, 'error');
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head><title>Log in — MultiFun</title></svelte:head>

<div class="mx-auto w-full max-w-md py-10">
	<PixelPanel title="LOG IN" accent="var(--color-accent)">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			{#if error}
				<p
					role="alert"
					class="border-4 border-danger bg-danger/15 px-3 py-2 font-pixel text-[10px] leading-relaxed text-danger"
				>
					{error}
				</p>
			{/if}

			<PixelInput
				label="Email"
				type="email"
				name="email"
				autocomplete="email"
				required
				bind:value={email}
			/>
			<PixelInput
				label="Password"
				type="password"
				name="password"
				autocomplete="current-password"
				required
				bind:value={password}
			/>

			<PixelButton type="submit" disabled={pending}>
				{#if pending}
					<PixelSpinner size={14} label="Logging in" />
					Logging in…
				{:else}
					Log in
				{/if}
			</PixelButton>
		</form>

		<p class="mt-5 text-center font-body text-sm text-muted">
			New here?
			<a href={resolve('/signup')} class="font-pixel text-[10px] text-accent underline">
				Create an account
			</a>
		</p>
	</PixelPanel>
</div>
