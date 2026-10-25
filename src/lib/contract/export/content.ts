import { composeContract } from '../compose';
import type { ResolvedRun } from '../model';
import type { CompositionInput } from '../compose';
import type { ContractBlock } from '../model';

export interface ExportRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
}

export type ExportBlock =
	| { kind: 'heading'; level: 1 | 2 | 3; content: ExportRun[] }
	| { kind: 'paragraph'; content: ExportRun[] }
	| {
			kind: 'table';
			variant?: 'signature';
			headerRowCount: number;
			rows: ExportRun[][][];
	  };

function cleanRuns(runs: ResolvedRun[]): ExportRun[] {
	return runs
		.filter((run) => run.generated !== 'empty-hit-target' && run.text)
		.map((run) => ({ text: run.text, bold: run.marks?.bold, italic: run.marks?.italic }));
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
					rows: block.rows.map((row) => row.map((cell) => cleanRuns(cell.content)))
				}
			];
		const content = cleanRuns(block.content);
		if (!content.some((run) => /\S/u.test(run.text))) return [];
		return [
			block.kind === 'heading'
				? { kind: 'heading', level: block.level, content }
				: { kind: 'paragraph', content }
		];
	});
}

export function contractName(companyName: string): string {
	const company = companyName
		.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
		.trim()
		.replace(/[. ]+$/g, '')
		.slice(0, 160);
	return company ? `${company} - Contract` : 'Contract';
}
