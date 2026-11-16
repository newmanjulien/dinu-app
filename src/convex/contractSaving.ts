import { ConvexError } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { Contract } from './contractState';
import type { CompanyAccess } from './auth';
import { prepareActivity } from './hubspotRecords';
import { documentBytes } from './storageCapacity';
import { playbookStates } from './reviews';
import {
	actionKey,
	actorOf,
	receipt,
	remember,
	admitOperation,
	sealReceipt,
	planReceiptWrite,
	receiptSealWork
} from './operationReceipts';
import type { PlaybookCommand } from '../lib/contract/changes';
import { MAX_SAVE_COMMANDS } from '../lib/contract/changes';
import { contractReader } from './contractReader';
import { stateOf } from './contracts';
import { requireContractWork } from './contractPolicy';
import { changeSession, type TransitionHooks, type TransitionWork } from './contractChanges';
import type { ContractSaveResult } from '../lib/contract/saved';
import { discussionTransitionHooks } from './discussionTransitions';
import { DiscussionPreparationRequired, admitDiscussionWork } from './discussionMaps';
import { deferDiscussionOperation, sellerPreparationActor } from './discussionPreparation';
import { receiptChunkFingerprint } from './operationReceipts';

/** Ordered commands compare only touched native heads, preserving unrelated widget merges. */
export async function saveCommands(
	ctx: MutationCtx,
	access: CompanyAccess,
	contract: Contract,
	args: { commands: PlaybookCommand[]; operationId: string },
	hooks?: TransitionHooks,
	resuming?: Doc<'operationReceipts'>
): Promise<ContractSaveResult> {
	admitOperation(args.operationId);
	for (const command of args.commands) admitOperation(command.id);
	const key = actionKey(access, 'save', args.operationId),
		inputs = JSON.stringify([contract.root._id, args]);
	const prior = await receipt(ctx, key, inputs);
	if (prior) {
		if (
			prior.companyId !== access.companyId ||
			prior.contractId !== contract.root._id ||
			prior.kind !== 'playbook-save'
		)
			throw new Error('Save receipt ownership is invalid.');
		if (prior.state === 'preparing') {
			if (!resuming) return { status: 'preparing', operationId: args.operationId };
			if (resuming._id !== prior._id) throw new Error('Only the original pending save can resume.');
		}
		if (prior.state === 'failed')
			throw new ConvexError(prior.error ?? 'This operation could not complete.');
		if (prior.state === 'complete') return JSON.parse(prior.result) as ContractSaveResult;
	}
	if (!args.commands.length) return { status: 'saved', state: await stateOf(ctx, contract) };
	await requireContractWork(ctx, contract);
	if (
		args.commands.length > MAX_SAVE_COMMANDS ||
		new TextEncoder().encode(inputs).length > 750 * 1024
	)
		throw new ConvexError('Too many pending contract changes.');
	const accepted: {
		key: string;
		inputs: string;
		command: PlaybookCommand;
		description?: string;
		contentRevision?: number;
	}[] = [];
	let completedState: Awaited<ReturnType<typeof stateOf>> | undefined;
	const activityRows: Omit<Doc<'hubspotEvents'>, '_id' | '_creationTime'>[] = [];
	const discussions = discussionTransitionHooks(ctx, contract, {
		receipt: resuming ? (prior ?? undefined) : undefined,
		hooks
	});
	try {
		const ids = new Set<string>(),
			expected = new Map<string, string | null>();
		const session = await changeSession(ctx, contract);
		for (const command of args.commands) {
			if (ids.has(command.id) || !Number.isFinite(command.occurredAt))
				throw new ConvexError('Invalid contract change.');
			ids.add(command.id);
			// Commands queued for the same widget share its original exact server head.
			// Their order is retained below, including intermediate immediate applications.
			const actual = (await session.head('playbook', command.itemId)).current?.id ?? null;
			if (
				expected.has(command.itemId) &&
				expected.get(command.itemId) !== command.expectedCurrentChangeId
			)
				throw new ConvexError('Commands for one widget must share their original change identity.');
			expected.set(command.itemId, command.expectedCurrentChangeId);
			if (actual !== command.expectedCurrentChangeId)
				return { status: 'conflict', state: await stateOf(ctx, contract) };
		}
		const reader = await contractReader(ctx, contract.root);

		for (const command of args.commands) {
			const commandKey = actionKey(access, 'application', command.id),
				commandInputs = JSON.stringify([contract.root._id, command]);
			if (await receipt(ctx, commandKey, commandInputs))
				throw new ConvexError(
					'This contract change was already accepted. Reload before applying it again.'
				);
			const item = await reader.item(command.itemId);
			if (!item) throw new ConvexError('This Playbook option is unavailable.');
			const current = await session.head('playbook', command.itemId);
			if (command.action.kind === 'withdraw') {
				await session.withdraw('playbook', command.itemId);
				accepted.push({ key: commandKey, inputs: commandInputs, command });
				continue;
			}
			const optionId = command.action.optionId;
			if (
				current.current?.row.kind === 'playbook' &&
				current.current.row.source.optionId === optionId &&
				session.status(current) !== 'rejected'
			) {
				accepted.push({ key: commandKey, inputs: commandInputs, command });
				continue;
			}
			if (optionId === null && !current.applied) {
				// Set-to-base never doubles as a pending-withdraw command.
				if (current.current)
					throw new ConvexError(
						'Withdraw the pending transition to return to the applied wording.'
					);
				accepted.push({ key: commandKey, inputs: commandInputs, command });
				continue;
			}
			const option =
				optionId === null ? null : item.choices.find((choice) => choice.id === optionId);
			if (optionId !== null && !option)
				throw new ConvexError('This Playbook option is unavailable.');
			await session.stage({
				source: {
					kind: 'playbook',
					value: {
						templateVersionId: contract.root.templateVersionId,
						itemId: command.itemId,
						optionId,
						description: option?.description ?? 'Remove applied option',
						target: item.primary.target
					}
				},
				key: command.itemId,
				operationId: commandKey,
				policy: item.review.kind,
				changes: option?.changes ?? [],
				access
			});
			accepted.push({
				key: commandKey,
				inputs: commandInputs,
				command,
				description: option?.description,
				contentRevision: item.contentRevision
			});
		}
		const base = await playbookStates(ctx, contract);
		for (const entry of accepted)
			if (entry.description && entry.command.action.kind === 'set') {
				await admitDiscussionWork(ctx, { reads: 3, queries: 3, readBytes: 3 * 1024 * 1024 });
				const prepared = await prepareActivity(
					ctx,
					contract,
					actorOf(access.profile),
					entry.key,
					'applied',
					JSON.stringify({
						itemId: entry.command.itemId,
						contentRevision: entry.contentRevision,
						concessionId: entry.command.action.optionId,
						description: entry.description
					}),
					Math.min(Date.now(), entry.command.occurredAt)
				);
				if (prepared.row) activityRows.push(prepared.row);
			}
		await session.commit({
			access,
			operationId: args.operationId,
			hooks: discussions.hooks,
			reserveTail: async (root) => {
				const state = await stateOf(ctx, { ...contract, root }, session.playbookStates(base)),
					result = JSON.stringify({ status: 'saved', state });
				const commandWork = accepted.map(
					(entry) =>
						planReceiptWrite(access.companyId, entry.key, entry.inputs, args.operationId).work
				);
				const work: TransitionWork = {
					documents: activityRows.length + commandWork.reduce((n, w) => n + w.documents, 0),
					bytes:
						activityRows.reduce(
							(n, row) => n + documentBytes({ ...row, _id: 'x'.repeat(32), _creationTime: 0 }),
							0
						) + commandWork.reduce((n, w) => n + w.bytes, 0)
				};
				if (resuming && prior) {
					const seal = await receiptSealWork(ctx, prior, inputs, result);
					work.documents! += seal.writes;
					work.bytes! += seal.bytes;
					work.queries = seal.reads;
					work.readDocuments = seal.reads;
					work.readBytes = seal.readBytes;
					work.functionsScheduled = 1;
					work.scheduledFunctionArgsBytes = 1024;
				} else {
					const final = planReceiptWrite(access.companyId, key, inputs, result, {
						contractId: contract.root._id,
						kind: 'playbook-save'
					}).work;
					work.documents! += final.documents;
					work.bytes! += final.bytes;
				}
				return work;
			}
		});
		completedState = await stateOf(ctx, contract, session.playbookStates(base));
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired) || discussions.businessWritesStarted)
			throw error;
		return deferDiscussionOperation(ctx, {
			contract,
			actor: sellerPreparationActor(access),
			kind: 'playbook-save',
			operationId: args.operationId,
			key,
			inputs,
			prior: resuming ? (prior ?? undefined) : undefined,
			plan: await discussions.deferredPlan(receiptChunkFingerprint(JSON.stringify([key, inputs])))
		});
	}
	for (const row of activityRows) await ctx.db.insert('hubspotEvents', row);
	for (const entry of accepted)
		await remember(ctx, access.companyId, entry.key, entry.inputs, args.operationId);
	if (!completedState) throw new Error('Save completion lost its admitted state.');
	const result = { status: 'saved' as const, state: completedState };
	if (resuming && prior)
		await sealReceipt(ctx, prior, inputs, { state: 'complete', result: JSON.stringify(result) });
	else
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), {
			contractId: contract.root._id,
			kind: 'playbook-save'
		});
	return result;
}
