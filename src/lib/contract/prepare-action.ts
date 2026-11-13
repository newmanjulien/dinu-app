import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ExpectedContractSource } from '../../convex/contractSourceValidators';
import { waitForRead } from '$lib/auth/attempt';
import { DraftJournal } from './draft-recovery.svelte';

/** Flush only this action's initiating editor, then freeze the server's exact source authority. */
export async function prepareContractAction(options: {
	client: Pick<ConvexClient, 'query'>;
	membershipId: Id<'memberships'>;
	id: Id<'savedContracts'>;
	userId?: string;
	flush?: () => Promise<boolean>;
	hasLocalIntent?: () => boolean;
	current?: () => boolean;
	signal?: AbortSignal;
	requireReady?: boolean;
}): Promise<ExpectedContractSource> {
	const current = () => !options.signal?.aborted && (options.current?.() ?? true);
	const journal = () =>
		options.userId ? new DraftJournal(options.userId, options.id, options.membershipId) : undefined;
	const hasLocalIntent = () => {
		const draft = journal();
		return Boolean(
			options.hasLocalIntent?.() || draft?.owner?.hasLocalIntent() || draft?.hasStoredIntent
		);
	};
	const flush = options.flush ?? journal()?.owner?.flush;
	if (!current()) throw new Error('The contract session changed. Try again.');
	if (flush && !(await waitForRead(flush(), options.signal)))
		throw new ConvexError('Resolve unsaved changes before continuing.');
	if (!current() || hasLocalIntent())
		throw new ConvexError('Resolve unsaved changes before continuing.');
	const status = await waitForRead(
		options.client.query(api.contractExports.status, {
			membershipId: options.membershipId,
			id: options.id
		}),
		options.signal
	);
	if (!current() || hasLocalIntent()) throw new ConvexError('The contract changed. Try again.');
	if (options.requireReady !== false && !status.canExport)
		throw new ConvexError('Save this contract and approve all required changes before continuing.');
	return status.expectedSource;
}
