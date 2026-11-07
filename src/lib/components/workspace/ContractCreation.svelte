<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { ConvexError } from 'convex/values';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { ConnectionInterruptedError } from '$lib/auth/convex-connection.svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { beginCreation, creationPhase } from '$lib/contract/creation-perf';
	import { isHubSpotDealConflict, saveError } from '$lib/contract/saved';
	import { ReadAttempt } from '$lib/auth/attempt';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import type { TemplateContent, ContractCreationInput } from '$lib/contract/saved';
	import {
		getDocumentResources,
		type DocumentResource,
		type ReadyContract
	} from '$lib/document/runtime/resources.svelte';
	let {
		onOpen,
		onCreate,
		onDealConflict = () => {},
		showPreview = true,
		createdId = $bindable<Id<'savedContracts'> | null>(null),
		busy = $bindable(false),
		error = $bindable<string | null>(null),
		deleted = $bindable(false),
		locked = $bindable(false)
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate: () => void;
		onDealConflict?: (dealId: string) => void;
		showPreview?: boolean;
		createdId?: Id<'savedContracts'> | null;
		busy?: boolean;
		error?: string | null;
		deleted?: boolean;
		locked?: boolean;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const client = useConvexClient();
	const session = useViewerSession();
	const viewer = useViewer();
	const membershipId = viewer().membership.id;
	const cache = getContractSnapshotCache(client);
	const resources = getDocumentResources();
	const currentTemplate = useQuery(api.templates.current, () =>
		createdId || runtime.paused ? 'skip' : { membershipId }
	);
	let template = $state.raw<TemplateContent>();
	const preview = $derived(currentTemplate.error ? undefined : template);
	const previewModule = loadComponent(
		() => import('./ContractPreview.svelte'),
		() => !resources && runtime.hostReady && !runtime.paused && Boolean(preview),
		() => session.transportGeneration
	);
	const ContractPreview = $derived(previewModule.component);
	let draft = $state.raw<DocumentResource>();
	let draftSnapshot: TemplateContent | undefined;
	let draftVersion: Id<'templateVersions'> | undefined;
	let host = $state<HTMLDivElement>();
	let confirmed: ReadyContract['contract'] | undefined;
	$effect(() => {
		const versionId = currentTemplate.data?.versionId;
		const generation = session.transportGeneration;
		if (!versionId || createdId || runtime.paused) return;
		const attempt = new ReadAttempt(15_000);
		void cache
			.loadVersion(versionId, viewer().company.id, attempt.signal)
			.then((snapshot) => {
				if (attempt.signal.aborted || !active || session.transportGeneration !== generation) return;
				template = snapshot;
				draftSnapshot = snapshot;
				draftVersion = versionId;
			})
			.catch(() => {})
			.finally(() => attempt.complete());
		return () => attempt.abort();
	});
	$effect(() => {
		const snapshot = preview;
		if (!resources || !runtime.hostReady || runtime.paused || createdId || !snapshot) return;
		untrack(() => {
			const input = { blocks: { data: snapshot.blocks }, items: { data: snapshot.items } };
			if (draft) draft.workspace.accept(input);
			else draft = resources.createDraft(input);
		});
	});
	$effect(() => {
		const entry = draft,
			target = host;
		if (!entry || !target) return;
		entry.target = target;
		return () => {
			if (entry.target === target) entry.target = undefined;
		};
	});
	let creationRequest:
		| {
				args: ContractCreationInput & { operationId: string };
				uncertain: boolean;
		  }
		| undefined;
	let active = true;
	onDestroy(() => {
		active = false;
		if (draft && resources) resources.releaseDraft(draft);
	});
	export async function submit(input?: ContractCreationInput) {
		if (!active || session.blocked || runtime.paused || !runtime.hostReady || busy || deleted)
			return;
		if (!createdId && !creationRequest && !input) return;
		onCreate();
		if (previewModule.failed) previewModule.retry();
		const generation = session.transportGeneration;
		beginCreation(Boolean(draft?.workspace.viewer.layoutPrepared));
		busy = true;
		error = null;
		try {
			if (!createdId) {
				creationRequest ??= {
					args: { ...input!, operationId: crypto.randomUUID() },
					uncertain: false
				};
				locked = true;
				const frozen = creationRequest.args;
				const result =
					frozen.kind === 'deal'
						? await client.action(api.hubspotDeals.link, {
								membershipId,
								dealId: frozen.dealId,
								operationId: frozen.operationId
							})
						: await client.mutation(api.contracts.create, {
								membershipId,
								buyerCompanyName: frozen.name,
								operationId: frozen.operationId
							});
				if (!active) return;
				if (session.transportGeneration !== generation) throw new ConnectionInterruptedError();
				if (result.status === 'association-required') {
					// Receipt-first transaction proved this immutable manual attempt did not commit.
					creationRequest = undefined;
					locked = false;
					error = 'HubSpot is installed. Choose a deal to create your contract.';
					return;
				}
				if (result.status === 'deleted') {
					deleted = true;
					throw new Error('deleted');
				}
				createdId = result.id;
				confirmed = result.contract;
				creationPhase('confirmed');
			}
			if (runtime.paused) throw new Error('Company activity paused');
			const contract = confirmed!;
			const versionId = contract.templateVersionId;
			if (!versionId) throw new Error('Missing template version');
			const snapshot =
				draftVersion === versionId && draftSnapshot
					? draftSnapshot
					: await cache.loadVersion(versionId, contract.companyId);
			if (!active) return;
			if (session.transportGeneration !== generation) throw new ConnectionInterruptedError();
			if (runtime.paused) throw new Error('Company activity paused');
			draftVersion = versionId;
			draftSnapshot = snapshot;
			const data: ReadyContract = { id: createdId, status: 'ready', contract, snapshot };
			if (resources) {
				if (!draft)
					draft = resources.createDraft({
						blocks: { data: snapshot.blocks },
						items: { data: snapshot.items }
					});
				resources.adopt(draft, data);
				creationPhase('adopted');
			}
			if (!cache.seedConfirmed(data)) throw new Error('Contract unavailable');
			creationPhase('snapshot-ready');
			creationPhase('navigation-start');
			if (!(await onOpen(contract._id))) throw new Error('navigation');
			if (active) creationPhase('displayed');
		} catch (cause) {
			if (!active) return;
			if (!createdId && creationRequest) {
				if (creationRequest.args.kind === 'deal' && isHubSpotDealConflict(cause)) {
					const dealId = creationRequest.args.dealId;
					creationRequest = undefined;
					locked = false;
					onDealConflict(dealId);
				} else if (cause instanceof ConvexError && !creationRequest.uncertain) {
					// A later generic rejection cannot resolve an earlier uncertain attempt.
					creationRequest = undefined;
					locked = false;
				} else creationRequest.uncertain = true;
			}
			creationPhase('failed');
			if (createdId && cache.isDeleted(createdId)) deleted = true;
			if (active)
				error = deleted
					? 'This contract was deleted. Return to Home to start another contract.'
					: createdId
						? 'Your contract was created, but we couldn’t open it. Try again.'
						: saveError(cause, 'We couldn’t create this contract. Try again.');
		} finally {
			if (active) busy = false;
		}
	}
</script>

{#if showPreview}
	<main inert aria-hidden="true" class="pointer-events-none pt-6 pb-12 blur-sm">
		{#if resources}
			<div bind:this={host}></div>
			{#if !draft}
				<DocumentSkeleton embedded announce={false} />
			{/if}
		{:else if preview && ContractPreview}
			<ContractPreview snapshot={preview} />
		{:else}
			<DocumentSkeleton embedded announce={false} />
		{/if}
	</main>{/if}
