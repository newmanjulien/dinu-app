type ClerkErrorLike = {
	code?: string;
	longMessage?: string;
	message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getStringProperty(value: Record<string, unknown>, key: string) {
	const property = value[key];
	return typeof property === 'string' ? property : undefined;
}

function getClerkErrorLike(value: unknown): ClerkErrorLike | null {
	if (!isRecord(value)) return null;
	return {
		code: getStringProperty(value, 'code'),
		longMessage: getStringProperty(value, 'longMessage'),
		message: getStringProperty(value, 'message')
	};
}

function getClerkErrors(error: unknown) {
	if (!isRecord(error) || !Array.isArray(error.errors)) return [];
	return error.errors.map(getClerkErrorLike).filter((clerkError) => clerkError !== null);
}

export function isAccountDeletedError(error: unknown): boolean {
	if (!isRecord(error) || !isRecord(error.data)) return false;
	return error.data.code === 'account-deleted';
}

export function getErrorMessage(error: unknown, fallback: string) {
	if (isRecord(error)) {
		if (typeof error.data === 'string') return error.data;
		if (isRecord(error.data) && typeof error.data.message === 'string') return error.data.message;
	}
	const clerkError = getClerkErrors(error)[0];
	const topLevelError = getClerkErrorLike(error);

	return (
		clerkError?.longMessage ??
		clerkError?.message ??
		topLevelError?.longMessage ??
		topLevelError?.message ??
		(error instanceof Error ? error.message : fallback)
	);
}
