import { describeRoute } from '$lib/auth/routes';
import placeholderPoster from '$lib/assets/support-video-placeholder.svg?no-inline';

export const supportVideoOrigin = 'https://www.youtube-nocookie.com';

export type SupportSection = 'contracts' | 'template' | 'integrations' | 'upload';
export type SupportContext = { section: SupportSection; complete: boolean };
export type SupportContent = {
	headline: [string, string];
	action: string;
	scheduling: string;
	video?: { id: string; title: string; poster: string };
};

/** Match the visible upload fallback as well as the normal section route. */
export function supportSection(
	routeId: string | null,
	templateReady: boolean
): SupportSection | undefined {
	const route = describeRoute(routeId);
	if (route.requiresTemplate && !templateReady) return 'upload';
	if (route.document === 'template') return 'template';
	if (route.presentation === 'contracts' || route.document === 'new') return 'contracts';
	if (route.presentation === 'integrations' || route.presentation === 'integration')
		return 'integrations';
	return undefined;
}

const generic: SupportContent = {
	headline: ["We're here", 'to help'],
	action: 'Get support',
	scheduling: 'Choose a time to talk through your question with me.'
};

// Temporary Blender open movies. Replace these IDs with the section walkthroughs when ready.
const setup: Record<SupportSection, SupportContent> = {
	contracts: {
		headline: ['Contracts', 'guide'],
		action: 'Get support',
		scheduling:
			"Do you need help sending or managing your contracts? Book a call with our team and we'll be glad to help.",
		video: { id: 'YE7VzlLtp-4', title: 'Big Buck Bunny', poster: placeholderPoster }
	},
	template: {
		headline: ['Templates', 'guide'],
		action: 'Get support',
		scheduling:
			"Do you need help sending or managing your contracts? Book a call with our team and we'll be glad to help.",
		video: { id: 'Z4C82eyhwgU', title: 'Caminandes: Gran Dillama', poster: placeholderPoster }
	},
	integrations: {
		headline: ['Integrations', 'guide'],
		action: 'Get support',
		scheduling:
			"Do you have questions about integrations? Or do you need help connecting your tools? Book a call with our team and we'll be glad to help.",
		video: { id: 'SkVqJ1SGeL0', title: 'Caminandes 3: Llamigos', poster: placeholderPoster }
	},
	upload: {
		headline: ['Your first', 'step'],
		action: 'Let us help',
		scheduling:
			"The last step to get you up and running is to set up your company's contract template. Book a call with our team and we'll take care of everything.",
		video: { id: 'WhWc3b3KhnY', title: 'Spring', poster: placeholderPoster }
	}
};

export function supportContent(context: SupportContext): SupportContent {
	return context.complete ? generic : setup[context.section];
}
