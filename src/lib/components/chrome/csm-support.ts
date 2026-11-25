import { describeRoute } from '$lib/auth/routes';
import type { EmbeddedVideo } from '$lib/ui/video.svelte';
import { walkthroughVideos } from '$lib/videos';

export type SupportSection = 'contracts' | 'integrations';
export type SupportContext = { section: SupportSection; complete: boolean };
export type SupportContent = {
	headline: [string, string];
	action: string;
	scheduling: string;
	video?: EmbeddedVideo;
};

export function supportSection(routeId: string | null): SupportSection | undefined {
	const route = describeRoute(routeId);
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

const setup: Record<SupportSection, SupportContent> = {
	contracts: {
		headline: ['Contracts', 'guide'],
		action: 'Get support',
		scheduling:
			"Do you need help sending or managing your contracts? Book a call with our team and we'll be glad to help.",
		video: walkthroughVideos.contracts
	},
	integrations: {
		headline: ['Integrations', 'guide'],
		action: 'Get support',
		scheduling:
			"Do you have questions about integrations? Or do you need help connecting your tools? Book a call with our team and we'll be glad to help.",
		video: walkthroughVideos.integrations
	}
};

export function supportContent(context: SupportContext): SupportContent {
	return context.complete ? generic : setup[context.section];
}
