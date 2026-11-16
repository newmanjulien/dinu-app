type HintDefinition = {
	text: string;
};

export const hints = {
	contractsIntro: {
		text: 'Create and manage buyer contracts using your company’s template and instructions.'
	},
	firstBuyerLink: {
		text: 'Buyer links appear here. Open one to preview the buyer’s view, or copy it from the contract to share it.'
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
