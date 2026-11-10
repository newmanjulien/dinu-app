export const EMAIL_MAX_LENGTH = 254;

/** One plain mailbox, with the same identity at storage and provider boundaries. */
export function normalizedEmailAddress(input: string): string | null {
	const email = input.trim().toLowerCase();
	const [local, domain, extra] = email.split('@');
	if (
		email.length > EMAIL_MAX_LENGTH ||
		!local ||
		local.length > 64 ||
		!domain ||
		extra !== undefined ||
		!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
		!domain.includes('.') ||
		domain
			.split('.')
			.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
	)
		return null;
	return email;
}
