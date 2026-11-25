export type TemplateHelpVariant = 'template' | 'buyer-template';
export type WorkspaceHelpVariant = 'contract' | TemplateHelpVariant;
export type BuyerLinkHelpVariant = 'buyer-link-seller' | 'buyer-link-buyer';
export type HelpVariant = WorkspaceHelpVariant | BuyerLinkHelpVariant;

export type HelpContent = {
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
	'buyer-link-buyer': {
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
	'buyer-link-seller': {
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
				description: 'Buyers can see your comments, answer and leave their own comments.'
			}
		]
	},
	contract: {
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
				description:
					'Select the text your reps need help understanding or negotiating, or drag a gap between paragraphs to add guidance or a new clause there.'
			},
			{
				title: 'Add instructions and guidance',
				description:
					'Choose Add instructions to add a plain English summary, talk tracks, objection handling, negotiation tips, and approval rules.'
			},
			{
				title: 'Include approved concessions',
				description:
					'Open Preferred concessions or Rare concessions inside the instructions box to add pre-approved changes reps can apply, then Save.'
			}
		]
	}
} satisfies Record<HelpVariant, HelpContent>;
