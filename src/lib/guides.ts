import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
import BookOpenIcon from 'phosphor-svelte/lib/BookOpenIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnectedIcon';

export const adminGuides = [
	{
		title: 'Build a template your team can rely on',
		description:
			'Start with your standard contract and turn it into a clear, consistent starting point for every conversation with a buyer.',
		icons: [FileTextIcon, CheckCircleIcon],
		labels: ['Your template', 'Ready for the team']
	},
	{
		title: 'Turn negotiation know-how into practical guidance',
		description:
			'Give reps the context, approved alternatives, and clear instructions they need to move negotiations forward with confidence.',
		icons: [BookOpenIcon, ChatCircleIcon],
		labels: ['Team knowledge', 'Better conversations']
	},
	{
		title: 'Get your team ready for their first contract',
		description:
			'Invite colleagues, choose the right roles, and walk through a sample contract together before the first buyer conversation.',
		icons: [UsersIcon, FileTextIcon],
		labels: ['Your team', 'One shared starting point']
	},
	{
		title: 'Connect the tools your team already uses',
		description:
			'Explore integrations and bring your contract workflow closer to the systems your team works in every day.',
		icons: [PlugsConnectedIcon, CheckCircleIcon],
		labels: ['Your tools', 'Working together']
	}
];
export const repGuides = [
	{
		title: 'From a fresh contract to your first buyer conversation',
		description:
			'Find your starting point, review your team’s instructions, and prepare a contract that is ready to share with your buyer.',
		icons: [FileTextIcon, ChatCircleIcon],
		labels: ['Your contract', 'The conversation']
	},
	{
		title: 'Find the right response to a buyer’s request',
		description:
			'Use your team’s guidance to understand common clauses, explore approved alternatives, and know when to ask for help.',
		icons: [BookOpenIcon, CheckCircleIcon],
		labels: ['Team guidance', 'A clear next step']
	},
	{
		title: 'Share your contract with confidence',
		description:
			'Prepare the version you want your buyer to review, create a buyer link, and keep the conversation moving.',
		icons: [FileTextIcon, LinkIcon],
		labels: ['Ready to review', 'Ready to share']
	},
	{
		title: 'Make the most of your next negotiation call',
		description:
			'Prepare your questions, understand your buyer’s priorities, and bring the right context to your team when a decision needs approval.',
		icons: [ChatCircleIcon, UsersIcon],
		labels: ['Buyer priorities', 'Team decisions']
	}
];
