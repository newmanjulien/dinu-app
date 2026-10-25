<script lang="ts">
	import { onDestroy } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import SettingsTextFieldCard from '$lib/features/settings/SettingsTextFieldCard.svelte';
	import SettingsReadonlyFieldCard from '$lib/features/settings/SettingsReadonlyFieldCard.svelte';
	import SettingsAvatarCard from '$lib/features/settings/SettingsAvatarCard.svelte';
	import SettingsRoleCard from '$lib/features/settings/SettingsRoleCard.svelte';
	import SettingsDangerCard from '$lib/features/settings/SettingsDangerCard.svelte';
	const viewer = useViewer();
	const membershipId = viewer().membership.id;
	const client = useConvexClient();
	const session = useViewerSession();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});
	let busy = $state<Record<string, boolean>>({});
	let errors = $state<Record<string, string | null>>({});
	async function perform(key: string, task: () => Promise<unknown>) {
		if (!alive || session.blocked || viewer().company.deletionPending || busy[key]) return;
		busy[key] = true;
		errors[key] = null;
		try {
			await task();
		} catch (e) {
			if (alive) errors[key] = e instanceof Error ? e.message : 'Unable to save changes.';
		} finally {
			if (alive) busy[key] = false;
		}
	}
	function upload(file: File, company: boolean) {
		return perform(company ? 'companyAvatar' : 'avatar', async () => {
			if (
				!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type) ||
				file.size > 2 * 1024 * 1024
			)
				throw new Error('Choose an image of 2 MB or less (JPEG, PNG, WebP, GIF or AVIF).');
			const response = await fetch(
				'/api/avatar?company=' + company + '&membershipId=' + membershipId,
				{
					method: 'POST',
					headers: { 'content-type': file.type },
					body: file
				}
			);
			if (!response.ok) throw new Error(await response.text());
		});
	}
</script>

<section
	class="flex min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page px-3 py-4 md:px-6 md:py-6"
>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-10 md:gap-7 md:pb-16">
		<fieldset disabled={Boolean(viewer().company.deletionPending)} class="contents">
			<SettingsTextFieldCard
				title="Your name"
				description="This is your visible name in Agreed."
				fieldId="personal-name"
				label="Your name"
				value={viewer().profile.name}
				footerText="We display your email if you don't provide a name."
				saving={busy.name}
				errorText={errors.name}
				onSave={(name) =>
					perform('name', () => client.mutation(api.settings.savePersonalName, { name }))}
			/>
			<SettingsReadonlyFieldCard
				title="Sign-in email"
				description="This is the email address you use to sign in to Agreed."
				fieldId="sign-in-email"
				label="Email address"
				value={viewer().profile.email}
				footerText="You cannot change this email."
			/>
			{#if viewer().permissions.editCompanyProfile}
				<SettingsTextFieldCard
					title="Company name"
					description="This is your company's visible name in Agreed."
					fieldId="company-name"
					label="Company name"
					value={viewer().company.name}
					footerText="Use the company or department name your team recognizes."
					saving={busy.companyName}
					errorText={errors.companyName}
					onSave={(name) =>
						perform('companyName', () =>
							client.mutation(api.settings.saveCompanyName, { membershipId, name })
						)}
				/>
				<SettingsTextFieldCard
					title="Approval email"
					description="Contract approval requests are sent to this address."
					fieldId="approval-email"
					label="Approval email"
					value={viewer().company.approvalEmail ?? ''}
					footerText="Defaults to the company creator's email. You can change the recipient here."
					saving={busy.approvalEmail}
					errorText={errors.approvalEmail}
					onSave={(email) =>
						perform('approvalEmail', () =>
							client.mutation(api.settings.saveApprovalEmail, { membershipId, email })
						)}
				/>
			{/if}
			<SettingsRoleCard
				value={viewer().profile.role}
				saving={busy.role}
				disabled={session.blocked}
				errorText={errors.role}
				onSave={(role) =>
					perform('role', () => client.mutation(api.settings.savePersonalRole, { role }))}
			/>
			<SettingsAvatarCard
				title="Your avatar"
				description={['This is your personal avatar.']}
				footerText="An avatar is optional but helps team members recognize you."
				ariaLabel="Upload your avatar"
				uploading={busy.avatar}
				errorText={errors.avatar}
				onFileSelected={(file) => upload(file, false)}
			>
				{#snippet preview()}<Avatar
						name={viewer().profile.name || viewer().profile.email}
						avatarUrl={viewer().profile.avatarUrl}
						size={68}
					/>{/snippet}
			</SettingsAvatarCard>
			{#if viewer().permissions.editCompanyProfile}
				<SettingsAvatarCard
					title="Company avatar"
					description={["This is your company's avatar."]}
					footerText="An avatar is optional but strongly recommended."
					ariaLabel="Upload company avatar"
					uploading={busy.companyAvatar}
					errorText={errors.companyAvatar}
					onFileSelected={(file) => upload(file, true)}
				>
					{#snippet preview()}<Avatar
							name={viewer().company.name}
							avatarUrl={viewer().company.avatarUrl}
							fallbackUrl={null}
							size={68}
						/>{/snippet}
				</SettingsAvatarCard>
			{/if}
		</fieldset>
		<SettingsDangerCard />
	</div>
</section>
