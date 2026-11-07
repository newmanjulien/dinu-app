import type { BaselineBlock } from '../../../contract/source-model';
import type { ParagraphDecision } from '../../../contract/roles';
import { continuesAsProse, identifyTitle, type TitleHint } from '../../../contract/title';
import type { Paragraph } from './document';

const proseStart =
	/^(?:this\b|whereas\b|now[\s,]+therefore\b|the parties\b|in consideration\b|by and between\b|for (?:purposes|the avoidance)\b)/iu;
const sectionName =
	/^(?:recitals|agreement|preamble|background|definitions|terms and conditions|scope of (?:work|services))\s*[.:]?$/iu;
const attachment = /^(?:exhibit|schedule|appendix)\s+[A-Z0-9]+\s*$/iu;
const fieldLabel =
	/^(?:if to\b|attention\s*:|e-?mail\s*:|by\s*:|name\s*:|title\s*:|date\s*:|address\s*:)/iu;
const isProse = (text: string) => proseStart.test(text) || continuesAsProse(text);
const isLabel = (text: string) =>
	text.length <= 180 && text.split(/\s+/u).length <= 24 && !/[\r\n!?]/u.test(text);

type Evidence = {
	text: string;
	letters: number;
	bold: number;
	italic: number;
	underline: number;
	smallCaps: number;
	sizes: Map<number, number>;
};

function evidence(paragraph: Paragraph): Evidence {
	const text = paragraph.plain.slice(paragraph.trim).trim();
	const result: Evidence = {
		text,
		letters: 0,
		bold: 0,
		italic: 0,
		underline: 0,
		smallCaps: 0,
		sizes: new Map()
	};
	for (const span of paragraph.formatting) {
		const letters = paragraph.plain
			.slice(Math.max(paragraph.trim, span.start), span.end)
			.replace(/[^\p{L}\p{N}]/gu, '').length;
		if (!letters || span.end <= paragraph.trim) continue;
		result.letters += letters;
		if (span.format.bold) result.bold += letters;
		if (span.format.italic) result.italic += letters;
		if (span.format.underline && span.format.underline !== 'none') result.underline += letters;
		if (span.format.smallCaps) result.smallCaps += letters;
		if (span.format.size)
			result.sizes.set(span.format.size, (result.sizes.get(span.format.size) ?? 0) + letters);
	}
	return result;
}

