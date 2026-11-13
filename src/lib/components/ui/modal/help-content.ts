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
				title: 'Find what you need',
				description: 'Use Search to find words or phrases in the contract.'
			},
			{
				title: 'Discuss next steps',
				description:
					'Leave comments or propose changes on the contract. Word downloads always contain the latest published contract.'
			}
		]
	},
	rep: {
		title: 'How Dinu works',
		intro: 'Dinu helps you understand, negotiate and close sales contracts.',
		steps: [
			{
				title: 'Open a clause',
				highlight: { text: 'Blue clauses have instructions.', color: 'blue' },
				description:
					'Blue clauses have instructions. Select one to read the instructions for that clause.'
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
			},
			{
				title: 'Publish approved wording',
				description:
					'Open the buyer link as a seller and choose Publish to buyer once every submitted change is approved. Each publication creates a version. Downloads and HubSpot use the latest published version.'
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
