export const instructionsFields = [
	{
		key: 'summary',
		label: 'Summary',
		placeholder: 'Explain what this clause says in plain English'
	},
	{
		key: 'howToExplainToBuyers',
		label: 'How to explain to buyers',
		placeholder: 'Suggest a talk track reps can use to explain this clause to buyers'
	},
	{
		key: 'commonObjections',
		label: 'Common objections',
		placeholder: 'List concerns buyers often raise and how reps should respond'
	},
	{
		key: 'negotiation',
		label: 'How to negotiate',
		placeholder: 'Describe how reps should approach negotiations and where to hold firm'
	}
] as const;

export const approvalGuidanceField = {
	label: 'Changes need to be approved',
	placeholder: 'Specify which changes need approval and who reps should ask'
} as const;
