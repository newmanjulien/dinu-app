import type { BaselineBlock, InlineSource, ReplacementAtom } from '../../../contract/source-model';
import { canonicalMarks, equalMarks } from '../../../contract/marks';
import { validateBaseline } from '../../../contract/validate-source';
import { BASELINE_MAX_BYTES, type ImportIssue } from '../../../contract/import/limits';
import { child, type XmlNode } from './xml';
import type { Issue } from './format';
import { openPackage } from './package';
import { isCommentControl, isCommentRun, parseDocument, type Paragraph } from './document';
import { resolveNumbering } from './numbering';
import { resolveReferences } from './references';

export function importDocx(input: Uint8Array): {
	blocks: BaselineBlock[];
	issues: ImportIssue[];
} {
	const pkg = openPackage(input);
	const body = child(child(pkg.document, 'document'), 'body');
	if (!body) throw new Error('The Word document has no body.');
	const issues: ImportIssue[] = [];
	const seen = new Set<string>();
	const origins = new Map<ImportIssue, string>();
	let warningCount = 0,
		errorCount = 0;
	const issue: Issue = (where, message, severity = 'error') => {
		const id = typeof where === 'string' ? where : where.id;
		const location = typeof where === 'string' ? where : where.label;
		const key = `${severity}:${id}:${message}`;
		if (seen.has(key)) return;
		// Cap retained detail independently: warning volume never changes validity.
		if (severity === 'warning' && warningCount >= 100) return;
		if (severity === 'error' && errorCount >= 500) return;
		seen.add(key);
		if (severity === 'warning') warningCount++;
		else errorCount++;
		const item: ImportIssue = { severity, location, message };
		issues.push(item);
		origins.set(item, id);
	};
	issue(
		'Document',
		'Agreed uses its own fonts, spacing, colors, table borders, and page breaks.',
		'warning'
	);
	const relationships = new Map(pkg.related.map((r) => [r.id, r]));
	function audit(node: XmlNode) {
		if (node.name === 'footerReference' || node.name.startsWith('comment') || isCommentRun(node))
			return;
		if (/PrChange$/.test(node.name))
			issue('Document', 'Accept or reject tracked formatting changes in Word.');
		if (node.name === 'headerReference') {
			const relationship = relationships.get(node.attrs['r:id']);
			if (!relationship || relationship.type !== 'header' || relationship.external)
				issue('Document', 'Repair missing section header relationships in Word.');
		}
		for (const c of node.children) audit(c);
	}
	const styles = pkg.relatedPart('styles'),
		numbering = pkg.relatedPart('numbering');
	if ((styles && !child(styles, 'styles')) || (numbering && !child(numbering, 'numbering')))
		throw new Error('The Word styles or numbering part is malformed.');
	for (const node of [pkg.document, styles, numbering]) if (node) audit(node);
	const parsed = parseDocument(body, child(styles, 'styles'), issue);
	// References depend on reliable clause addresses.
	if (resolveNumbering(parsed.blocks, child(numbering, 'numbering'), issue))
		resolveReferences(parsed.blocks, parsed.paragraphs, parsed.bookmarks, issue);
	// Footers and comments are discarded. Headers still require body content.
	// Check header relationships, regardless of their filename. Literal
	// numbers are substantive; only actual PAGE/NUMPAGES fields can be discarded.
	for (const relationship of pkg.related)
		if (relationship.type === 'header') {
			if (relationship.external) {
				issue('Document', 'External headers are unsupported.');
				continue;
			}
			const root = child(pkg.read(relationship.target), 'hdr');
			if (!root) throw new Error('The Word header part is malformed.');
			audit(root);
			checkPagination(root, issue);
		}
	let sourceId = 0;
	function content(paragraphs: Paragraph[]): InlineSource[] {
		const normalized: ReplacementAtom[] = [];
		function append(atom: ReplacementAtom) {
			const marks = canonicalMarks(atom.marks);
			const last = normalized.at(-1);
			if (last?.kind === 'text' && atom.kind === 'text' && equalMarks(last.marks, marks))
				last.text += atom.text;
			else normalized.push({ ...atom, ...(marks ? { marks } : {}) });
		}
		for (const [i, paragraph] of paragraphs.entries()) {
			if (i) append({ kind: 'text', text: '\n' });
			for (const atom of paragraph.content) if (atom.kind !== 'text' || atom.text) append(atom);
		}
		if (!normalized.length) normalized.push({ kind: 'text', text: '' });
		return normalized.map((atom) => ({ ...atom, sourceKey: `docx-source-${++sourceId}` }));
	}
	const blocks: BaselineBlock[] = parsed.blocks.map((block) => {
		const base = {
			blockKey: block.blockKey,
			order: block.order,
			...(block.numbering ? { numbering: block.numbering } : {})
		};
		if (block.kind === 'table')
			return {
				...base,
				kind: 'table',
				headerRowCount: block.headerRowCount,
				rows: block.rows.map((row) => row.map((paragraphs) => ({ content: content(paragraphs) }))),
				...(block.variant ? { variant: block.variant } : {})
			};
		const paragraph =
			!block.numbering && block.paragraph.number?.displayedLabel
				? {
						...block.paragraph,
						content: [
							{
								kind: 'text' as const,
								text: block.paragraph.number.displayedLabel + '\t'
							},
							...block.paragraph.content
						]
					}
				: block.paragraph;
		const paragraphContent = content([paragraph]);
		return block.kind === 'heading'
			? {
					...base,
					kind: 'heading',
					anchor: block.blockKey,
					level: block.paragraph.heading!,
					content: paragraphContent
				}
			: { ...base, kind: 'paragraph', content: paragraphContent };
	});
	try {
		validateBaseline(blocks);
	} catch (error) {
		issue(
			'Document',
			error instanceof Error ? error.message : 'The document structure is invalid.'
		);
	}
	if (
		!blocks.some((block) => {
			const contents =
				block.kind === 'table' ? block.rows.flat().map((cell) => cell.content) : [block.content];
			return contents.some((content) =>
				content.some((atom) => atom.kind === 'text' && atom.text.trim().length > 0)
			);
		})
	)
		issue('Document', 'Add contract text to the document before uploading.');
	if (new TextEncoder().encode(JSON.stringify(blocks)).length > BASELINE_MAX_BYTES)
		issue('Document', 'The converted contract exceeds 512 KB. Shorten it before uploading.');
	const byId = new Map(parsed.paragraphs.map((p) => [p.id, p]));
	for (const item of issues) {
		const p = byId.get(origins.get(item)!);
		if (p) item.context = p.plain.slice(0, 1200);
	}
	return { blocks, issues };
}

