export const contractSettingsFields = {
	name: {
		kind: 'text',
		title: 'Contract name',
		description: 'This is the buyer company name displayed for this contract.',
		footerText: 'Use the company name your team recognizes.'
	},
	danger: {
		kind: 'danger',
		title: 'Delete contract',
		description: 'Permanently remove this contract and its saved choices and document snapshot.',
		footerText: 'This action is not reversible'
	}
} as const;
