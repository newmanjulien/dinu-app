import type { DeepReadonly } from '../immutable';
import type { InstructionAudience, PlaybookItem, TemplateItem } from './model';
import type { DetailRecord, TemplateDetailRecord } from './structure';

/** The shared text editor uses Summary as its single editable explanation slot. */
export function authoringRecord(item: TemplateDetailRecord): DetailRecord;
export function authoringRecord(
	item: DeepReadonly<TemplateDetailRecord>
): DeepReadonly<DetailRecord>;
export function authoringRecord(
	item: DeepReadonly<TemplateDetailRecord>
): DeepReadonly<DetailRecord> {
	if (!('audience' in item)) return item;
	const { audience: _audience, explanation, ...identity } = item;
	return {
		...identity,
		instructions: { summary: explanation },
		approvalPolicy: { kind: 'none' },
		concessions: []
	};
}

export function authoredItem(item: PlaybookItem, audience: InstructionAudience): TemplateItem;
export function authoredItem(
	item: DeepReadonly<PlaybookItem>,
	audience: InstructionAudience
): DeepReadonly<TemplateItem>;
export function authoredItem(
	item: DeepReadonly<PlaybookItem>,
	audience: InstructionAudience
): DeepReadonly<TemplateItem> {
	return audience === 'buyer'
		? { audience, trigger: item.trigger, explanation: item.instructions?.summary ?? '' }
		: item;
}
