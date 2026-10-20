import { PlaybookValidationError } from '../playbook/validation-error';

/** Shared by browser validation and every persisted source/item write. */
export function validateStorageArrays(value: unknown, depth = 0): void {
	if (depth > 32) throw new PlaybookValidationError('Contract content is nested too deeply.');
	if (Array.isArray(value)) {
		if (value.length > 8192)
			throw new PlaybookValidationError('Contract arrays cannot exceed 8192 entries.');
		for (const entry of value) validateStorageArrays(entry, depth + 1);
	} else if (value && typeof value === 'object') {
		for (const entry of Object.values(value)) validateStorageArrays(entry, depth + 1);
	}
}
