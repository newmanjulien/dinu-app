/** CSS pixels are the canonical units for screen and Word contract formatting. */
export const CONTRACT_FORMAT = {
	font: 'Arial',
	fontSize: 15,
	headingFontSize: 16.5,
	titleFontSize: 18,
	lineHeight: 24,
	titleLineHeight: 23,
	blockGap: 14,
	headingGap: 21,
	headingBodyGap: 7,
	titleExtraGapAfter: 4
} as const;

export const CONTRACT_STYLE = [
	`--contract-font:${CONTRACT_FORMAT.font},Helvetica,sans-serif`,
	`--contract-font-size:${CONTRACT_FORMAT.fontSize}px`,
	`--contract-heading-font-size:${CONTRACT_FORMAT.headingFontSize}px`,
	`--contract-title-font-size:${CONTRACT_FORMAT.titleFontSize}px`,
	`--contract-line-height:${CONTRACT_FORMAT.lineHeight}px`,
	`--contract-title-line-height:${CONTRACT_FORMAT.titleLineHeight}px`
].join(';');

export type ContractFlowRole = 'title' | 'heading' | 'contact-start' | 'contact' | 'body' | 'empty';

/** Layout hints only: source text, blocks, and selection coordinates stay intact. */
export function contractFlowRole(block: {
	kind: 'paragraph' | 'table';
	role?: import('./source-model').ParagraphRole;
	content?: string;
}): ContractFlowRole {
	if (block.kind === 'table') return 'body';
	const text = block.content ?? '';
	if (/^[\t ]*$/u.test(text)) return 'empty';
	if (block.role === 'title') return 'title';
	if (block.role === 'heading') return 'heading';
	const trimmed = text.trim();
	if (/^If to\b[^\r\n:]{1,100}:$/iu.test(trimmed)) return 'contact-start';
	// Only used inside a notice group opened by an explicit "If to ...:" label.
	if (
		trimmed.length <= 120 &&
		!/[\r\n;]/u.test(trimmed) &&
		!/^(?:\([a-z0-9]+\)|\d+[.)])\s/iu.test(trimmed) &&
		!/[.!?]$/u.test(trimmed)
	)
		return 'contact';
	return 'body';
}

/** Each boundary has one gap, allocated before the following block. */
export class ContractSpacing {
	#previous: ContractFlowRole | undefined;
	#contact = false;
	next(role: ContractFlowRole): number {
		if (role === 'empty') {
			this.#contact = false;
			return 0;
		}
		const previous = this.#previous;
		const extraGap = previous === 'title' ? CONTRACT_FORMAT.titleExtraGapAfter : 0;
		const continuesContact = this.#contact && role === 'contact';
		this.#contact = role === 'contact-start' || continuesContact;
		this.#previous = role === 'contact' && !continuesContact ? 'body' : role;
		if (!previous) return 0;
		if ((previous === 'title' && role === 'title') || continuesContact) return extraGap;
		if (previous === 'heading') return CONTRACT_FORMAT.headingBodyGap + extraGap;
		if (role === 'heading') return CONTRACT_FORMAT.headingGap + extraGap;
		return CONTRACT_FORMAT.blockGap + extraGap;
	}
}

export const pixelsToTwips = (pixels: number) => pixels * 15;

/** Canonical DOCX semantics shared by the exporter and importer. */
export const CONTRACT_WORD_STYLES = {
	body: 'ContractBody',
	heading: 'ContractHeading',
	title: 'ContractTitle',
	titleHeading: 'ContractTitleH',
	clause: 'ContractClause',
	headingClause: 'ContractHeadingClause',
	section: 'ContractSection',
	headingSection: 'ContractHeadingSection',
	tableGap: 'ContractTableGap',
	emptyBlock: 'ContractEmptyBlock'
} as const;