function checkPagination(root: XmlNode, issue: Issue) {
	let field: { instruction: string; separated: boolean; cached: string } | undefined;
	let pageFields = 0,
		literal = '',
		invalid = false;
	function walk(node: XmlNode, parent?: string) {
		if (
			node.name.startsWith('comment') ||
			isCommentRun(node) ||
			(parent === 'p' && isCommentControl(node))
		)
			return;
		if (['hdr', 'p', 'r'].includes(node.name)) {
			for (const c of node.children) walk(c, node.name);
			return;
		}
		if (['pPr', 'rPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr'].includes(node.name)) return;
		if (node.name === 'fldSimple') {
			if (
				field ||
				!/^\s*(PAGE|NUMPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|ARABIC))?\s*$/i.test(
					node.attrs.instr ?? ''
				)
			)
				invalid = true;
			else {
				pageFields++;
				let cached = '';
				for (const run of node.children) {
					if (run.name !== 'r') invalid = true;
					for (const c of run.children) {
						if (c.name === 't' && !c.children.length) cached += c.text;
						else if (c.name !== 'rPr') invalid = true;
					}
				}
				if (!/^\s*\d+\s*$/.test(cached)) invalid = true;
			}
			return;
		}
		if (node.name === 'fldChar') {
			if (node.attrs.fldCharType === 'begin' && !field)
				field = { instruction: '', separated: false, cached: '' };
			else if (node.attrs.fldCharType === 'separate' && field && !field.separated)
				field.separated = true;
			else if (node.attrs.fldCharType === 'end' && field && field.separated) {
				if (
					/^\s*(PAGE|NUMPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|ARABIC))?\s*$/i.test(field.instruction) &&
					/^\s*\d+\s*$/.test(field.cached)
				)
					pageFields++;
				else invalid = true;
				field = undefined;
			} else invalid = true;
			return;
		}
		if (node.name === 'instrText' && field && !field.separated) {
			field.instruction += node.text;
			return;
		}
		if (node.name === 't') {
			if (node.children.length) invalid = true;
			if (!field) literal += node.text;
			else if (field.separated) field.cached += node.text;
			else invalid = true;
			return;
		}
		if (['tab', 'ptab', 'br', 'cr'].includes(node.name)) {
			if (!field) literal += ' ';
			else invalid = true;
			return;
		}
		invalid = true;
	}
	walk(root);
	if (
		field ||
		invalid ||
		(literal.trim() && (!pageFields || literal.replace(/\b(page|of)\b|[\s/.,:–—-]/gi, '')))
	)
		issue('Document', 'Move substantive headers into the document body in Word.');
	else if (pageFields)
		issue('Document', 'Word page headers are replaced by Agreed’s pagination.', 'warning');
}
