<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { ConvexError } from 'convex/values';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { ConnectionInterruptedError } from '$lib/auth/convex-session.svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { beginCreation, creationPhase } from '$lib/contract/creation-perf';
	import { saveError } from '$lib/contract/saved';
	import { ReadAttempt } from '$lib/auth/attempt';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import type { ContractSnapshot } from '$lib/contract/saved';
	import {
		getDocumentResources,
		type DocumentResource,
		type ReadyContract
	} from '$lib/document/runtime/resources.svelte';
	let {
		onOpen,
		onCreate,
		showPreview = true,
		createdId = $bindable<Id<'savedContracts'> | null>(null),
		busy = $bindable(false),
		error = $bindable<string | null>(null),
		deleted = $bindable(false)
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate: () => void;
		showPreview?: boolean;
		createdId?: Id<'savedContracts'> | null;
		busy?: boolean;
		error?: string | null;
		deleted?: boolean;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const client = useConvexClient();
	const session = useViewerSession();
	const viewer = useViewer();
	const membershipId = viewer().membership.id;
	const cache = getContractSnapshotCache(client);
	const resources = getDocumentResources();
	const published = useQuery(api.templates.current, () =>
		createdId || runtime.paused ? 'skip' : { membershipId }
	);
	let template = $state.raw<ContractSnapshot>();
	const preview = $derived(published.error ? undefined : template);
	const previewModule = loadComponent(
		() => import('./ContractPreview.svelte'),
		() => !resources && runtime.ready && !runtime.paused && Boolean(preview),
		() => session.transportGeneration
	);
	const ContractPreview = $derived(previewModule.component);
	let draft = $state.raw<DocumentResource>();
	let draftSnapshot: ContractSnapshot | undefined;
	let draftVersion: Id<'templateVersions'> | undefined;
	let host = $state<HTMLDivElement>();
	let confirmed: ReadyContract['contract'] | undefined;
	$effect(() => {
		const versionId = published.data?.versionId;
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
		if (!resources || !runtime.ready || runtime.paused || createdId || !snapshot) return;
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
		{ args: { companyName: string; operationId: string }; uncertain: boolean } | undefined;
	let active = true;
	onDestroy(() => {
		active = false;
		if (draft && resources) resources.releaseDraft(draft);
	});
	export async function submit(companyName: string) {
		if (!active || session.blocked || runtime.paused || !runtime.ready || busy || deleted) return;
		onCreate();
		if (previewModule.failed) previewModule.retry();
		const generation = session.transportGeneration;
		beginCreation(Boolean(draft?.workspace.viewer.prepared));
		busy = true;
		error = null;
		try {
			if (!createdId) {
				creationRequest ??= {
					args: { companyName, operationId: crypto.randomUUID() },
					uncertain: false
				};
				const result = await client.mutation(api.savedContracts.create, {
					...creationRequest.args,
					membershipId
				});
				if (!active) return;
				if (session.transportGeneration !== generation) throw new ConnectionInterruptedError();
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
				// A rejected first attempt rolled back. A later rejection cannot resolve
				// an earlier uncertain attempt, so keep its original identity and arguments.
				if (cause instanceof ConvexError && !creationRequest.uncertain) creationRequest = undefined;
				else creationRequest.uncertain = true;
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
