export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PARSER_VERSION = 'docx-3';
export const DOCX_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
export const BASELINE_MAX_BLOCKS = 400;
export const BASELINE_MAX_BYTES = 512 * 1024;
export type ImportIssue = {
	severity: 'warning' | 'error';
	location: string;
	message: string;
	context?: string;
};

export const DOCX_MAX_RETAINED_XML_BYTES = 8 * 1024 * 1024;
export const DOCX_MAX_XML_NODES = 100_000;
export const DOCX_MAX_XML_CHARACTERS = 2_000_000;
