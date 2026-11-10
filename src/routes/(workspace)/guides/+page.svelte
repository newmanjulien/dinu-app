<script lang="ts">
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
	import BookOpenIcon from 'phosphor-svelte/lib/BookOpenIcon';
	import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
	import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnectedIcon';

	const viewer = useViewer();
	const adminGuides = [
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
	const repGuides = [
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
	const guides = $derived(viewer().membership.role === 'admin' ? adminGuides : repGuides);
</script>

<WorkspacePresentationReporter outcome="success" />

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 pt-8 pb-12 text-ink sm:px-6 md:px-8 md:pt-10"
>
	<div class="mx-auto max-w-[61.6rem]">
		<h1 class="mb-6 text-lg font-medium md:mb-7">Guides</h1>
		<div class="grid gap-x-5 gap-y-12 md:grid-cols-2">
			{#each guides as guide, index (guide.title)}
				<article class="min-w-0">
					<div
						class="relative isolate flex aspect-[1.91] items-center justify-center overflow-hidden rounded-xl bg-[#111110]"
						aria-hidden="true"
					>
						<div
							class="absolute inset-0 -z-10 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-size-[30px_30px]"
						></div>
						<div
							class="absolute -inset-x-12 -bottom-20 -z-10 h-36 rounded-[50%] bg-linear-to-r from-amber-600 via-fuchsia-800 to-sky-500 opacity-70 blur-3xl"
							class:hue-rotate-60={index % 2 === 1}
						></div>
						<div class="grid w-2/3 grid-cols-[1fr_minmax(20px,0.8fr)_1fr] items-center">
							{#each guide.icons as Icon, iconIndex}
								{#if iconIndex > 0}<div
										class="h-px bg-linear-to-r from-amber-700/70 via-white/20 to-sky-700/70"
									></div>{/if}
								<div
									class="relative flex aspect-square items-center justify-center rounded-[22%] border border-white/6 bg-linear-to-b from-[#20201f] to-[#191918] shadow-lg"
								>
									<Icon class="size-[42%] text-white/90" weight="light" />
									<span
										class="absolute top-full mt-2.5 w-[160%] text-center text-[10px] text-white/50 sm:text-[11px]"
										>{guide.labels[iconIndex]}</span
									>
								</div>
							{/each}
						</div>
					</div>
					<h2 class="mt-4 text-sm leading-5 font-medium">
						{guide.title}
					</h2>
					<p class="mt-1.5 text-xs leading-5 text-ink-muted">{guide.description}</p>
				</article>
			{/each}
		</div>
	</div>
</main>
