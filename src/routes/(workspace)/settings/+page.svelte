<script lang="ts">
	import SettingsLayout from '$lib/components/workspace/SettingsLayout.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
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

<WorkspacePresentationReporter outcome="success" />

<SettingsLayout
	role={viewer().membership.role}
	editCompanyProfile={viewer().permissions.editCompanyProfile}
>
	{#snippet field(card)}
		<fieldset
			disabled={card.id !== 'danger' && Boolean(viewer().company.deletionPending)}
			class="contents"
		>
			{#if card.id === 'name'}
				<SettingsTextFieldCard
					kind="personal-name"
					title={card.title}
					description={card.description}
					footerText={card.footerText}
					fieldId="personal-name"
					label="Your name"
					value={viewer().profile.name}
					saving={busy.name}
					errorText={errors.name}
					onSave={(name) => perform('name', () => client.mutation(api.profiles.setName, { name }))}
				/>
			{:else if card.id === 'email'}
				<SettingsReadonlyFieldCard
					title={card.title}
					description={card.description}
					footerText={card.footerText}
					fieldId="sign-in-email"
					label="Email address"
					value={viewer().profile.email}
				/>
			{:else if card.id === 'companyName'}
				<SettingsTextFieldCard
					kind="company-name"
					title={card.title}
					description={card.description}
					footerText={card.footerText}
					fieldId="company-name"
					label="Company name"
					value={viewer().company.name}
					saving={busy.companyName}
					errorText={errors.companyName}
					onSave={(name) =>
						perform('companyName', () =>
							client.mutation(api.companies.setName, { membershipId, name })
						)}
				/>
			{:else if card.id === 'approvalEmail'}
				<SettingsTextFieldCard
					kind="approval-email"
					title={card.title}
					description={card.description}
					footerText={card.footerText}
					fieldId="approval-email"
					label="Approval email"
					value={viewer().company.approvalEmail ?? ''}
					saving={busy.approvalEmail}
					errorText={errors.approvalEmail}
					onSave={(email) =>
						perform('approvalEmail', () =>
							client.mutation(api.companies.setApprovalEmail, { membershipId, email })
						)}
				/>
			{:else if card.id === 'role'}
				<SettingsRoleCard
					value={viewer().membership.role}
					saving={busy.role}
					disabled={session.blocked}
					errorText={errors.role}
					onSave={(role) =>
						perform('role', () => client.mutation(api.memberships.setRole, { role }))}
				/>
			{:else if card.id === 'avatar'}
				<SettingsAvatarCard
					title={card.title}
					description={[card.description]}
					footerText={card.footerText}
					ariaLabel="Upload your avatar"
					uploading={busy.avatar}
					errorText={errors.avatar}
					onFileSelected={(file) => upload(file, false)}
				>
					{#snippet preview()}<Avatar
							name={viewer().profile.name || viewer().profile.email}
							avatarUrl={viewer().profile.avatarUrl}
							class="size-17"
						/>{/snippet}
				</SettingsAvatarCard>
			{:else if card.id === 'companyAvatar'}
				<SettingsAvatarCard
					title={card.title}
					description={[card.description]}
					footerText={card.footerText}
					ariaLabel="Upload company avatar"
					uploading={busy.companyAvatar}
					errorText={errors.companyAvatar}
					onFileSelected={(file) => upload(file, true)}
				>
					{#snippet preview()}<Avatar
							name={viewer().company.name}
							avatarUrl={viewer().company.avatarUrl}
							fallbackUrl={null}
							class="size-17"
						/>{/snippet}
				</SettingsAvatarCard>
			{:else}
				<SettingsDangerCard />
			{/if}
		</fieldset>
	{/snippet}
</SettingsLayout>
