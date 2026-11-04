import { composeContract } from '../compose';
import type { CompositionInput } from '../compose';
import type { ContractBlock, ResolvedRun } from '../model';
import { textPrefix } from '../../text';

export type ExportBlock =
	| { kind: 'heading'; level: 1 | 2 | 3; content: string }
	| { kind: 'paragraph'; content: string }
	| {
			kind: 'table';
			variant?: 'signature';
			headerRowCount: number;
			rows: string[][];
	  };

function exportText(runs: ResolvedRun[]): string {
	let text = '';
	for (const run of runs) if (run.generated !== 'empty-hit-target') text += run.text;
	// A CRLF pair may span adjacent composition fragments.
	return text.replace(/\r\n|\r/g, '\n');
}

/** Export source and saved concessions, never the screen's redlines or draft previews. */
export function composeExport(
	input: Pick<CompositionInput, 'items' | 'activeConcessions'> & {
		blocks: readonly ContractBlock[];
	}
): ExportBlock[] {
	const resolved = composeContract({
		...input,
		view: 'effective'
	});
	return resolved.flatMap((block): ExportBlock[] => {
		if (block.kind === 'table')
			return [
				{
					kind: 'table',
					variant: block.variant,
					headerRowCount: block.headerRowCount,
					rows: block.rows.map((row) => row.map((cell) => exportText(cell.content)))
				}
			];
		const content = exportText(block.content);
		if (!/\S/u.test(content)) return [];
		return [
			block.kind === 'heading'
				? { kind: 'heading', level: block.level, content }
				: { kind: 'paragraph', content }
		];
	});
}

export function contractName(companyName: string): string {
	const company = textPrefix(
		companyName
			.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
			.trim()
			.replace(/[. ]+$/g, ''),
		160
	);
	return company ? `${company} - Contract` : 'Contract';
}
