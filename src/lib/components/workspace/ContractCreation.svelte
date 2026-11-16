<script lang="ts">
	import { createOperationId } from '$lib/contract/operation-identity';
	import { assertOperationRetryable, isOperationRecovery } from '$lib/contract/operation-recovery';
	import { onDestroy } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { useConvexClient } from 'convex-svelte';
	import { ConvexError } from 'convex/values';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { ConnectionInterruptedError } from '$lib/auth/convex-connection.svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { beginCreation, creationPhase } from '$lib/contract/creation-perf';
	import {
		isHubSpotDealConflict,
		isHubSpotInstallationRetired,
		saveError
	} from '$lib/contract/saved';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import type { ContractCreationInput } from '$lib/contract/saved';
	let {
		onOpen,
		onCreate,
		onPrepareSaved,
		onDealConflict = () => {},
		createdId = $bindable<Id<'savedContracts'> | null>(null),
		busy = $bindable(false),
		error = $bindable<string | null>(null),
		deleted = $bindable(false),
		locked = $bindable(false)
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate: () => void;
		onPrepareSaved: (id: Id<'savedContracts'>) => void;
		onDealConflict?: (dealId: string) => void;
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
	let creationRequest:
		| {
				args: ContractCreationInput & { operationId: string };
				uncertain: boolean;
		  }
		| undefined;
	let active = true;
	onDestroy(() => {
		active = false;
	});
	export async function submit(input?: ContractCreationInput) {
		if (!active || session.blocked || session.closing || runtime.paused || busy || deleted) return;
		if (!createdId && !creationRequest && !input) return;
		onCreate();
		const generation = session.transportGeneration;
		beginCreation();
		busy = true;
		error = null;
		try {
			if (!createdId) {
				creationRequest ??= {
					args: { ...input!, operationId: createOperationId() },
					uncertain: false
				};
				locked = true;
				const frozen = creationRequest.args;
				assertOperationRetryable(frozen.operationId);
				const result =
					frozen.kind === 'deal'
						? await client.action(api.hubspotDeals.link, {
								membershipId,
								dealId: frozen.dealId,
								expectedConnectionId: frozen.connectionId,
								operationId: frozen.operationId
							})
						: await client.mutation(api.contracts.create, {
								membershipId,
								title: frozen.name,
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
				creationPhase('confirmed');
			}
			// Establish route-owned editor and resource leases before any further await.
			onPrepareSaved(createdId);
			if (runtime.paused) throw new Error('Company activity paused');
			creationPhase('navigation-start');
			if (!(await onOpen(createdId))) throw new Error('navigation');
		} catch (cause) {
			if (!active) return;
			if (!createdId && creationRequest) {
				if (
					creationRequest.args.kind === 'deal' &&
					(isHubSpotDealConflict(cause) || isHubSpotInstallationRetired(cause))
				) {
					const dealId = creationRequest.args.dealId;
					creationRequest = undefined;
					locked = false;
					onDealConflict(dealId);
				} else if (
					creationRequest.args.kind === 'manual' &&
					cause instanceof ConvexError &&
					!isOperationRecovery(cause) &&
					!creationRequest.uncertain
				) {
					// A later generic rejection cannot resolve an earlier uncertain attempt.
					creationRequest = undefined;
					locked = false;
				} else creationRequest.uncertain = true;
			}
			creationPhase('failed');
			if (createdId && cache.isDeleted(createdId)) deleted = true;
			if (active)
				error = deleted
					? 'This contract was deleted. Return to Contracts to start another contract.'
					: createdId
						? 'Your contract was created, but we couldn’t open it. Try again.'
						: saveError(cause, 'We couldn’t create this contract. Try again.');
		} finally {
			if (active) busy = false;
		}
	}
</script>
