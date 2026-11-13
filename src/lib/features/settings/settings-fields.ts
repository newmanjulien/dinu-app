export const settingsFields = {
	name: {
		id: 'name',
		kind: 'text',
		title: 'Your name',
		description: 'This is your visible name in Dinu.',
		footerText: "We display your email if you don't provide a name."
	},
	email: {
		id: 'email',
		kind: 'readonly',
		title: 'Sign-in email',
		description: 'This is the email address you use to sign in to Dinu.',
		footerText: 'You cannot change this email.'
	},
	companyName: {
		id: 'companyName',
		kind: 'text',
		title: 'Company name',
		description: "This is your company's visible name in Dinu.",
		footerText: 'Use the company or department name your team recognizes.'
	},
	approvalEmail: {
		id: 'approvalEmail',
		kind: 'text',
		title: 'Approval email',
		description: 'Contract approval requests are sent to this address.',
		footerText: "Defaults to the company creator's email. You can change the recipient here."
	},
	role: {
		id: 'role',
		kind: 'text',
		title: 'Your role',
		description:
			'Choose Rep or Admin for yourself. Admins can manage company settings and colleagues.',
		footerText: 'You can change your role at any time.'
	},
	avatar: {
		id: 'avatar',
		kind: 'avatar',
		title: 'Your avatar',
		description: 'This is your personal avatar.',
		footerText: 'An avatar is optional but helps team members recognize you.'
	},
	companyAvatar: {
		id: 'companyAvatar',
		kind: 'avatar',
		title: 'Company avatar',
		description: "This is your company's avatar.",
		footerText: 'An avatar is optional.'
	},
	danger: {
		id: 'danger',
		kind: 'danger',
		warning:
			'If you are the last member, deleting your account also deletes your company and all its data.',
		title: 'Delete account',
		description: 'Permanently remove your account',
		footerText: 'This action is not reversible'
	}
} as const;
export type SettingsField = (typeof settingsFields)[keyof typeof settingsFields];
