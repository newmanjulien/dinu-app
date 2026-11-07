type IntegrationLink = Readonly<{ label: string; href: string }>;

type IntegrationDetails = Readonly<{
	kind: 'details';
	tagline: string;
	sections: readonly Readonly<{ key: string; title: string; paragraphs: readonly string[] }>[];
	developer: string;
	category: string;
	website: IntegrationLink;
	documentation: IntegrationLink;
	terms: IntegrationLink;
	privacy: IntegrationLink;
	support: IntegrationLink;
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

const integrationStatusOrder: Record<IntegrationStatus, number> = {
	available: 0,
	installed: 1,
	comingSoon: 2
};

export const integrationActionLabels: Record<IntegrationStatus, string> = {
	available: 'Learn more',
	installed: 'Manage',
	comingSoon: 'Coming soon'
};

/** Shared informational catalog. Array order determines display order within each status group. */
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
						'A workspace admin clicks Install and selects the HubSpot account for the team. Review the requested permissions in HubSpot and approve the connection.',
						'Once installed, every contract needs a HubSpot deal. Choose a deal when creating a contract, or open an existing contract and choose Link a deal before continuing. If its deal is deleted or inaccessible, choose Link another deal inside the contract before editing, reviewing or downloading. Linking a deal renames the contract to match that deal’s name and sends future activity to it. You can still view or delete the contract. Temporary HubSpot outages do not remove its association.'
					]
				},
				{
					key: 'sync',
					title: 'What gets synced',
					paragraphs: [
						'Dinu sends notes for contract creation, applied concessions, approval requests, explicit approvals or declines, and downloads. Admin autoapprovals do not create a separate note. Download notes include the same DOCX when available; files are private in HubSpot.'
					]
				}
			],
			developer: 'Dinu',
			category: 'CRM',
			website: { label: 'hubspot.com', href: 'https://www.hubspot.com/' },
			documentation: { label: 'Read', href: 'https://knowledge.hubspot.com/' },
			terms: { label: 'Read', href: 'https://legal.hubspot.com/terms-of-service' },
			privacy: { label: 'Read', href: 'https://legal.hubspot.com/privacy-policy' },
			support: { label: 'Contact HubSpot', href: 'https://www.hubspot.com/company/contact' }
		}
	},
	{
		slug: 'hubspot-quote',
		name: 'HubSpot Quotes',
		logoPath: '/integrations/hubspot.jpg',
		summary: 'Sign contracts with Hubspot Quotes.',
		content: { kind: 'comingSoon' }
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
	}
];

/** Combine catalog availability with workspace installations, preserving catalog order within groups. */
export function getIntegrationCatalog(
	installedBySlug: Readonly<Record<string, boolean | undefined>>
) {
	return integrations
		.map((integration) => {
			const status: IntegrationStatus =
				integration.content.kind === 'comingSoon'
					? 'comingSoon'
					: installedBySlug[integration.slug]
						? 'installed'
						: 'available';
			return { ...integration, status };
		})
		.sort((a, b) => integrationStatusOrder[a.status] - integrationStatusOrder[b.status]);
}

/** Coming soon and unknown slugs have no detail page. */
export function findIntegrationDetails(slug: string): DetailedIntegration | undefined {
	return integrations.find(
		(entry): entry is DetailedIntegration => entry.slug === slug && entry.content.kind === 'details'
	);
}
