import type { ReplacementAtom, BaselineBlock } from '../source-model';
import { child, children, val, on, text, type XmlNode as Node } from './xml';
import { formatting, type Issue, type Marks, type Location } from './format';
import { equalMarks } from '../marks';
import { BASELINE_MAX_BLOCKS } from './limits';

export type Field = { start: number; end: number; instruction: string };
export type Paragraph = {
	content: ReplacementAtom[];
	plain: string;
	id: string;
	location: Location;
	fields: Field[];
	heading?: 1 | 2 | 3;
	indent?: number;
	number?: {
		id: string;
		depth: number;
		label: (props: Node | undefined) => Marks;
		displayedLabel?: string;
	};
	trim: number;
	scope?: string;
};
export type Bookmark = { paragraph: Paragraph; start: number; end?: number };
export type Block = {
	blockKey: string;
	order: number;
	numbering?: BaselineBlock['numbering'];
} & (
	| { kind: 'paragraph' | 'heading'; paragraph: Paragraph }
	| {
			kind: 'table';
			rows: Paragraph[][][];
			headerRowCount: number;
			variant?: 'signature';
	  }
);
const ignored = new Set([
	'proofErr',
	'permStart',
	'permEnd',
	'lastRenderedPageBreak',
	'commentRangeStart',
	'commentReference',
	'commentRangeEnd'
]);
const transparent = new Set(['customXml', 'hyperlink', 'dir', 'bdo']);

// Comment markers can inherit superscript or other unsupported formatting.
// Discard their entire run before inspecting formatting, while keeping mixed runs.
export function isCommentRun(node: Node): boolean {
	return (
		node.name === 'r' &&
		node.children.some((c) => c.name === 'commentReference') &&
		node.children.every((c) => c.name === 'rPr' || ignored.has(c.name))
	);
}

/** Only declared transparent wrappers are traversed; unknown content is never flattened. */
function structural(n: Node, allowed: Set<string>, issue: Issue, location: string): Node[] {
	const result: Node[] = [];
	for (const c of n.children) {
		if (allowed.has(c.name)) result.push(c);
		else if (c.name === 'customXml')
			for (const nested of structural(c, allowed, issue, location)) result.push(nested);
		else if (
			!ignored.has(c.name) &&
			!['customXmlPr', 'bookmarkStart', 'bookmarkEnd'].includes(c.name)
		)
			issue(
				location,
				`Unsupported Word structure (${c.name}). Convert it to ordinary text or tables in Word.`
			);
	}
	return result;
}

