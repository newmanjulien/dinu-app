import { contractName, type ExportBlock, type ExportRun } from '../../../contract/export/content';

export async function generateWord(blocks: ExportBlock[], companyName: string): Promise<Blob> {
	const {
		Document,
		Packer,
		Paragraph,
		TextRun,
		Table,
		TableRow,
		TableCell,
		AlignmentType,
		HeadingLevel,
		TableBorders,
		BorderStyle,
		TableLayoutType,
		WidthType
	} = await import('docx');
	const runs = (content: ExportRun[], header = false) =>
		content.flatMap((run) =>
			run.text.split(/\r\n|\r|\n/).map(
				(text, index) =>
					new TextRun({
						text,
						break: index ? 1 : undefined,
						bold: run.bold ?? (header ? true : undefined),
						italics: run.italic
					})
			)
		);
	const border = { style: BorderStyle.SINGLE, size: 6, color: '171717' };
	const children = blocks.map((block) => {
		if (block.kind !== 'table')
			return new Paragraph({
				children: runs(block.content),
				widowControl: true,
				heading:
					block.kind === 'heading'
						? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
								block.level - 1
							]
						: undefined
			});
		const signature = block.variant === 'signature';
		const columnCount = block.rows[0].length;
		const columnWidth = Math.floor(9360 / columnCount);
		return new Table({
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
											children: runs(cell, index < block.headerRowCount),
											style: 'ContractTable',
											keepNext: signature && index < block.rows.length - 1,
											keepLines: signature
										})
									]
								})
						)
					})
			)
		});
	});
	const document = new Document({
		title: contractName(companyName),
		styles: {
			default: {
				document: {
					run: { font: 'Arial', size: 23, color: '171717' },
					paragraph: {
						alignment: AlignmentType.JUSTIFIED,
						spacing: { after: 300, line: 350 }
					}
				},
				heading1: {
					run: { size: 30, bold: true },
					paragraph: {
						alignment: AlignmentType.CENTER,
						spacing: { before: 0, after: 495, line: 300 },
						keepNext: true,
						keepLines: true
					}
				},
				heading2: {
					run: { size: 26, bold: true },
					paragraph: {
						alignment: AlignmentType.LEFT,
						spacing: { before: 510, after: 150, line: 300 },
						keepNext: true,
						keepLines: true
					}
				},
				heading3: {
					run: { size: 24, bold: true },
					paragraph: {
						alignment: AlignmentType.LEFT,
						spacing: { before: 360, after: 150, line: 300 },
						keepNext: true,
						keepLines: true
					}
				}
			},
			paragraphStyles: [
				{
					id: 'ContractTable',
					name: 'Contract Table',
					basedOn: 'Normal',
					run: { size: 21 },
					paragraph: { alignment: AlignmentType.LEFT, spacing: { after: 0, line: 336 } }
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
	const blob = await Packer.toBlob(document);
	return blob;
}
