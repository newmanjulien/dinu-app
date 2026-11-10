import { PlaybookValidationError } from './validation-error';
import type { SourceBlock } from '../document/source-model';
import { CompiledDocument } from '../document/compiled-document';
import { PlaybookGeometryIndex } from './geometry-index';
import type { TemplateItem } from './model';
import { playbookStructure } from './structure';
import {
	MAX_DOCUMENT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	validatePlaybookItemContent,
	validateStructuralReplacementContent,
	validateChangeReferences
} from './validation';

/** Call after shape validation, on the complete proposed live set, for create and update. */
export function validatePlaybook(blocks: readonly SourceBlock[], items: readonly TemplateItem[]) {
	if (blocks.length > MAX_DOCUMENT_BLOCKS || items.length > MAX_PLAYBOOK_ITEMS)
		throw new PlaybookValidationError('Template exceeds the supported source or instructions size');
	const compiled = new CompiledDocument(blocks);
	const geometries = {
		rep: new PlaybookGeometryIndex(compiled),
		buyer: new PlaybookGeometryIndex(compiled)
	};
	items.forEach((item, i) => {
		validatePlaybookItemContent(item);
		geometries['audience' in item ? 'buyer' : 'rep'].set(String(i), playbookStructure(item));
	});
	Object.values(geometries).forEach((geometry) => geometry.auditGeometry());
	for (const item of items) {
		if ('audience' in item) continue;
		validateStructuralReplacementContent(item);
		validateChangeReferences(compiled, item);
	}
	return compiled;
}
