import type { HeadingFragment, ParagraphFragment, TableFragment } from './types';
import {
	LAYOUT_COORDINATE_TOLERANCE as EPSILON,
	type HeadingLayoutProfile,
	type ParagraphLayoutProfile,
	type ParagraphBounds,
	type TableLayoutProfile
} from './profile';

function requireLayout(condition: boolean, detail: string): asserts condition {
	if (!condition) throw new Error(`Unsupported contract layout: ${detail}.`);
}

function margins(element: HTMLElement) {
	const style = getComputedStyle(element);
	return {
		marginBlockStart: parseFloat(style.marginBlockStart),
		marginBlockEnd: parseFloat(style.marginBlockEnd)
	};
}

export function readHeadingProfile(
	element: HTMLElement,
	fragment: HeadingFragment
): HeadingLayoutProfile {
	requireLayout(element.matches(`h${fragment.level}`), 'missing heading element');
	const { marginBlockStart, marginBlockEnd } = margins(element);
	return {
		kind: 'heading',
		outerHeight: element.getBoundingClientRect().height + marginBlockStart + marginBlockEnd
	};
}

/** Whole placement is supported only by the production inline paragraph structure.
 * No line boxes or token boundaries are derived from this height read. */
export function readParagraphBounds(
	element: HTMLElement,
	fragment: ParagraphFragment
): ParagraphBounds | undefined {
	const style = getComputedStyle(element);
	if (
		!element.matches('p.contract-paragraph.is-final') ||
		style.display !== 'block' ||
		style.whiteSpace !== 'normal' ||
		style.wordBreak !== 'normal' ||
		style.overflowWrap !== 'normal' ||
		style.hyphens === 'auto' ||
		style.writingMode !== 'horizontal-tb' ||
		style.direction !== 'ltr' ||
		![style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].every(
			(value) => parseFloat(value) === 0
		) ||
		!Number.isFinite(parseFloat(style.lineHeight)) ||
		parseFloat(style.lineHeight) <= 0
	)
		return undefined;
	const leaves = [...element.querySelectorAll<HTMLElement>('[data-contract-token]')];
	if (leaves.length !== fragment.tokens.length) return undefined;
	for (let index = 0; index < leaves.length; index++) {
		const leaf = leaves[index];
		if (
			leaf.childNodes.length !== 1 ||
			leaf.firstChild?.nodeType !== Node.TEXT_NODE ||
			leaf.textContent !== fragment.tokens[index].value ||
			// Hyphens, slashes, soft breaks and non-Latin scripts can wrap inside a
			// token. Keep the exact reader's unsupported-layout checks for those.
			!/^[\s]*$|^\s*[\("'\[{]*[A-Za-z0-9]+[.,;:!?\)"'\]}]*\s*$/.test(fragment.tokens[index].value)
		)
			return undefined;
	}
	for (const child of element.querySelectorAll<HTMLElement>('*')) {
		const inline = getComputedStyle(child);
		if (
			!child.matches('span, ins, del') ||
			inline.display !== 'inline' ||
			inline.position !== 'static' ||
			inline.float !== 'none' ||
			inline.fontSize !== style.fontSize ||
			inline.fontFamily !== style.fontFamily ||
			inline.lineHeight !== style.lineHeight ||
			inline.verticalAlign !== 'baseline' ||
			inline.whiteSpace !== style.whiteSpace ||
			inline.wordBreak !== style.wordBreak ||
			inline.overflowWrap !== style.overflowWrap ||
			inline.writingMode !== style.writingMode ||
			inline.direction !== style.direction
		)
			return undefined;
	}
	return {
		kind: 'paragraph',
		tokenCount: fragment.tokens.length,
		...margins(element),
		contentHeight: element.getBoundingClientRect().height
	};
}

/** Reads text leaves, not wrapper bounds (which can include multiple lines).
 * DOM order is the unconditional marker's index in the whole prepared paragraph.
 */
export function readParagraphProfile(
	element: HTMLElement,
	fragment: ParagraphFragment
): ParagraphLayoutProfile {
	requireLayout(element.matches('p'), 'missing paragraph element');
	const style = getComputedStyle(element);
	requireLayout(
		[style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].every(
			(value) => parseFloat(value) === 0
		),
		'paragraph padding or borders require an explicit profile model'
	);
	const contentHeight = element.getBoundingClientRect().height;
	const lineHeight = parseFloat(style.lineHeight);
	requireLayout(Number.isFinite(lineHeight) && lineHeight > 0, 'paragraph line height');
	const leaves = [...element.querySelectorAll<HTMLElement>('[data-contract-token]')];
	requireLayout(leaves.length === fragment.tokens.length, 'paragraph token markers');
	const range = element.ownerDocument.createRange();
	const observed: { top: number; startToken: number; endToken: number }[] = [];
	for (let index = 0; index < leaves.length; index++) {
		const leaf = leaves[index];
		const text = leaf.firstChild;
		requireLayout(
			text?.nodeType === Node.TEXT_NODE && text.textContent === fragment.tokens[index].value,
			'paragraph token text differs from prepared content'
		);
		range.selectNodeContents(text);
		// Collapsed trailing spaces can return zero-width rects on the following line.
		// They carry no visible geometry and stay with the preceding token/line.
		const rects = [...range.getClientRects()].filter(
			(rect) => rect.width > EPSILON && rect.height > 0
		);
		if (!rects.length) {
			requireLayout(!fragment.tokens[index].value.trim(), 'visible token has no line geometry');
			if (observed.length) observed[observed.length - 1].endToken = index + 1;
			continue;
		}
		const top = rects[0].top;
		requireLayout(
			rects.every((rect) => Math.abs(rect.top - top) <= EPSILON),
			`token ${index} spans multiple visual lines in ${fragment.blockKey}`
		);
		const previous = observed.at(-1);
		if (previous && Math.abs(previous.top - top) <= EPSILON) previous.endToken = index + 1;
		else {
			requireLayout(
				!previous || top > previous.top,
				'paragraph visual lines are out of token order'
			);
			observed.push({ top, startToken: previous?.endToken ?? 0, endToken: index + 1 });
		}
	}
	if (!observed.length) {
		// Wholly collapsed whitespace retains its tokens without allocating a visual line.
		requireLayout(contentHeight === 0, 'paragraph content height has no observed visual lines');
		return {
			kind: 'paragraph',
			tokenCount: fragment.tokens.length,
			...margins(element),
			contentHeight,
			lines: []
		};
	}
	const firstTop = observed[0].top;
	const lines = observed.map((line, index) => {
		// Glyph positions establish real line boundaries. Their successive displacement
		// gives allocated line-box height including leading; the block supplies the end.
		const top = line.top - firstTop;
		const bottom = index + 1 < observed.length ? observed[index + 1].top - firstTop : contentHeight;
		requireLayout(
			Math.abs(bottom - top - lineHeight) <= EPSILON,
			'paragraph line boxes differ from its production line height'
		);
		return { startToken: line.startToken, endToken: line.endToken, top, bottom };
	});
	return {
		kind: 'paragraph',
		tokenCount: fragment.tokens.length,
		...margins(element),
		contentHeight,
		lines
	};
}

/** First pass: full-table browser-chosen columns; no row-slice layout. */
export function readTableColumns(
	element: HTMLTableElement,
	fragment: TableFragment
): readonly number[] {
	const row = element.rows[0];
	requireLayout(Boolean(row) && fragment.rows.length > 0 && row.cells.length > 0, 'empty table');
	const columns = [...row.cells].map((cell) => cell.getBoundingClientRect().width);
	requireLayout(
		fragment.rows.every((cells) => cells.length === columns.length),
		'ragged table columns'
	);
	return columns;
}

/** Second pass: all rows under canonical fixed columns, including auto-layout signatures. */
export function readTableProfile(
	element: HTMLTableElement,
	fragment: TableFragment
): TableLayoutProfile {
	requireLayout(
		Boolean(fragment.columnWidths) && getComputedStyle(element).tableLayout === 'fixed',
		'table rows were not rendered under canonical columns'
	);
	const bounds = element.getBoundingClientRect();
	const rows = [...element.rows].map((row) => row.getBoundingClientRect());
	requireLayout(rows.length === fragment.rows.length && rows.length > 0, 'table row markers');
	const widths = readTableColumns(element, fragment);
	requireLayout(
		widths.every((width, i) => Math.abs(width - fragment.columnWidths![i]) <= EPSILON),
		'fixed table columns differ from the canonical first pass'
	);
	for (let i = 1; i < rows.length; i++)
		requireLayout(
			Math.abs(rows[i].top - rows[i - 1].bottom) <= EPSILON,
			'table row boxes are not additive'
		);
	const start = rows[0].top - bounds.top;
	const end = bounds.bottom - rows[rows.length - 1].bottom;
	requireLayout(start >= -EPSILON && end >= -EPSILON, 'table rows extend beyond its border box');
	return {
		kind: 'table',
		columnWidths: widths,
		...margins(element),
		headerRowCount: fragment.headerRowCount,
		headerHeight: rows
			.slice(0, fragment.headerRowCount)
			.reduce((height, row) => height + row.height, 0),
		bodyRowHeights: rows.slice(fragment.headerRowCount).map((row) => row.height),
		borderBlockStart: Math.max(0, start),
		borderBlockEnd: Math.max(0, end)
	};
}