/** Analyze document-relative signals once, while effective Word run evidence still exists. */
export function analyzeParagraphs(
	input: readonly BaselineBlock[],
	paragraphs: ReadonlyMap<string, Paragraph>
): { blocks: BaselineBlock[]; decisions: ParagraphDecision[] } {
	const hints = new Map<string, TitleHint>();
	const features = new Map<string, Evidence>();
	const bodySizes = new Map<number, number>();
	let bodyLetters = 0,
		bodyBold = 0,
		bodyItalic = 0,
		bodyUnderline = 0,
		bodySmallCaps = 0;
	for (const [key, paragraph] of paragraphs) {
		hints.set(key, {
			titleStyle: paragraph.titleStyle,
			centered: paragraph.centered,
			openingHeading: paragraph.heading === 1,
			canonicalRole: paragraph.canonicalRole
		});
		const value = evidence(paragraph);
		features.set(key, value);
		// Long prose establishes the document's normal formatting, not its short labels.
		if (value.text.length >= 150) {
			bodyLetters += value.letters;
			bodyBold += value.bold;
			bodyItalic += value.italic;
			bodySmallCaps += value.smallCaps;
			bodyUnderline += value.underline;
			for (const [size, count] of value.sizes)
				bodySizes.set(size, (bodySizes.get(size) ?? 0) + count);
		}
	}
	const normalSize = [...bodySizes].sort((a, b) => b[1] - a[1])[0]?.[0];
	const titled = identifyTitle(input, hints);
	const meaningful = titled.filter(
		(block) => block.kind === 'table' || features.get(block.blockKey)?.text
	);
	const positions = new Map(meaningful.map((block, index) => [block.blockKey, index]));
	const followingProse = (key: string) => {
		const next = meaningful[(positions.get(key) ?? -1) + 1];
		if (!next || next.kind === 'table') return false;
		const text = features.get(next.blockKey)!.text;
		return isProse(text) || text.length > 180;
	};
	const decisions = new Map<string, ParagraphDecision>();
	const blocks = titled.map((block): BaselineBlock => {
		if (block.kind === 'table') return block;
		const paragraph = paragraphs.get(block.blockKey)!;
		const value = features.get(block.blockKey)!;
		const text = value.text;
		if (!text) return block;
		const decide = (
			role: 'title' | 'heading' | 'body',
			reason: string,
			needsReview = false
		): BaselineBlock => {
			decisions.set(block.blockKey, { blockKey: block.blockKey, reason, needsReview });
			return { ...block, role };
		};
		if (block.role === 'title') return decide('title', 'Opening document title.');
		if (paragraph.canonicalRole === 'body' || paragraph.canonicalRole === 'heading')
			return decide(
				paragraph.canonicalRole,
				'Accepted paragraph role retained by the Word export.'
			);
		if (paragraph.canonicalRole === 'title')
			return decide('heading', 'A title outside the opening group needs review.', true);
		const position = positions.get(block.blockKey)!;
		const partyLabel =
			/^(?:provider|customer|client|supplier|buyer|seller|contractor|company)(?:[\s:]+(?:provider|customer|client|supplier|buyer|seller|contractor|company))*\s*[.:]?$/iu.test(
				text
			);
		const signatureContext = meaningful
			.slice(Math.max(0, position - 2), position + 3)
			.some((nearby) =>
				nearby.kind === 'table'
					? nearby.variant === 'signature'
					: /signature|in witness whereof|^(?:by|name|title|date)\s*:|_{3,}/iu.test(
							features.get(nearby.blockKey)!.text
						)
			);
		const signature = partyLabel && (signatureContext || text.split(/\s+/u).length > 1);
		if (
			signature ||
			fieldLabel.test(text) ||
			/@|_{3,}|\[.*(?:signature|intentionally blank).*\]/iu.test(text)
		)
			return decide('body', 'Signature, contact, or form text.');
		const completeUnderline =
			value.letters > 0 &&
			value.underline === value.letters &&
			(!bodyLetters || bodyUnderline < bodyLetters / 2);
		const completeBold =
			value.letters > 0 &&
			value.bold === value.letters &&
			(!bodyLetters || bodyBold < bodyLetters / 2);
		const completeItalic =
			value.letters > 0 &&
			value.italic === value.letters &&
			(!bodyLetters || bodyItalic < bodyLetters / 2);
		const completeSmallCaps =
			value.letters > 0 &&
			value.smallCaps === value.letters &&
			(!bodyLetters || bodySmallCaps < bodyLetters / 2);
		const larger =
			normalSize !== undefined &&
			[...value.sizes].some(([size, count]) => size > normalSize && count === value.letters);
		const emphasized =
			completeUnderline || completeBold || completeItalic || completeSmallCaps || larger;
		const styled = Boolean(paragraph.heading || paragraph.titleStyle);
		const prose = isProse(text);
		if (prose)
			return decide(
				'body',
				'Prose or a label followed by prose.',
				styled || (emphasized && isLabel(text))
			);
		const label = isLabel(text);
		if (label && (styled || emphasized))
			return decide(
				'heading',
				styled
					? 'Standalone label with a Word heading hint.'
					: 'Standalone label emphasized across its words.'
			);
		const capitals = text === text.toUpperCase() && /\p{L}/u.test(text);
		if (
			label &&
			(sectionName.test(text) || attachment.test(text) || (capitals && paragraph.centered))
		)
			return decide('heading', 'Standalone section label supported by document context.');
		const words = text
			.replace(/[.:]\s*$/u, '')
			.split(/\s+/u)
			.filter((word) => !/^(?:of|and|the|to|for|in|on|by|with|or)$/iu.test(word));
		const titleCase = words.length > 0 && words.every((word) => /^[\p{Lu}\d]/u.test(word));
		const possibleLabel =
			label &&
			(capitals ||
				paragraph.centered ||
				Boolean(block.numbering) ||
				(titleCase && followingProse(block.blockKey)));
		return decide(
			'body',
			possibleLabel || styled || emphasized
				? 'Check whether this paragraph labels the text that follows.'
				: 'Ordinary paragraph.',
			possibleLabel || styled || emphasized
		);
	});
	// An unstyled label can join a confirmed heading sequence only when it also
	// introduces prose. Word-only list items do not establish that pattern.
	const headingSequences = new Set(
		blocks.flatMap((block) =>
			block.kind === 'paragraph' && block.role === 'heading' && block.numbering
				? [block.numbering.sequenceKey]
				: []
		)
	);
	const classified = blocks.map((block): BaselineBlock => {
		if (
			block.kind !== 'paragraph' ||
			block.role !== 'body' ||
			!block.numbering ||
			!headingSequences.has(block.numbering.sequenceKey) ||
			!decisions.get(block.blockKey)?.needsReview
		)
			return block;
		const text = features.get(block.blockKey)!.text;
		if (!isLabel(text) || isProse(text) || !followingProse(block.blockKey)) return block;
		decisions.set(block.blockKey, {
			blockKey: block.blockKey,
			reason: 'Standalone label introduces prose in a confirmed heading sequence.',
			needsReview: true
		});
		return { ...block, role: 'heading' };
	});
	return { blocks: classified, decisions: [...decisions.values()] };
}
