import { describeRoute } from '$lib/auth/routes';

export type SupportSection = 'contracts' | 'template' | 'integrations' | 'upload';
export type SupportContext = { section: SupportSection; complete: boolean };
export type SupportContent = {
	headline: [string, string];
	action: string;
	message: string;
	scheduling: string;
	video?: { id: string; title: string };
};

/** Match the visible upload fallback as well as the normal section route. */
export function supportSection(
	routeId: string | null,
	templateReady: boolean
): SupportSection | undefined {
	const route = describeRoute(routeId);
	if (route.document === 'template') return templateReady ? 'template' : 'upload';
	if (route.presentation === 'contracts') return 'contracts';
	if (route.presentation === 'integrations' || route.presentation === 'integration')
		return 'integrations';
	return undefined;
}

const generic: SupportContent = {
	headline: ["We're here", 'to help'],
	action: 'Get support',
	message:
		'Have a question or something blocking you? Book a call and I’ll help you work through it.',
	scheduling: 'Choose a time to talk through your question with me.'
};

// Temporary Blender open movies. Replace these IDs with the section walkthroughs when ready.
const setup: Record<SupportSection, SupportContent> = {
	contracts: {
		headline: ['Get contracts', 'ready'],
		action: 'Contract help',
		message:
			'This is where your team creates, reviews, and negotiates contracts. Watch the video below to get started. If you’d like, book a call and I’ll walk you through your first contract or help prepare one for your team.',
		scheduling:
			'Let’s create a contract together, review your team’s workflow, or let me help get a contract ready to send.',
		video: { id: 'YE7VzlLtp-4', title: 'Big Buck Bunny' }
	},
	template: {
		headline: ['Create your', 'template'],
		action: 'Template help',
		message:
			'Your template and instructions guide how your team negotiates. Watch the video below to see how they fit together. Book a call if you’d like me to walk you through the instructions or help write and configure them.',
		scheduling:
			'Let’s turn your negotiation rules into clear instructions. I can guide you through the editor or help configure the template for your team.',
		video: { id: 'Z4C82eyhwgU', title: 'Caminandes: Gran Dillama' }
	},
	integrations: {
		headline: ['Connect your', 'tools'],
		action: 'Connect tools',
		message:
			'Integrations connect your contract workflow with the tools your team uses. Watch the video below for an introduction. Book a call if you’d like me to walk through the available connections or help set one up with you.',
		scheduling:
			'We can choose the right integration, connect your account together, or check that your contract workflow is working as expected.',
		video: { id: 'SkVqJ1SGeL0', title: 'Caminandes 3: Llamigos' }
	},
	upload: {
		headline: ['Let’s get', 'started'],
		action: 'Upload help',
		message:
			'Welcome! Upload your Word contract here to give your team a starting template. Watch the video below before you begin. If you’d like, book a call and I’ll walk you through the upload and next steps, or help prepare and set up the template for you.',
		scheduling:
			'Bring your Word contract and we’ll get your template ready. I can guide you through uploading it or help with the preparation and setup.',
		video: { id: 'WhWc3b3KhnY', title: 'Spring' }
	}
};

export function supportContent(context: SupportContext): SupportContent {
	return context.complete ? generic : setup[context.section];
}
