<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { createAuthClient } from 'better-auth/client';
	import { PixelButton, PixelInput, PixelPanel, PixelSpinner, toast } from '$lib/ui';

	const authClient = createAuthClient();

	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let confirm = $state('');
	let error = $state('');
	let pending = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		if (name.trim().length < 2) {
			error = 'Tell us what to call you (at least 2 characters)';
			toast(error, 'error');
			return;
		}
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
		if (password !== confirm) {
			error = 'Passwords do not match';
			toast(error, 'error');
			return;
		}

		pending = true;
		try {
			const result = await authClient.signUp.email({ name: name.trim(), email, password });
			if (result.error) {
				error = result.error.message || 'Could not create account';
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

<svelte:head><title>Sign up — MultiFun</title></svelte:head>

<div class="mx-auto w-full max-w-md py-10">
	<PixelPanel title="CREATE ACCOUNT" accent="var(--color-accent)">
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
				label="Display name"
				name="name"
				placeholder="PixelHero"
				autocomplete="name"
				required
				bind:value={name}
			/>
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
				autocomplete="new-password"
				required
				bind:value={password}
			/>
			<PixelInput
				label="Confirm password"
				type="password"
				name="confirm"
				autocomplete="new-password"
				required
				bind:value={confirm}
			/>

			<PixelButton type="submit" disabled={pending}>
				{#if pending}
					<PixelSpinner size={14} label="Creating account" />
					Creating account…
				{:else}
					Sign up
				{/if}
			</PixelButton>
		</form>

		<p class="mt-5 text-center font-body text-sm text-muted">
			Already playing?
			<a href={resolve('/login')} class="font-pixel text-[10px] text-accent underline">Log in</a>
		</p>
	</PixelPanel>
</div>
