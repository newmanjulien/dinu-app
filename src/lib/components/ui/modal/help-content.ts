export type HelpVariant = 'rep' | 'template' | 'buyer-template' | 'buyer';

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
	buyer: {
		title: 'How to review this contract',
		intro: 'Dinu helps you read this contract and understand its key terms.',
		steps: [
			{
				title: 'Understand a clause',
				highlight: { text: 'Green clauses have explanations.', color: 'green' },
				description:
					'Green clauses have explanations. Select one to read a plain English explanation.'
			},
			{
				title: 'Ask questions',
				description: 'Add a comment to ask questions about the contract.'
			},
			{
				title: 'Get answers',
				description: 'The rep who sent you the contract will see your comments and answer.'
			}
		]
	},
	rep: {
		title: 'How buyer links work',
		intro: 'Buyer links let you exchange comments with your buyer.',
		steps: [
			{
				title: 'Leave a comment',
				highlight: { text: 'Highlight a clause', color: 'blue' },
				description: 'Highlight a clause to leave a comment for the buyer.'
			},
			{
				title: 'Buyers answer',
				description: 'Buyers can see you comments, answer and leave their own comments.'
			},
			{
				title: 'Buyers propose changes',
				description: 'You can get changes approved with 1 click if buyers propose them.'
			}
		]
	},
	'buyer-template': {
		title: 'Add and edit buyer explanations',
		intro: 'Help buyers understand your contract with explanations written just for them.',
		steps: [
			{
				title: 'Select template wording',
				description: 'Select the text you want to explain to buyers.'
			},
			{
				title: 'Write an explanation',
				highlight: { text: 'Green clauses have explanations.', color: 'green' },
				description:
					'Choose Add explanation, write your explanation, then Save. Green clauses have explanations. Select one to edit it.'
			},
			{
				title: 'Start from rep wording',
				description:
					'Copy rep summary copies the full saved rep Summary when your selection is inside a rep clause with a summary. Edit and save the copy for buyers. Rep instructions and buyer explanations stay independent.'
			}
		]
	},
	template: {
		title: 'Add and edit instructions',
		intro: 'Add summaries, negotiation guidance, and approved concessions for your reps.',
		steps: [
			{
				title: 'Select template wording',
				highlight: { text: 'Select the text', color: 'blue' },
				description: 'Select the text your reps need help understanding or negotiating.'
			},
			{
				title: 'Explain in plain English',
				description:
					'Add instructions lets you add a plain English summary so reps understand what the template says.'
			},
			{
				title: 'Let reps make concessions',
				description:
					'Add concession lets you set up changes reps can make and lets you specify when they need approval.'
			}
		]
	}
} satisfies Record<HelpVariant, HelpContent>;
