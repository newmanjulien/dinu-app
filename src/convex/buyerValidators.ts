import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { contractChange, textTrigger, trigger } from '../lib/playbook/validators';

/** Small derived pointer, auto-synced when 0 pending & 0 rejected concessions. */
export const buyerCurrentView = v.object({
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	buyerName: v.union(v.string(), v.null()),
	buyerRefreshable: v.boolean(),
	concessions: v.record(v.id('playbookItems'), v.string()),
	contentRevision: v.number(),
	displayIdentity: v.string()
});

export const buyerLink = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	creatorId: v.id('profiles'),
	token: v.string(),
	createdAt: v.number(),
	currentView: v.union(buyerCurrentView, v.null())
});

export const buyerExplanation = v.object({
	itemId: v.id('playbookItems'),
	trigger: textTrigger,
	explanation: v.string()
});

/** Only applied concession changes — never unapplied alternatives or internal rep notes. */
export const appliedOverlay = v.object({
	itemId: v.id('playbookItems'),
	trigger,
	concessions: v.array(
		v.object({
			id: v.string(),
			changes: v.array(contractChange)
		})
	)
});

/** Immutable template payload fetched once per templateVersionId on a buyer link. */
export const buyerTemplateContent = v.object({
	templateVersionId: v.id('templateVersions'),
	blocks: v.array(sourceBlock),
	explanations: v.array(buyerExplanation)
});

/** Small reactive state pushed to a buyer link when title or approved concessions change. */
export const buyerDocumentState = v.union(
	v.object({ kind: v.literal('unavailable') }),
	v.object({
		kind: v.literal('current'),
		companyName: v.string(),
		buyerName: v.union(v.string(), v.null()),
		buyerRefreshable: v.boolean(),
		templateVersionId: v.id('templateVersions'),
		title: v.string(),
		contentRevision: v.number(),
		displayIdentity: v.string(),
		concessions: v.record(v.id('playbookItems'), v.string()),
		appliedOverlays: v.array(appliedOverlay)
	})
);

/** One authorized acquisition for a buyer Word download. */
export const buyerDownloadSnapshot = v.union(
	v.object({
		kind: v.literal('ready'),
		title: v.string(),
		blocks: v.array(sourceBlock),
		concessions: v.record(v.id('playbookItems'), v.string()),
		appliedOverlays: v.array(appliedOverlay)
	}),
	v.object({ kind: v.literal('too-large') })
);

export const linkCapture = v.object({
	id: v.id('buyerLinks'),
	token: v.string(),
	createdAt: v.number(),
	created: v.boolean()
});
