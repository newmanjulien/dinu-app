/** CSS pixels are the canonical units for screen and Word document formatting. */
export const DOCUMENT_FORMAT = {
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

export const DOCUMENT_STYLE = [
	`--document-font:${DOCUMENT_FORMAT.font},Helvetica,sans-serif`,
	`--document-font-size:${DOCUMENT_FORMAT.fontSize}px`,
	`--document-heading-font-size:${DOCUMENT_FORMAT.headingFontSize}px`,
	`--document-title-font-size:${DOCUMENT_FORMAT.titleFontSize}px`,
	`--document-line-height:${DOCUMENT_FORMAT.lineHeight}px`,
	`--document-title-line-height:${DOCUMENT_FORMAT.titleLineHeight}px`
].join(';');

export type DocumentFlowRole = 'title' | 'heading' | 'contact-start' | 'contact' | 'body' | 'empty';

/** Layout hints only: source text, blocks, and selection coordinates stay intact. */
export function documentFlowRole(block: {
	kind: 'paragraph' | 'table';
	role?: import('./source-model').ParagraphRole;
	content?: string;
}): DocumentFlowRole {
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
export class DocumentSpacing {
	#previous: DocumentFlowRole | undefined;
	#contact = false;
	next(role: DocumentFlowRole): number {
		if (role === 'empty') {
			this.#contact = false;
			return 0;
		}
		const previous = this.#previous;
		const extraGap = previous === 'title' ? DOCUMENT_FORMAT.titleExtraGapAfter : 0;
		const continuesContact = this.#contact && role === 'contact';
		this.#contact = role === 'contact-start' || continuesContact;
		this.#previous = role === 'contact' && !continuesContact ? 'body' : role;
		if (!previous) return 0;
		if ((previous === 'title' && role === 'title') || continuesContact) return extraGap;
		if (previous === 'heading') return DOCUMENT_FORMAT.headingBodyGap + extraGap;
		if (role === 'heading') return DOCUMENT_FORMAT.headingGap + extraGap;
		return DOCUMENT_FORMAT.blockGap + extraGap;
	}
}

export const pixelsToTwips = (pixels: number) => pixels * 15;

/** Canonical DOCX semantics shared by the exporter and importer. */
export const DOCUMENT_WORD_STYLES = {
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
