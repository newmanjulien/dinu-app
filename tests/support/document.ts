import type { Id } from '../../src/convex/_generated/dataModel';
import type { SourceBlock } from '../../src/lib/document/model';
import type { ReadyContract } from '../../src/lib/contract/saved';
import type {
	RepInstructionDetailRecord,
	TemplateContentSnapshot,
	StructureSnapshot
} from '../../src/lib/playbook/structure';
import { itemStructure } from '../../src/lib/playbook/structure';

export const membershipId = 'member' as Id<'memberships'>;
export const companyId = 'company' as Id<'company'>;
export const watermark = {
	templateSourceFingerprint: 'templateSource',
	templateSourceId: 'source' as Id<'templateSources'>,
	authoringGeneration: 1,
	structuralGeneration: 1
};

export function documentFixture(count = 12) {
	const blocks: SourceBlock[] = Array.from({ length: count }, (_, i) => ({
		kind: 'paragraph',
		role: 'body',
		blockKey: `paragraph-${i}`,
		order: i,
		content: [
			{ kind: 'text', sourceKey: `text-${i}`, text: `Clause ${i}. Synthetic contract wording.` }
		]
	}));
	const records: RepInstructionDetailRecord[] = blocks.map((_, i) => ({
		audience: 'rep',
		_id: `item-${i}` as Id<'playbookItems'>,
		_creationTime: 1,
		companyId,
		contentRevision: 1,
		currentRevisionId: `rev-${i}` as Id<'playbookItemRevisions'>,
		renderKey: `render-${i}`,
		instructions: { summary: `Summary ${i}` },
		approvalPolicy: { kind: 'none' },
		trigger: {
			id: `trigger-${i}`,
			target: {
				kind: 'text',
				range: {
					start: { sourceKey: `text-${i}`, offset: 0 },
					end: { sourceKey: `text-${i}`, offset: 6 }
				}
			}
		},
		concessions: [
			{
				id: 'preferred',
				tier: 'preferred',
				description: 'Synthetic choice',
				changes: [
					{
						target: {
							kind: 'text',
							range: {
								start: { sourceKey: `text-${i}`, offset: 0 },
								end: { sourceKey: `text-${i}`, offset: 6 }
							}
						},
						replacement: [{ kind: 'text', text: 'Updated' }]
					}
				]
			}
		]
	}));
	const structure: StructureSnapshot = {
		...watermark,
		ready: true,
		items: records.map((record) => ({ ...itemStructure(record), companyId: record.companyId }))
	};
	const detail = (i: number, record = records[i]): TemplateContentSnapshot => ({
		templateSourceId: watermark.templateSourceId,
		templateSourceFingerprint: watermark.templateSourceFingerprint,
		ready: true,
		status: 'present',
		item: record
	});
	return { blocks, records, structure, detail };
}

export function createdContract(
	snapshot: ReturnType<typeof documentFixture>,
	id = 'contract-a'
): ReadyContract {
	return {
		id,
		status: 'ready',
		contract: {
			_id: id as Id<'savedContracts'>,
			_creationTime: 1,
			companyId,
			creatorId: 'profile' as Id<'profiles'>,
			templateVersionId: 'version' as Id<'templateVersions'>,
			stateRevision: 0,
			metadataRevision: 0,
			title: 'Synthetic Buyer',
			savedAt: 1,
			concessions: [],
			review: { generation: 0 },
			lastOperationId: null
		},
		snapshot: {
			blocks: snapshot.blocks,
			items: snapshot.records,
			blockCount: snapshot.blocks.length,
			itemCount: snapshot.records.length
		}
	};
}

export function readyContract(
	snapshot: ReturnType<typeof documentFixture>,
	id = 'contract-a'
): ReadyContract {
	return createdContract(snapshot, id);
}