export function parseDocument(body: Node, stylesRoot: Node | undefined, issue: Issue) {
	const format = formatting(stylesRoot, issue);
	const paragraphs: Paragraph[] = [];
	const bookmarks = new Map<string, Bookmark>();
	const openBookmarks = new Map<string, Bookmark>();
	let runs = 0,
		fieldCount = 0,
		cells = 0,
		characters = 0;
	function paragraph(
		p: Node,
		location: string,
		tableProps: Node[] = [],
		inCell = false
	): Paragraph {
		const id = `docx-paragraph-${paragraphs.length + 1}`;
		const where = { id, label: location };
		const resolved = format.paragraph(p, tableProps);
		const numId = resolved.numProps
			.map((n) => val(child(n, 'numId')))
			.findLast((v) => v !== undefined);
		const depth = Number(
			resolved.numProps.map((n) => val(child(n, 'ilvl'))).findLast((v) => v !== undefined) ?? 0
		);
		if (numId && numId !== '0' && (!Number.isSafeInteger(depth) || depth < 0 || depth > 8))
			issue(where, 'Repair this list level in Word.');
		if (inCell && numId && numId !== '0')
			issue(where, 'Remove numbered lists inside table cells in Word.');
		const outline = val(resolved.property('outlineLvl'));
		const heading =
			outline !== undefined
				? Number(outline) + 1
				: Number(resolved.headingStyle?.match(/[1-9]$/)?.[0]);
		if (heading > 3 && heading < 10) issue(where, 'Use Heading 1, 2, or 3 in Word.');
		const result: Paragraph = {
			indent: resolved.indent,
			content: [],
			plain: '',
			fields: [],
			id,
			location: where,
			trim: 0,
			...(heading >= 1 && heading <= 3 ? { heading: heading as 1 | 2 | 3 } : {}),
			...(numId && numId !== '0'
				? { number: { id: numId, depth, label: (props) => resolved.label(props, where) } }
				: {})
		};
		if (paragraphs.length >= 20_000) throw new Error('The contract contains too many paragraphs.');
		paragraphs.push(result);
		let active:
			| {
					kind: 'simple' | 'complex';
					start: number;
					instruction: string;
					state: 'instruction' | 'result';
			  }
			| undefined;
		function append(value: string, marks: Marks) {
			if (active?.state === 'instruction') return;
			characters += value.length;
			if (
				++runs > 100_000 ||
				characters > 1_000_000 ||
				result.plain.length + value.length > 512_000
			)
				throw new Error('The contract contains too much text or formatting.');
			const last = result.content.at(-1);
			if (last?.kind === 'text' && equalMarks(last.marks, marks)) last.text += value;
			else result.content.push({ kind: 'text', text: value, marks });
			result.plain += value;
		}
		function field(instruction: string, start: number, end: number) {
			if (++fieldCount > 10_000 || instruction.length > 4096)
				throw new Error('The contract contains too many or oversized Word fields.');
			result.fields.push({ instruction, start, end });
		}
		function walk(n: Node, marks: Marks, context: 'paragraph' | 'run') {
			if (
				n.name === 'pPr' ||
				n.name === 'rPr' ||
				ignored.has(n.name) ||
				n.name === 'customXmlPr' ||
				isCommentRun(n)
			)
				return;
			if (n.name === 'bookmarkStart') {
				const bookmark = { paragraph: result, start: result.plain.length };
				if (!n.attrs.id || openBookmarks.has(n.attrs.id) || bookmarks.has(n.attrs.name))
					issue(where, 'Repair duplicate Word bookmarks.');
				else {
					openBookmarks.set(n.attrs.id, bookmark);
					if (n.attrs.name) bookmarks.set(n.attrs.name, bookmark);
				}
				return;
			}
			if (n.name === 'bookmarkEnd') {
				const bookmark = openBookmarks.get(n.attrs.id);
				if (!bookmark || bookmark.paragraph !== result)
					issue(where, 'Keep cross-reference bookmarks within one paragraph in Word.');
				else bookmark.end = result.plain.length;
				openBookmarks.delete(n.attrs.id);
				return;
			}
			if (n.name === 'r' && context === 'paragraph') {
				const runMarks = resolved.run(
					child(n, 'rPr'),
					where,
					children(n, 't')
						.map((c) => c.text)
						.join('')
				);
				for (const c of n.children) walk(c, runMarks, 'run');
				return;
			}
			if (n.name === 'fldSimple' && context === 'paragraph') {
				if (active) {
					issue(where, 'Replace nested Word fields with ordinary text.');
					return;
				}
				const start = result.plain.length;
				// Simple fields cannot be closed by complex-field delimiters.
				active = { kind: 'simple', start, instruction: n.attrs.instr ?? '', state: 'result' };
				for (const c of n.children) walk(c, marks, 'paragraph');
				field(n.attrs.instr ?? '', start, result.plain.length);
				active = undefined;
				return;
			}
			if (n.name === 'fldChar' && context === 'run') {
				if (n.attrs.fldCharType === 'begin' && !active)
					active = {
						kind: 'complex',
						start: result.plain.length,
						instruction: '',
						state: 'instruction'
					};
				else if (
					n.attrs.fldCharType === 'separate' &&
					active?.kind === 'complex' &&
					active.state === 'instruction'
				) {
					active.state = 'result';
					active.start = result.plain.length;
				} else if (
					n.attrs.fldCharType === 'end' &&
					active?.kind === 'complex' &&
					active.state === 'result'
				) {
					field(active.instruction, active.start, result.plain.length);
					active = undefined;
				} else issue(where, 'Repair nested or malformed Word fields.');
				return;
			}
			if (n.name === 'instrText' && context === 'run') {
				if (active?.kind !== 'complex' || active.state !== 'instruction')
					issue(where, 'Repair this Word field instruction.');
				else {
					active.instruction += text(n);
					if (active.instruction.length > 4096)
						throw new Error('A Word field instruction is too long.');
				}
				return;
			}
			if (
				context === 'run' &&
				['t', 'br', 'cr', 'tab', 'ptab', 'noBreakHyphen', 'softHyphen'].includes(n.name)
			) {
				if (n.children.length)
					issue(where, 'Replace malformed nested run text with ordinary text in Word.');
				if (n.name === 'br' && n.attrs.type && n.attrs.type !== 'textWrapping')
					issue(where, 'Word page and column breaks are standardized.', 'warning');
				append(
					n.name === 't'
						? text(n)
						: ['tab', 'ptab'].includes(n.name)
							? '\t'
							: n.name === 'noBreakHyphen'
								? '‑'
								: n.name === 'softHyphen'
									? '\u00ad'
									: '\n',
					marks
				);
				return;
			}
			if (transparent.has(n.name)) {
				if (n.name === 'hyperlink')
					issue(where, 'Hyperlinks are preserved as ordinary text.', 'warning');
				for (const c of n.children) walk(c, marks, context);
				return;
			}
			issue(where, `Unsupported Word content (${n.name}). Convert it to ordinary text in Word.`);
		}
		for (const n of p.children) walk(n, {}, 'paragraph');
		if (active) issue(where, 'Repair the unfinished Word field in this paragraph.');
		if (!result.content.length)
			result.content.push({ kind: 'text', text: '', marks: resolved.run(undefined, where) });
		return result;
	}
	const blocks: Block[] = [];
	for (const node of structural(body, new Set(['p', 'tbl', 'sectPr']), issue, 'Document')) {
		if (node.name === 'sectPr') continue;
		if (blocks.length >= BASELINE_MAX_BLOCKS) throw new Error('The contract exceeds 400 blocks.');
		const order = blocks.length,
			blockKey = `docx-block-${order + 1}`;
		const location = `${node.name === 'p' ? 'Paragraph' : 'Table'} ${order + 1}`;
		if (node.name === 'p') {
			const parsed = paragraph(node, location);
			blocks.push({
				kind: parsed.heading ? 'heading' : 'paragraph',
				paragraph: parsed,
				order,
				blockKey
			});
			continue;
		}
		const rowNodes = structural(node, new Set(['tr', 'tblPr', 'tblGrid']), issue, location).filter(
			(n) => n.name === 'tr'
		);
		let columns = children(child(node, 'tblGrid'), 'gridCol').length;
		const rowCells = rowNodes.map((row) =>
			structural(row, new Set(['tc', 'trPr', 'tblPrEx']), issue, location).filter(
				(n) => n.name === 'tc'
			)
		);
		if (!columns) columns = rowCells[0]?.length ?? 0;
		if (!columns || columns > 256 || rowNodes.length > 8192)
			throw new Error('The table exceeds supported dimensions.');
		let headerRowCount = 0;
		const rtl = format.tableDirection(node);
		const rows = rowNodes.map((row, r) => {
			const props = child(row, 'trPr');
			if (on(child(props, 'tblHeader'))) {
				if (headerRowCount === r) headerRowCount++;
				else issue(location, 'Keep repeating table header rows together at the top in Word.');
			}
			if (child(props, 'cnfStyle') || child(row, 'tblPrEx'))
				issue(location, 'Convert conditional row formatting to direct formatting in Word.');
			const before = Number(val(child(props, 'gridBefore')) ?? 0),
				after = Number(val(child(props, 'gridAfter')) ?? 0);
			if (![before, after].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= columns))
				throw new Error('Invalid table grid omissions.');
			cells += before + after;
			if (cells > 20_000) throw new Error('The contract contains too many table cells.');
			const result: Paragraph[][] = Array.from({ length: before }, () => []);
			for (const cell of rowCells[r]) {
				const column = result.length;
				if (++cells > 20_000) throw new Error('The contract contains too many table cells.');
				const cellProps = child(cell, 'tcPr');
				if (
					Number(val(child(cellProps, 'gridSpan')) ?? 1) !== 1 ||
					child(cellProps, 'vMerge') ||
					child(cellProps, 'hMerge')
				)
					issue(location, 'Split merged table cells in Word.');
				if (child(cellProps, 'cnfStyle'))
					issue(location, 'Convert conditional cell formatting to direct formatting in Word.');
				const pNodes = structural(cell, new Set(['p', 'tcPr']), issue, location).filter(
					(n) => n.name === 'p'
				);
				const tableFormat = format.table(node, r, column, rowNodes.length, columns, location);
				result.push(
					pNodes.map((p, i) =>
						paragraph(
							p,
							`${location}, row ${r + 1}, column ${column + 1}, paragraph ${i + 1}`,
							tableFormat,
							true
						)
					)
				);
			}
			for (let i = 0; i < after; i++) result.push([]);
			if (result.length !== columns)
				issue(location, 'Repair the table grid so every row occupies its declared columns.');
			// The source model stores columns in visual left-to-right order.
			return rtl ? result.reverse() : result;
		});
		const borders = child(child(node, 'tblPr'), 'tblBorders');
		const borderless =
			Boolean(borders?.children.length) &&
			borders!.children.every((b) => ['nil', 'none', '0'].includes(b.attrs.val));
		const plain =
			columns === 2 && borderless
				? rows
						.flat(2)
						.map((p) => p.plain)
						.join(' ')
				: '';
		blocks.push({
			kind: 'table',
			order,
			blockKey,
			rows,
			headerRowCount,
			...(columns === 2 &&
			borderless &&
			/\bBy\s*:/i.test(plain) &&
			/\bName\s*:/i.test(plain) &&
			/\bTitle\s*:/i.test(plain)
				? { variant: 'signature' as const }
				: {})
		});
	}
	if (openBookmarks.size) issue('Document', 'Repair unfinished Word bookmarks.');
	return { blocks, paragraphs, bookmarks };
}
