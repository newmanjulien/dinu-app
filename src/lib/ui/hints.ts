type HintDefinition = {
	text: string;
	visitLimit?: number;
};

export const hints = {
	contractsIntro: {
		text: 'Create and manage buyer contracts using your company’s template and instructions.'
	},
	concessionAutoApproved: {
		text: 'This option applies immediately to the current contract.'
	},
	concessionApprovalRequired: {
		text: 'This option stays pending until you submit it for approval and an admin approves it.'
	},
	concessionWithinAuthority: {
		text: 'You have authority to apply this option immediately.'
	}
} satisfies Record<string, HintDefinition>;

export type HintId = keyof typeof hints;

export function hintVisitLimit(id: HintId): number | undefined {
	const hint: HintDefinition = hints[id];
	return hint.visitLimit;
}
