export type HelpVariant = 'rep' | 'admin';

type HelpContent = {
	title: string;
	intro: string;
	steps: {
		title: string;
		description: string;
		adminNote?: string;
		highlight?: { text: string; color: 'blue' | 'green' };
	}[];
};

export const helpContent = {
	rep: {
		title: 'How Dinu works',
		intro: 'Dinu helps you understand, negotiate and close sales contracts.',
		steps: [
			{
				title: 'Open a clause',
				highlight: { text: 'Green clauses have details.', color: 'green' },
				description: 'Green clauses have details. Click to open up an explanation of the clause.'
			},
			{
				title: 'Understand the clause',
				description:
					'Clauses are explained in plain English and include tips for negotiating with buyers.'
			},
			{
				title: 'Negotiate safely',
				description: 'Automatically apply concessions to the clauses you can negotiate.',
				adminNote: 'Concessions are automatically approved because you’re an admin.'
			}
		]
	},
	admin: {
		title: 'Add and edit instructions',
		intro:
			'Help your reps understand and negotiate your contract by adding instructions and approved alternatives.',
		steps: [
			{
				title: 'Select contract wording',
				highlight: { text: 'Select the text', color: 'blue' },
				description: 'Select the text your reps need help understanding or negotiating.'
			},
			{
				title: 'Explain in plain English',
				description:
					'Explain a clause lets you add a plain English description so reps understand what the contract says.'
			},
			{
				title: 'Let reps make concessions',
				description:
					'Add concession lets you set up changes reps can make and lets you specify when they need approval.'
			}
		]
	}
} satisfies Record<HelpVariant, HelpContent>;
