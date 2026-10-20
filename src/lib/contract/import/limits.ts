export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
export const BASELINE_MAX_BLOCKS = 400;
export const BASELINE_MAX_BYTES = 512 * 1024;
export type ImportIssue = {
	severity: 'warning' | 'error';
	location: string;
	message: string;
	context?: string;
};
