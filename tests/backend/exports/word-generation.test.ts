import { describe, expect, it } from 'vitest';
import { composeExport } from '../../../src/lib/document/export/content';
import { createContractDocument } from '../../../src/lib/document/contract-document';
import type { SourceBlock } from '../../../src/lib/document/source-model';
import { generateWord } from '../../../src/lib/server/document/export/word';
import { elements, readDocx, textContent } from './docx';

const blocks: SourceBlock[] = [
	{
		kind: 'paragraph',
		blockKey: 'title',
		order: 0,
		role: 'title',
		content: [{ kind: 'text', sourceKey: 'title-text', text: 'Agreement & café <2026>' }]
	},
	{
		kind: 'paragraph',
		blockKey: 'section',
		order: 1,
		role: 'heading',
		numbering: {
			itemKey: 'section',
			sequenceKey: 'sections',
			style: 'decimal',
			start: 3,
			labelPattern: [{ level: 1 }, { text: '.' }],
			referencePattern: [{ level: 1 }]
		},
		content: [{ kind: 'text', sourceKey: 'section-text', text: 'Services' }]
	},
	{
		kind: 'paragraph',
		blockKey: 'clause',
		order: 2,
		role: 'body',
		numbering: {
			itemKey: 'clause',
			sequenceKey: 'clauses',
			parentItemKey: 'section',
			style: 'lower-alpha',
			labelPattern: [{ level: 1 }, { text: '(' }, { level: 2 }, { text: ')' }],
			referencePattern: [{ level: 1 }, { text: '(' }, { level: 2 }, { text: ')' }]
		},
		content: [{ kind: 'text', sourceKey: 'clause-text', text: 'Keep  two spaces.\r\nSecond line.' }]
	},
	{
		kind: 'paragraph',
		blockKey: 'reference',
		order: 3,
		role: 'body',
		content: [
			{ kind: 'text', sourceKey: 'see', text: 'See clause ' },
			{
				kind: 'reference',
				sourceKey: 'ref',
				targetItemKey: 'clause',
				display: {
					start: [{ level: 1 }, { text: '(' }, { level: 2 }, { text: ')' }]
				}
			}
		]
	},
	{
		kind: 'table',
		blockKey: 'fees',
		order: 4,
		headerRowCount: 1,
		rows: [
			['Service', 'Price'],
			['R&D <support>', '$1,200\r\nper year']
		]
	},
	{
		kind: 'table',
		blockKey: 'signatures',
		order: 5,
		variant: 'signature',
		headerRowCount: 0,
		rows: [
			['Seller signature', 'Buyer signature'],
			['Name: José', 'Date:']
		]
	}
];

describe('real Word document generation', () => {
	it('preserves composed wording, numbering, references, Unicode, whitespace and line breaks in a valid package', async () => {
		const resolved = composeExport({ document: createContractDocument(blocks) });
		expect(resolved.slice(0, 4).map((b) => b.kind === 'paragraph' && b.content)).toEqual([
			'Agreement & café <2026>',
			'3. Services',
			'3(a) Keep  two spaces.\nSecond line.',
			'See clause 3(a)'
		]);
		const parts = await readDocx(await generateWord(resolved, 'Agreement & café <2026>'));
		const document = parts['word/document.xml'];
		const texts = elements(document, 'w:t').map(textContent);
		expect(texts).toEqual([
			'Agreement & café <2026>',
			'3. Services',
			'3(a) Keep  two spaces.',
			'Second line.',
			'See clause 3(a)',
			'Service',
			'Price',
			'R&D <support>',
			'$1,200',
			'per year',
			'Seller signature',
			'Buyer signature',
			'Name: José',
			'Date:'
		]);
		expect(elements(document, 'w:br')).toHaveLength(2);
		expect(
			elements(document, 'w:t').find((node) => textContent(node).includes('two spaces'))
				?.attributes['xml:space']
		).toBe('preserve');
		expect(elements(document, 'w:numPr')).toHaveLength(0); // Labels must not be numbered twice by Word.
		expect(elements(parts['docProps/core.xml'], 'dc:title').map(textContent)).toEqual([
			'Agreement & café <2026>'
		]);
		const numbering = elements(parts['customXml/dinu-numbering.xml'], 'clause').map((n) =>
			JSON.parse(textContent(n))
		);
		expect(numbering).toMatchObject([
			{ itemKey: 'DinuClause1', sequenceKey: 'sequence-1', position: 3 },
			{
				itemKey: 'DinuClause2',
				sequenceKey: 'sequence-2',
				parentItemKey: 'DinuClause1',
				position: 1
			}
		]);
		expect(elements(document, 'w:bookmarkStart').map((n) => n.attributes['w:name'])).toEqual(
			numbering.map((n) => n.itemKey)
		);
		expect(elements(parts['word/_rels/document.xml.rels'], 'Relationship')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attributes: expect.objectContaining({ Target: '../customXml/dinu-numbering.xml' })
				})
			])
		);
		expect(elements(parts['[Content_Types].xml'], 'Override')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attributes: expect.objectContaining({
						PartName: '/customXml/dinu-numbering.xml',
						ContentType: 'application/xml'
					})
				})
			])
		);
	});

	it('keeps table headers repeatable and signature rows together without visible borders', async () => {
		const parts = await readDocx(await generateWord(composeExport({ blocks }), 'Agreement'));
		const tables = elements(parts['word/document.xml'], 'w:tbl');
		expect(tables).toHaveLength(2);
		expect(elements(elements(tables[0], 'w:tr')[0], 'w:tblHeader')).toHaveLength(1);
		expect(
			elements(elements(tables[0], 'w:tr')[1], 'w:tblHeader').every((n) =>
				['false', '0', 'off'].includes(n.attributes['w:val'])
			)
		).toBe(true);
		expect(elements(tables[0], 'w:cantSplit')).toHaveLength(2);
		expect(elements(tables[1], 'w:cantSplit')).toHaveLength(2);
		expect(elements(elements(tables[1], 'w:tr')[0], 'w:keepNext')).toHaveLength(2);
		const borders = elements(tables[1], 'w:tblBorders')[0];
		expect(
			borders.children
				.filter((c) => typeof c !== 'string')
				.map((c) => typeof c !== 'string' && c.attributes['w:val'])
		).toEqual(Array(6).fill('none'));
	});
});
