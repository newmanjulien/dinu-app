type HintDefinition = {
	text: string;
	visitLimit?: number;
};

export const hints = {
	integrationsIntro: {
		text: 'Integrations connect Dinu with the tools your team already uses, helping keep contract details and activity in sync.',
		visitLimit: 3
	},
	contractsIntro: {
		text: 'Contracts are where your team prepares and manages customer agreements using your company’s baseline contract and instructions.'
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
