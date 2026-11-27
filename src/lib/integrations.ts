export type IntegrationScreenshot = Readonly<{
	src: string;
	alt: string;
	width: number;
	height: number;
}>;

type IntegrationDetails = Readonly<{
	kind: 'details';
	tagline: string;
	screenshots: readonly IntegrationScreenshot[];
	sections: readonly Readonly<{ key: string; title: string; paragraphs: readonly string[] }>[];
}>;

type IntegrationEntry = Readonly<{
	slug: string;
	name: string;
	logoPath: string;
	summary: string;
	content: Readonly<{ kind: 'comingSoon' }> | IntegrationDetails;
}>;

type DetailedIntegration = IntegrationEntry & Readonly<{ content: IntegrationDetails }>;

export type IntegrationStatus = 'available' | 'installed' | 'comingSoon';

export const integrationActionLabels: Record<IntegrationStatus, string> = {
	available: 'Learn more',
	installed: 'Manage',
	comingSoon: 'Coming soon'
};

/** Shared informational catalog. Array order determines display order regardless of status. */
export const integrations: readonly IntegrationEntry[] = [
	{
		slug: 'hubspot',
		name: 'HubSpot',
		logoPath: '/integrations/hubspot.jpg',
		summary: 'Keep Hubspot as your source of truth.',
		content: {
			kind: 'details',
			tagline:
				'Keep HubSpot as your source of truth, from the first conversation to the signed contract.',
			screenshots: [
				{
					src: '/integrations/screenshots/link-deal.svg',
					alt: 'Sample screen showing a HubSpot deal being linked to a new contract.',
					width: 1200,
					height: 750
				},
				{
					src: '/integrations/screenshots/deal-activity.svg',
					alt: 'Sample screen showing contract activity on a HubSpot deal timeline.',
					width: 1200,
					height: 750
				}
			],
			sections: [
				{
					key: 'overview',
					title: 'Overview',
					paragraphs: [
						'Choose a HubSpot deal when you create a contract. Dinu uses the deal’s name as the contract name. Linking an existing contract or choosing a replacement deal renames the contract to match the selected deal’s name. Future contract activity syncs to the selected deal.',
						'Contract creation, concession applications, approval requests, approval decisions and downloads appear as notes on the deal timeline.'
					]
				},
				{
					key: 'instructions',
					title: 'Instructions',
					paragraphs: [
						'A workspace admin clicks Install and selects the HubSpot account for the team. Review the requested permissions in HubSpot and approve the connection. An admin can uninstall HubSpot from this page at any time, including when it needs reconnecting.',
						'Once installed, every contract needs a HubSpot deal. Choose a deal when creating a contract, or open an existing contract and choose Link a deal before continuing. If its deal is deleted or inaccessible, choose Link another deal inside the contract before editing, reviewing or downloading. Linking a deal renames the contract to match that deal’s name and sends future activity to it. You can still view or delete the contract. Temporary HubSpot outages do not remove its association.',
						'Uninstalling stops syncing for the whole workspace and restores manual contract creation. Your contracts, drafts and approvals stay, and activity already sent to HubSpot is retained. Queued activity is not replayed after reinstalling; link deals explicitly to start sending future activity. If another workspace uses the same HubSpot account, Dinu disconnects only this workspace.'
					]
				},
				{
					key: 'sync',
					title: 'What gets synced',
					paragraphs: [
						'Dinu sends notes for contract creation, applied concessions, approval requests, explicit approvals or declines, and downloads. Admin autoapprovals do not create a separate note. Download notes include the same DOCX when available; files are private in HubSpot.'
					]
				}
			]
		}
	},
	{
		slug: 'hubspot-quote',
		name: 'HubSpot Quotes',
		logoPath: '/integrations/hubspot.jpg',
		summary: 'Get contracts signed with Hubspot.',
		content: {
			kind: 'details',
			tagline: 'Negotiate your contract in Dinu, then finish and send the quote in HubSpot.',
			screenshots: [
				{
					src: '/integrations/screenshots/draft-quote.svg',
					alt: 'Sample screen showing a Dinu contract in the Terms of a draft HubSpot quote.',
					width: 1200,
					height: 750
				},
				{
					src: '/integrations/screenshots/link-deal.svg',
					alt: 'Sample screen showing the HubSpot deal used to create a contract and quote.',
					width: 1200,
					height: 750
				}
			],
			sections: [
				{
					key: 'overview',
					title: 'Overview',
					paragraphs: [
						'Push to HubSpot creates a native draft quote linked to your contract’s HubSpot deal. The complete saved contract, including approved concessions, appears in the quote’s Terms. No DOCX is uploaded and no custom quote template is needed.',
						'HubSpot handles pricing, line items, recipients, signatures, payments and publishing. Review the contract and complete those details in HubSpot before sending the quote.'
					]
				},
				{
					key: 'instructions',
					title: 'Instructions',
					paragraphs: [
						'Connect the normal HubSpot integration first. A workspace admin then clicks Install here and approves Quotes access for the same HubSpot account. Revenue Hub Professional or Enterprise is required; quote editors also need a Revenue Hub seat and the relevant HubSpot permissions. Account eligibility is checked on the first push.',
						'Open a contract linked to an available deal, save your changes and obtain any required concession approvals. Push to HubSpot replaces Download as .docx. Open the resulting draft to review its Terms and complete the quote in HubSpot. Drafts initially expire after 30 days; you can change this in HubSpot.',
						'Pushing the same contract content to the same deal opens the existing quote. Changed contract content or a different deal creates a new draft. Dinu preserves changes made inside HubSpot. HubSpot limits Terms to 65,536 characters, including HTML formatting; oversized contracts are stopped before sending.'
					]
				},
				{
					key: 'uninstall',
					title: 'Uninstalling',
					paragraphs: [
						'Uninstall HubSpot Quotes from this page to restore DOCX downloads for everyone in this workspace. Your normal HubSpot integration, deal links, contracts and approvals stay. Existing quotes stay in HubSpot. A push already being sent may still finish.',
						'Uninstalling the normal HubSpot integration also disables HubSpot Quotes in this workspace.'
					]
				}
			]
		}
	},
	{
		slug: 'gong',
		name: 'Gong',
		logoPath: '/integrations/gong.png',
		summary: 'Add contract activity to heat maps.',
		content: { kind: 'comingSoon' }
	},
	{
		slug: 'salesforce',
		name: 'Salesforce',
		logoPath: '/integrations/salesforce.svg',
		summary: 'Keep Salesforce as your source of truth.',
		content: { kind: 'comingSoon' }
	},
	{
		slug: 'hubspot-contracts',
		name: 'HubSpot Contracts',
		logoPath: '/integrations/hubspot.jpg',
		summary: 'Sign contracts with Hubspot Contracts.',
		content: { kind: 'comingSoon' }
	},
	{
		slug: 'docusign',
		name: 'DocuSign',
		logoPath: '/integrations/docusign.png',
		summary: 'Send contracts for signature with DocuSign.',
		content: { kind: 'comingSoon' }
	},
	{
		slug: 'ironclad',
		name: 'Ironclad',
		logoPath: '/integrations/ironclad.png',
		summary: 'Manage contract workflows with Ironclad.',
		content: { kind: 'comingSoon' }
	}
];

/** Combine catalog availability with workspace installations, preserving catalog order. */
export function getIntegrationCatalog(
	installedBySlug: Readonly<Record<string, boolean | undefined>>
) {
	return integrations.map((integration) => {
		const status: IntegrationStatus =
			integration.content.kind === 'comingSoon'
				? 'comingSoon'
				: installedBySlug[integration.slug]
					? 'installed'
					: 'available';
		return { ...integration, status };
	});
}

/** Coming soon and unknown slugs have no detail page. */
export function findIntegrationDetails(slug: string): DetailedIntegration | undefined {
	return integrations.find(
		(entry): entry is DetailedIntegration => entry.slug === slug && entry.content.kind === 'details'
	);
}
