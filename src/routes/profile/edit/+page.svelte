<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { randomAvatar, type AvatarConfig } from '$lib/game/assets/avatar';
	import {
		Avatar,
		PixelButton,
		PixelInput,
		PixelPanel,
		PixelSpinner,
		PixelSelect,
		toast
	} from '$lib/ui';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** Avatar under edit: same shape as AvatarConfig but with plain strings so the
	 *  PixelSelect bindings stay happy. Cast back to AvatarConfig for rendering/saving. */
	interface AvatarDraft extends Omit<AvatarConfig, 'style' | 'hairStyle'> {
		style: string;
		hairStyle: string;
	}

	// form fields intentionally seed from the loaded profile once (not kept in sync)
	const initialProfile = untrack(() => data.profile);
	let avatar = $state<AvatarDraft>({ ...initialProfile.avatarJson });
	let username = $state(initialProfile.username);
	let displayName = $state(initialProfile.displayName);
	let bio = $state(initialProfile.bio);
	let pending = $state(false);

	const preview = $derived(avatar as AvatarConfig);

	const styleOptions = [
		{ value: 'square', label: 'Square' },
		{ value: 'round', label: 'Round' },
		{ value: 'visor', label: 'Visor' },
		{ value: 'ghost', label: 'Ghost' }
	];
	const hairOptions = [
		{ value: 'spiky', label: 'Spiky' },
		{ value: 'bob', label: 'Bob' },
		{ value: 'cap', label: 'Cap' },
		{ value: 'bald', label: 'Bald' },
		{ value: 'ponytail', label: 'Ponytail' }
	];

	const swatches: { key: 'skin' | 'hair' | 'eyes' | 'outfit' | 'bg'; label: string }[] = [
		{ key: 'skin', label: 'Skin' },
		{ key: 'hair', label: 'Hair' },
		{ key: 'eyes', label: 'Eyes' },
		{ key: 'outfit', label: 'Outfit' },
		{ key: 'bg', label: 'Background' }
	];

	function randomize() {
		avatar = randomAvatar();
	}

	function reset() {
		avatar = { ...data.profile.avatarJson };
	}

	const handleSubmit: SubmitFunction = () => {
		pending = true;
		return async ({ result, update }) => {
			if (result.type === 'failure') {
				const message =
					(result.data as { message?: string } | undefined)?.message ?? 'Could not save profile';
				toast(message, 'error');
			}
			await update();
			pending = false;
		};
	};
</script>

<svelte:head><title>Edit profile — MultiFun</title></svelte:head>

<div class="mx-auto w-full max-w-4xl py-6">
	<div class="flex items-end gap-4">
		<h1 class="font-pixel text-lg text-text">EDIT PROFILE</h1>
		<div class="h-2 flex-1 bg-border"></div>
	</div>

	{#if form?.message}
		<p
			role="alert"
			class="mt-4 border-4 border-danger bg-danger/15 px-3 py-2 font-pixel text-[10px] leading-relaxed text-danger"
		>
			{form.message}
		</p>
	{/if}

	<form method="POST" use:enhance={handleSubmit} class="mt-6 flex flex-col gap-8">
		<!-- avatar builder -->
		<PixelPanel title="PIXEL AVATAR" accent="var(--color-echo)">
			<div class="flex flex-wrap gap-8">
				<div class="flex flex-col items-center gap-3">
					<div class="pixel-border bg-surface-2 p-3">
						<Avatar config={preview} size={128} alt="Avatar preview" />
					</div>
					<div class="flex items-end gap-3">
						<div class="flex flex-col items-center gap-1">
							<Avatar config={preview} size={16} alt="Avatar preview 1x" />
							<span class="font-pixel text-[7px] text-muted">1X</span>
						</div>
						<div class="flex flex-col items-center gap-1">
							<Avatar config={preview} size={32} alt="Avatar preview 2x" />
							<span class="font-pixel text-[7px] text-muted">2X</span>
						</div>
						<div class="flex flex-col items-center gap-1">
							<Avatar config={preview} size={64} alt="Avatar preview 4x" />
							<span class="font-pixel text-[7px] text-muted">4X</span>
						</div>
					</div>
					<div class="flex gap-2">
						<PixelButton size="sm" variant="secondary" onclick={randomize}>Randomize</PixelButton>
						<PixelButton size="sm" variant="ghost" onclick={reset}>Reset</PixelButton>
					</div>
				</div>

				<div class="flex min-w-64 flex-1 flex-col gap-4">
					<div class="grid grid-cols-2 gap-3">
						<PixelSelect label="Face style" options={styleOptions} bind:value={avatar.style} />
						<PixelSelect label="Hair" options={hairOptions} bind:value={avatar.hairStyle} />
					</div>
					<div class="flex flex-wrap gap-4">
						{#each swatches as swatch (swatch.key)}
							<label class="flex cursor-pointer flex-col items-center gap-1">
								<span class="font-pixel text-[8px] text-muted">{swatch.label}</span>
								<input
									type="color"
									bind:value={avatar[swatch.key]}
									aria-label="{swatch.label} color"
									class="h-12 w-16 cursor-pointer appearance-none border-4 border-border border-t-border-hi border-l-border-hi bg-surface-2 p-1"
								/>
							</label>
						{/each}
					</div>
				</div>
			</div>
			<input type="hidden" name="avatarJson" value={JSON.stringify($state.snapshot(avatar))} />
		</PixelPanel>

		<!-- identity -->
		<PixelPanel title="IDENTITY" accent="var(--color-accent)">
			<div class="flex flex-col gap-5">
				<div class="flex flex-col gap-1">
					<PixelInput
						label="Username"
						name="username"
						required
						bind:value={username}
						error={username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)
							? '3-20 chars, letters, numbers, underscore'
							: undefined}
					/>
					<p class="font-body text-xs text-muted">3-20 chars, letters, numbers, underscore</p>
				</div>

				<PixelInput label="Display name" name="displayName" required bind:value={displayName} />

				<div class="flex flex-col gap-1">
					<label for="bio-input" class="font-pixel text-[10px] text-muted">Bio</label>
					<textarea
						id="bio-input"
						name="bio"
						maxlength="200"
						rows="3"
						bind:value={bio}
						placeholder="Say something fun…"
						class="w-full border-4 border-border border-r-border-hi border-b-border-hi bg-surface-2 px-3 py-2 font-body text-sm text-text placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					></textarea>
					<p class="self-end font-body text-xs text-muted">{bio.length}/200</p>
				</div>
			</div>
		</PixelPanel>

		<div class="flex flex-wrap items-center gap-4">
			<PixelButton type="submit" disabled={pending}>
				{#if pending}
					<PixelSpinner size={14} label="Saving" />
					Saving…
				{:else}
					Save profile
				{/if}
			</PixelButton>
			<a
				href={resolve('/profile/[username]', { username: data.profile.username })}
				class="font-pixel text-[10px] text-muted underline hover:text-accent"
			>
				Cancel
			</a>
		</div>
	</form>
</div>
