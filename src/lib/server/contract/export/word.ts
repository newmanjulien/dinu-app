import { NUMBERING_PART, numberingXml } from '../../../contract/export/numbering';
import type { RelationshipType } from 'docx';
import { contractName, type ExportBlock } from '../../../contract/export/content';
import {
	CONTRACT_FORMAT,
	CONTRACT_WORD_STYLES as styles,
	contractFlowRole,
	ContractSpacing,
	pixelsToTwips
} from '../../../contract/format';

export async function generateWord(blocks: ExportBlock[], buyerCompanyName: string): Promise<Blob> {
	const {
		Document,
		Packer,
		Paragraph,
		TextRun,
		Bookmark,
		Table,
		TableRow,
		TableCell,
		AlignmentType,
		LineRuleType,
		TableBorders,
		BorderStyle,
		TableLayoutType,
		WidthType
	} = await import('docx');
	const runStyle = {
		font: CONTRACT_FORMAT.font,
		size: `${CONTRACT_FORMAT.fontSize * 0.75}pt` as const,
		color: '171717',
		bold: false,
		italics: false
	};
	const spacing = {
		before: 0,
		after: 0,
		line: pixelsToTwips(CONTRACT_FORMAT.lineHeight),
		lineRule: LineRuleType.EXACTLY
	};
	const paragraphStyle = { alignment: AlignmentType.LEFT, spacing };
	const titleSpacing = { ...spacing, line: pixelsToTwips(CONTRACT_FORMAT.titleLineHeight) };
	const headingStyle = {
		run: { ...runStyle, size: `${CONTRACT_FORMAT.headingFontSize * 0.75}pt` as const },
		paragraph: { ...paragraphStyle, keepNext: true, keepLines: true }
	};
	const titleRunStyle = { ...runStyle, size: `${CONTRACT_FORMAT.titleFontSize * 0.75}pt` as const };
	const runs = (content: string) =>
		content
			? content
					.split('\n')
					.map((text, index) => new TextRun({ text, break: index ? 1 : undefined }))
			: [];
	const border = { style: BorderStyle.SINGLE, size: 6, color: '171717' };
	// Empty title source anchors have no visible allocation or Word paragraph.
	const visible = blocks.filter(
		(block) => block.kind === 'table' || block.role !== 'title' || !/^[\t ]*$/u.test(block.content)
	);
	const flow = new ContractSpacing();
	let headingChain = false;
	const children = visible.flatMap(
		(block, index): (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] => {
			const next = visible[index + 1];
			const role = contractFlowRole(block);
			const gapBefore = flow.next(role);
			const blockSpacing = {
				...spacing,
				...(role === 'title' ? { line: titleSpacing.line } : {}),
				before: pixelsToTwips(gapBefore),
				...(role === 'empty' ? { line: 1 } : {})
			};
			const keepEmptyWithNext =
				block.kind !== 'table' && /^[\t ]*$/u.test(block.content) && headingChain;
			headingChain =
				block.kind !== 'table' &&
				(block.role === 'heading' ||
					block.role === 'title' ||
					role === 'contact-start' ||
					keepEmptyWithNext);
			if (block.kind !== 'table')
				return [
					new Paragraph({
						children: block.numbering
							? [new Bookmark({ id: block.numbering.itemKey, children: runs(block.content) })]
							: runs(block.content),
						style:
							block.role === 'title'
								? styles.title
								: /^[\t ]*$/u.test(block.content)
									? styles.emptyBlock
									: block.numberingDepth
										? `${block.continueNumbering === false ? (block.role === 'heading' ? styles.headingSection : styles.section) : block.role === 'heading' ? styles.headingClause : styles.clause}${block.numberingDepth}`
										: block.role === 'heading'
											? styles.heading
											: styles.body,
						widowControl: true,
						spacing: blockSpacing,
						keepNext:
							(keepEmptyWithNext || role === 'contact-start') && Boolean(next) ? true : undefined,
						...(block.role === 'title'
							? {
									alignment: AlignmentType.CENTER,
									keepNext: index + 1 < visible.length,
									keepLines: true
								}
							: {})
					})
				];
			const signature = block.variant === 'signature';
			const columnCount = block.rows[0].length;
			const columnWidth = Math.floor(9360 / columnCount);
			return [
				...(gapBefore
					? [
							new Paragraph({
								style: styles.tableGap,
								keepNext: true,
								spacing: { ...spacing, line: pixelsToTwips(gapBefore) }
							})
						]
					: []),
				new Table({
					width: { size: 9360, type: WidthType.DXA },
					columnWidths: Array(columnCount).fill(columnWidth),
					layout: signature ? TableLayoutType.AUTOFIT : TableLayoutType.FIXED,
					borders: signature
						? TableBorders.NONE
						: {
								top: border,
								bottom: border,
								left: border,
								right: border,
								insideHorizontal: border,
								insideVertical: border
							},
					margins: signature
						? { top: 135, bottom: 135, left: 0, right: 180 }
						: { top: 120, bottom: 120, left: 120, right: 120 },
					rows: block.rows.map(
						(row, index) =>
							new TableRow({
								tableHeader: index < block.headerRowCount,
								cantSplit: true,
								children: row.map(
									(cell) =>
										new TableCell({
											width: { size: columnWidth, type: WidthType.DXA },
											shading:
												!signature && index < block.headerRowCount ? { fill: 'E8EAED' } : undefined,
											children: [
												new Paragraph({
													children: runs(cell),
													style: 'ContractTable',
													keepNext: signature && index < block.rows.length - 1,
													keepLines: signature
												})
											]
										})
								)
							})
					)
				}),
				new Paragraph({ style: styles.tableGap })
			];
		}
	);
	const document = new Document({
		title: contractName(buyerCompanyName),
		styles: {
			default: {
				document: {
					run: runStyle,
					paragraph: paragraphStyle
				},
				heading1: headingStyle,
				heading2: headingStyle
			},
			paragraphStyles: [
				{
					id: styles.body,
					name: styles.body,
					basedOn: 'Normal',
					run: runStyle,
					paragraph: paragraphStyle
				},
				{
					id: styles.heading,
					name: styles.heading,
					basedOn: 'Heading2',
					run: headingStyle.run,
					paragraph: { ...headingStyle.paragraph, outlineLevel: 1 }
				},
				// Legal depth travels separately from the flat Heading 2 outline.
				...Array.from({ length: 9 }, (_, index) => index + 1).flatMap((depth) =>
					[styles.clause, styles.section].flatMap((name) => [
						{
							id: `${name}${depth}`,
							name: `${name}${depth}`,
							basedOn: 'Normal',
							run: runStyle,
							paragraph: paragraphStyle
						},
						{
							id: `${name === styles.section ? styles.headingSection : styles.headingClause}${depth}`,
							name: `${name === styles.section ? styles.headingSection : styles.headingClause}${depth}`,
							basedOn: 'Heading2',
							run: headingStyle.run,
							paragraph: { ...headingStyle.paragraph, outlineLevel: 1 }
						}
					])
				),
				{
					id: styles.title,
					name: styles.title,
					basedOn: 'Heading1',
					run: titleRunStyle,
					paragraph: {
						alignment: AlignmentType.CENTER,
						spacing: titleSpacing,
						outlineLevel: 0,
						keepNext: true,
						keepLines: true
					}
				},
				...[styles.tableGap, styles.emptyBlock].map((id) => ({
					id,
					name: id,
					basedOn: 'Normal',
					run: runStyle,
					paragraph: { alignment: AlignmentType.LEFT, spacing: { ...spacing, line: 1 } }
				})),
				{
					id: 'ContractTable',
					name: 'Contract Table',
					basedOn: 'Normal',
					run: runStyle,
					paragraph: { alignment: AlignmentType.LEFT, spacing: { ...spacing, after: 0 } }
				}
			]
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: 12240, height: 15840 },
						margin: { top: 1440, right: 1440, bottom: 1320, left: 1440 }
					}
				},
				children
			}
		]
	});
	const numbered = visible.flatMap((block) =>
		block.kind === 'paragraph' && block.numbering ? [block.numbering] : []
	);
	// customXml is a standard OOXML relationship omitted from docx's TypeScript union.
	document.Document.Relationships.addRelationship(
		'DinuNumbering',
		'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml' as RelationshipType,
		`../${NUMBERING_PART}`
	);
	document.ContentTypes.addOverride('application/xml', `/${NUMBERING_PART}`);
	return Packer.toBlob(document, false, [{ path: NUMBERING_PART, data: numberingXml(numbered) }]);
}
