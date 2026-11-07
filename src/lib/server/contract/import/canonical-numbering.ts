import type { BaselineBlock } from '../../../contract/source-model';
import { BASELINE_MAX_BLOCKS } from '../../../contract/import/limits';
import type { CanonicalNumbering } from '../../../contract/export/numbering';
import { numberAddresses } from '../../../contract/numbering';
import { validateBaseline } from '../../../contract/validate-source';
import type { parseDocument } from './document';
import { child, type XmlNode } from './xml';
import { assignNumberingScopes } from './numbering';

// Older exports used Oceans bookmarks; preserve their numbering on reimport.
const NUMBERING_BOOKMARK = /^(?:Dinu|Oceans)Clause[1-9]\d*$/u;

const failure = () =>
	new Error(
		'The contract numbering metadata is incomplete or no longer matches its text. Export a fresh Word copy.'
	);
const object = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));
const styles = new Set(['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman']);
const keys = new Set([
	'itemKey',
	'sequenceKey',
	'parentItemKey',
	'continueSequence',
	'start',
	'labelPattern',
	'referencePattern',
	'minimumDigits',
	'alphabeticStyle',
	'style',
	'position'
]);

function declaration(value: unknown): CanonicalNumbering {
	if (
		!object(value) ||
		Object.keys(value).some((key) => !keys.has(key)) ||
		!['itemKey', 'sequenceKey'].every(
			(key) => typeof value[key] === 'string' && value[key].length <= 80
		) ||
		!NUMBERING_BOOKMARK.test(value.itemKey as string) ||
		(value.parentItemKey !== undefined &&
			(typeof value.parentItemKey !== 'string' || !NUMBERING_BOOKMARK.test(value.parentItemKey))) ||
		typeof value.style !== 'string' ||
		!styles.has(value.style) ||
		(value.alphabeticStyle !== undefined &&
			(typeof value.alphabeticStyle !== 'string' ||
				!['sequential', 'repeated'].includes(value.alphabeticStyle))) ||
		!['position', 'start', 'minimumDigits'].every((key) =>
			value[key] === undefined
				? key !== 'position'
				: typeof value[key] === 'number' && Number.isSafeInteger(value[key])
		) ||
		(value.continueSequence !== undefined && value.continueSequence !== false)
	)
		throw failure();
	for (const key of ['labelPattern', 'referencePattern']) {
		const pattern = value[key];
		if (pattern === undefined && key === 'referencePattern') continue;
		if (!Array.isArray(pattern) || pattern.length > 80) throw failure();
		for (const part of pattern) {
			if (!object(part)) throw failure();
			if ('text' in part) {
				if (typeof part.text !== 'string' || Object.keys(part).length !== 1) throw failure();
			} else if (
				typeof part.level !== 'number' ||
				Object.keys(part).some((field) => !['level', 'case', 'minimumDigits'].includes(field)) ||
				(part.case !== undefined &&
					(typeof part.case !== 'string' || !['upper', 'lower'].includes(part.case))) ||
				(part.minimumDigits !== undefined && typeof part.minimumDigits !== 'number')
			)
				throw failure();
		}
	}
	// Field shape is checked here; the shared baseline validator checks graph/pattern semantics.
	return value as CanonicalNumbering;
}

/** Owned exports bypass heuristic label inference. External Word files retain that inference. */
export function restoreCanonicalNumbering(
	parsed: ReturnType<typeof parseDocument>,
	root: XmlNode | undefined
): boolean {
	const markers = [...parsed.bookmarks.keys()].filter((name) => NUMBERING_BOOKMARK.test(name));
	if (!root) {
		if (
			markers.length ||
			parsed.blocks.some(
				(block) =>
					block.kind === 'paragraph' && block.paragraph.numberingDepth && !block.paragraph.number
			)
		)
			throw failure();
		return false;
	}
	const container = child(root, 'numbering');
	if (
		!container ||
		container.attrs.version !== '1' ||
		container.text.trim() ||
		Object.keys(container.attrs).length !== 1 ||
		container.children.length > BASELINE_MAX_BLOCKS
	)
		throw failure();
	const declarations = new Map<string, CanonicalNumbering>();
	for (const node of container.children) {
		if (node.name !== 'clause' || node.children.length || Object.keys(node.attrs).length)
			throw failure();
		let value: unknown;
		try {
			value = JSON.parse(node.text);
		} catch {
			throw failure();
		}
		const item = declaration(value);
		if (declarations.has(item.itemKey)) throw failure();
		declarations.set(item.itemKey, item);
	}
	if (markers.length !== declarations.size || markers.some((name) => !declarations.has(name)))
		throw failure();
	const blockByParagraph = new Map(
		parsed.blocks.flatMap((block) =>
			block.kind === 'paragraph' ? [[block.paragraph, block] as const] : []
		)
	);
	const byItem = new Map(
		[...declarations].map(([key, item]) => {
			const bookmark = parsed.bookmarks.get(key);
			const block = bookmark && blockByParagraph.get(bookmark.paragraph);
			if (
				!block ||
				bookmark.start !== 0 ||
				bookmark.end !== block.paragraph.plain.length ||
				block.paragraph.number
			)
				throw failure();
			return [key, { block, item }] as const;
		})
	);
	const assigned = new Set<string>();
	for (const { block, item } of byItem.values()) {
		if (assigned.has(block.blockKey) || (item.parentItemKey && !byItem.has(item.parentItemKey)))
			throw failure();
		assigned.add(block.blockKey);
		const { position: _position, ...numbering } = item;
		block.numbering = {
			...numbering,
			itemKey: block.blockKey,
			...(item.parentItemKey
				? { parentItemKey: byItem.get(item.parentItemKey)!.block.blockKey }
				: {})
		};
	}
	for (const block of parsed.blocks)
		if (
			block.kind === 'paragraph' &&
			(block.paragraph.number || (block.paragraph.numberingDepth && !block.numbering))
		)
			throw failure();
	try {
		validateBaseline(
			parsed.blocks.map((block): BaselineBlock => ({
				kind: 'paragraph',
				role: 'body',
				blockKey: block.blockKey,
				order: block.order,
				content: [{ kind: 'text', sourceKey: block.blockKey, text: '' }],
				...(block.numbering ? { numbering: block.numbering } : {})
			}))
		);
		const addresses = numberAddresses(parsed.blocks);
		for (const { block, item } of byItem.values()) {
			const address = addresses.get(block.blockKey)!;
			const text = block.paragraph.plain;
			if (
				address.position !== item.position ||
				!(text === address.label || text.startsWith(address.label + ' ')) ||
				(block.paragraph.numberingDepth !== undefined &&
					block.paragraph.numberingDepth !== address.tokens.length) ||
				(block.paragraph.continueNumbering !== undefined &&
					block.paragraph.continueNumbering !== (item.continueSequence !== false)) ||
				block.paragraph.fields.some((field) => field.start < address.label.length)
			)
				throw failure();
			block.paragraph.trim = address.label.length + (text.length > address.label.length ? 1 : 0);
		}
	} catch {
		throw failure();
	}
	assignNumberingScopes(parsed.blocks);
	return true;
}
