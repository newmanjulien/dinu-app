import { ConvexError } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { CompanyAccess } from './auth';
import { scopedOperation } from './auth';
import { activity, actionKey, actorOf, receipt, remember, operation } from './hubspotRecords';
import { choicesOf, concessionSelections, sameApplications } from '../lib/contract/applications';
import type { ActivityCommand } from '../lib/contract/activity-commands';
import { projectCommands } from '../lib/contract/activity-commands';
import { CompiledContract } from '../lib/contract/compiled-contract';
import { createChangeConflictChecker } from '../lib/playbook/conflicts';
import { activeConflicts, conflictsForConcession } from '../lib/playbook/selection-conflicts';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { reviewsForSelections, recordDecision } from './reviews';
import { snapshotReader } from './templates';
import { writeDirectory } from './contractDirectory';
import { MAX_SELECTED_CONCESSIONS } from '../lib/contract/selection-limits';
import { stateOf } from './contracts';
import { requireContractWork } from './contractPolicy';

export async function saveCommands(
	ctx: MutationCtx,
	access: CompanyAccess,
	contract: Doc<'savedContracts'>,
	args: {
		commands: ActivityCommand[];
		choices: ReturnType<typeof choicesOf>;
		expectedEditRevision: number;
		operationId: string;
	}
) {
	const key = actionKey(access, 'save', args.operationId),
		inputs = JSON.stringify([contract._id, args.expectedEditRevision, args.commands, args.choices]);
	if (await receipt(ctx, key, inputs))
		return { status: 'saved' as const, state: stateOf(contract) };
	if (contract.editRevision !== args.expectedEditRevision)
		return { status: 'conflict' as const, state: stateOf(contract) };
	if (!args.commands.length) {
		if (!sameApplications(choicesOf(contract.applications), args.choices))
			throw new ConvexError('Reload to update your contract editor.');
		return { status: 'saved' as const, state: stateOf(contract) };
	}
	await requireContractWork(ctx, contract);
	if (args.commands.length > 25 || new TextEncoder().encode(inputs).length > 750 * 1024)
		throw new ConvexError('Too many pending contract changes.');
	const reader = await snapshotReader(ctx, contract);
	let applications = contract.applications;
	const ids = new Set<string>();
	let compiled: CompiledContract | undefined;
	let conflicts: ReturnType<typeof createChangeConflictChecker> | undefined;
	let geometryValid = false;
	for (const command of args.commands) {
		operation(command.id);
		if (ids.has(command.id) || !Number.isFinite(command.occurredAt))
			throw new ConvexError('Invalid contract change.');
		ids.add(command.id);
		const interactionKey = actionKey(access, 'application', command.id),
			interactionInputs = JSON.stringify([contract._id, command]);
		if (await receipt(ctx, interactionKey, interactionInputs))
			throw new ConvexError(
				'This contract change was already accepted. Reload before applying it again.'
			);
		const choices = projectCommands(choicesOf(applications), [command]);
		if (Object.keys(choices).length > MAX_SELECTED_CONCESSIONS)
			throw new ConvexError('Too many selected concessions.');
		const selections = concessionSelections(choices);
		// Removing a validated selection cannot introduce geometry/review invalidity.
		const items = command.choice ? await reader.selectedItems(selections) : [];
		const result = command.choice
			? reviewsForSelections(items, choices, applications, access.membership.role)
			: {
					applications: Object.fromEntries(
						Object.entries(applications).filter(([id]) => id !== command.itemId)
					),
					autoApprovedItemIds: []
				};
		if (command.choice) {
			if (
				items.length > 1 &&
				applications[command.itemId]?.concessionId !== command.choice.concessionId
			) {
				compiled ??= new CompiledContract(await reader.blocks());
				conflicts ??= createChangeConflictChecker(compiled.index);
				const overlays = items.map(toDocumentOverlay);
				const unchanged =
					applications[command.itemId]?.concessionId === command.choice.concessionId;
				const invalid = !geometryValid
					? activeConflicts(compiled.index, overlays, selections, conflicts).length
					: !unchanged &&
						conflictsForConcession(
							compiled.index,
							overlays,
							selections,
							command.itemId,
							command.choice.concessionId,
							conflicts
						).length;
				if (invalid) throw new ConvexError('Remove conflicting concessions before saving.');
			}
			geometryValid = true;
		}

		applications = result.applications;
		await remember(ctx, access.companyId, interactionKey, interactionInputs, args.operationId);
		if (command.choice) {
			const item = items.find((item) => item._id === command.itemId)!;
			const concession = item.concessions.find((c) => c.id === command.choice!.concessionId)!;
			if (!concession) throw new ConvexError('This concession is unavailable.');
			await activity(
				ctx,
				contract,
				actorOf(access.profile),
				interactionKey,
				'applied',
				JSON.stringify({
					itemId: item._id,
					contentRevision: item.contentRevision,
					concessionId: concession.id,
					description: concession.description,
					applicationId: command.choice.applicationId
				}),
				Math.min(Date.now(), command.occurredAt)
			);
		}
		for (const itemId of result.autoApprovedItemIds) {
			const a = applications[itemId];
			await recordDecision(ctx, contract, access.profile, {
				itemId,
				concessionId: a.concessionId,
				applicationId: a.approval!.applicationId,
				operationId: scopedOperation(
					access,
					JSON.stringify(['save', args.operationId, command.id, itemId])
				),
				previousStatus: 'pending',
				status: 'approved',
				decidedAt: Date.now(),
				changed: true
			});
		}
	}
	if (!sameApplications(choicesOf(applications), args.choices))
		throw new ConvexError('Pending changes do not match the contract selection.');
	const changes = {
		applications,
		editRevision: contract.editRevision + 1,
		reviewGeneration: contract.reviewGeneration + 1,
		stateVersion: contract.stateVersion + 1,
		reviewCompletion: undefined,
		lastOperation: { id: args.operationId, callerId: access.profile._id },
		savedAt: Date.now()
	};
	await ctx.db.patch('savedContracts', contract._id, changes);
	await remember(ctx, access.companyId, key, inputs, 'saved');
	const next = { ...contract, ...changes };
	await writeDirectory(ctx, next);
	return { status: 'saved' as const, state: stateOf(next) };
}
