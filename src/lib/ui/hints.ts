type HintDefinition = {
	text: string;
	visitLimit?: number;
};

export const hints = {
	contractsIntro: {
		text: 'Create and manage buyer contracts using your company’s template and instructions.'
	},
	concessionAutoApproved: {
		text: "You've auto-approved this concession yourself"
	},
	concessionApprovalRequired: {
		text: 'This concession will stay pending until you request and get approval'
	},
	concessionWithinAuthority: {
		text: 'You have the authority to make this concession without approval'
	}
} satisfies Record<string, HintDefinition>;

export type HintId = keyof typeof hints;

export function hintVisitLimit(id: HintId): number | undefined {
	const hint: HintDefinition = hints[id];
	return hint.visitLimit;
}
