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
		intro: 'Dinu helps sales reps understand, negotiate and close sales contracts on their own.',
		steps: [
			{
				title: 'Open a clause',
				highlight: { text: 'Green clauses have details.', color: 'green' },
				description: 'Green clauses have details. Click to open up an explanation of the clause.'
			},
			{
				title: 'Understand the clause',
				description:
					'Highlighted contract language opens instructions, negotiation alternatives, or both.'
			},
			{
				title: 'Negotiate the clause',
				description: 'Some clauses include information on how to negotiate the clause with buyers.',
				adminNote: 'Concessions you apply are automatically approved because you’re an admin.'
			}
		]
	},
	admin: {
		title: 'Add and edit',
		intro:
			'Help your reps understand and negotiate your contract by adding and editing instructions.',
		steps: [
			{
				title: 'Select text',
				description: 'Use your cursor to select the clause you want to explain.',
				highlight: { text: 'select the clause', color: 'blue' }
			},
			{
				title: 'Add instructions',
				description: 'Write your explanation or negotiation advice and save it.'
			},
			{
				title: 'Open or edit instructions',
				description:
					'Saved clauses appear green. Reps click them to read instructions. You click them to edit it.',
				highlight: { text: 'Saved clauses', color: 'green' }
			}
		]
	}
} satisfies Record<HelpVariant, HelpContent>;
