/** Temporary v1 wire views for already-open clients. Canonical records use the domain model. */
import { v, type Infer } from 'convex/values';
import { concessionSelections, reviewEntries, reviewStatus } from '../lib/contract/applications';
import {
	inlineSource,
	replacementAtom,
	sourceNumbering,
	sourceTable,
	sourceTarget
} from '../lib/contract/source-validators';
import type { PlaybookItem } from '../lib/playbook/model';
import type { Doc, Id } from './_generated/dataModel';
import { storedContract } from './contractValidators';
import type { HistoricalItem } from './playbookItemRevisions';
import type { DetailRecord } from '../lib/playbook/structure';
import { contractCard, contractMetadata, contractState, snapshot } from './savedContractValidators';

const base = {
	blockKey: v.string(),
	order: v.number(),
	numbering: v.optional(sourceNumbering)
};
export const legacyBlock = v.union(
	v.object({
		...base,
		kind: v.literal('heading'),
		anchor: v.string(),
		level: v.union(v.literal(1), v.literal(2), v.literal(3)),
		content: v.array(inlineSource)
	}),
	v.object({
		...base,
		kind: v.literal('paragraph'),
		content: v.array(inlineSource)
	}),
	sourceTable
);

/** V1 has no title role; flow source coordinates and static table strings survive unchanged. */
export function legacyBlockView(
	block: import('../lib/contract/source-model').BaselineBlock
): Infer<typeof legacyBlock> {
	if (block.kind === 'table') return block;
	const { role, anchor, ...source } = block;
	return role === 'body'
		? source
		: {
				...source,
				kind: 'heading',
				anchor: anchor ?? block.blockKey,
				level: role === 'title' ? 1 : 2
			};
}

export const legacyPlaybook = v.object({
	trigger: v.object({ id: v.string(), range: sourceTarget }),
	instructions: v.optional(
		v.object({
			summary: v.optional(v.string()),
			howToExplainToBuyers: v.optional(v.string()),
			commonObjections: v.optional(v.string()),
			negotiation: v.optional(v.string()),
			changesNeedApproval: v.optional(v.string())
		})
	),
	concessions: v.array(
		v.object({
			id: v.string(),
			tier: v.union(v.literal('preferred'), v.literal('rare')),
			description: v.string(),
			changes: v.array(v.object({ range: sourceTarget, replacement: v.array(replacementAtom) }))
		})
	)
});
export const legacyHistoricalItem = legacyPlaybook.extend({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	revision: v.number()
});
export const legacyStoredItem = legacyHistoricalItem.extend({
	publishedRevisionId: v.optional(v.id('playbookItemRevisions')),
	lastOperationId: v.optional(v.string()),
	lastOperationCaller: v.optional(v.id('profiles'))
});
const reviews = v.record(
	v.id('playbookItems'),
	v.object({ concessionId: v.string(), lifecycle: v.string(), status: reviewStatus })
);
export const legacyState = contractState
	.omit('buyerCompanyName', 'applications', 'editRevision')
	.extend({
		companyName: v.string(),
		selectedConcessions: v.record(v.id('playbookItems'), v.string()),
		reviews,
		revision: v.number()
	});
export const legacyMetadata = legacyState.extend(
	contractMetadata.omit(
		'buyerCompanyName',
		'applications',
		'editRevision',
		'reviewGeneration',
		'reviewCompletion',
		'stateVersion',
		'lastOperationId'
	).fields
);
export const legacyStoredContract = storedContract
	.omit('buyerCompanyName', 'applications', 'editRevision')
	.extend({
		_id: v.id('savedContracts'),
		_creationTime: v.number(),
		companyName: v.string(),
		selectedConcessions: v.record(v.id('playbookItems'), v.string()),
		reviews,
		revision: v.number()
	});
export const legacySnapshot = snapshot
	.omit('items', 'blocks')
	.extend({ blocks: v.array(legacyBlock), items: v.array(legacyHistoricalItem) });
export const legacyCard = contractCard.omit('buyerCompanyName').extend({ companyName: v.string() });
export const legacySaveResult = v.union(
	v.object({ status: v.literal('saved'), state: legacyState }),
	v.object({ status: v.literal('conflict'), state: legacyState }),
	v.object({ status: v.literal('deleted') })
);
export const legacyApprovalSelection = v.object({
	itemId: v.id('playbookItems'),
	concessionPosition: v.number(),
	lifecycle: v.optional(v.string()),
	reviewStatus: v.optional(reviewStatus)
});

export function legacyItemView(item: DetailRecord): Infer<typeof legacyStoredItem>;
export function legacyItemView(item: HistoricalItem): Infer<typeof legacyHistoricalItem>;
export function legacyItemView(item: PlaybookItem): Infer<typeof legacyPlaybook>;
export function legacyItemView(
	item: PlaybookItem & {
		renderKey?: string;
		contentRevision?: number;
		currentRevisionId?: Id<'playbookItemRevisions'>;
		lastOperation?: { id: string; callerId: Id<'profiles'> };
	}
) {
	const {
		approvalPolicy,
		contentRevision,
		currentRevisionId,
		lastOperation,
		instructions,
		trigger,
		concessions,
		renderKey: _renderKey,
		...identity
	} = item;
	return {
		...identity,
		trigger: { id: trigger.id, range: trigger.target },
		...(instructions || approvalPolicy.kind === 'required'
			? {
					instructions: {
						...instructions,
						...(approvalPolicy.kind === 'required'
							? { changesNeedApproval: approvalPolicy.instructions }
							: {})
					}
				}
			: {}),
		concessions: concessions.map(({ changes, ...concession }) => ({
			...concession,
			changes: changes.map(({ target, replacement }) => ({ range: target, replacement }))
		})),
		...(contentRevision === undefined ? {} : { revision: contentRevision }),
		...(currentRevisionId === undefined ? {} : { publishedRevisionId: currentRevisionId }),
		...(lastOperation
			? { lastOperationId: lastOperation.id, lastOperationCaller: lastOperation.callerId }
			: {})
	};
}
function legacyApplicationView(applications: Infer<typeof storedContract>['applications']) {
	return {
		selectedConcessions: concessionSelections(applications),
		reviews: Object.fromEntries(
			reviewEntries(applications).map(([id, review]) => [
				id,
				{
					concessionId: review.concessionId,
					lifecycle: review.applicationId,
					status: review.status
				}
			])
		)
	};
}
export function legacyContractView<
	T extends Pick<Infer<typeof contractState>, 'buyerCompanyName' | 'editRevision' | 'applications'>
>(contract: T) {
	const { buyerCompanyName, editRevision, applications, ...metadata } = contract;
	return {
		...metadata,
		companyName: buyerCompanyName,
		revision: editRevision,
		...legacyApplicationView(applications)
	};
}
