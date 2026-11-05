<script module lang="ts">
	// Distinct mounts/handles cannot accidentally reuse a cache from fonts-0 of an old surface.
	let epochRevision = 0;
</script>

<script lang="ts">
	import { countStartupWork, recordColdStart } from '$lib/document/runtime/render-perf';
	import { flushSync, onMount } from 'svelte';
	import '$lib/styles/document.css';
	import { LAYOUT_EPOCH, PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import type { PageFragment } from '$lib/document/pagination/types';
	import type { PreparedBlock } from '$lib/document/pagination/prepare';
	import type { BlockLayoutProfile, GeometryDetail } from '$lib/document/pagination/profile';
	import {
		StaleLayoutProfileError,
		type LayoutProfileMetrics,
		type LayoutProfileSurface
	} from '$lib/document/pagination/profiler';
	import {
		readHeadingProfile,
		readParagraphProfile,
		readParagraphBounds,
		readTableColumns,
		readTableProfile
	} from '$lib/document/pagination/profile-dom';
	import BlockFragment from './BlockFragment.svelte';

	let { surface = $bindable() }: { surface?: LayoutProfileSurface } = $props();
	let element: HTMLDivElement;
	let fragments = $state.raw<readonly PageFragment[]>([]);
	const ignoreAnnotationSelect = () => {};

	onMount(() => {
		countStartupWork('profileSurfaceMount');
		recordColdStart('profile-surface-mounted');
		let mounted = true;
		let epoch: string | undefined;
		function publish() {
			// Font completion events and fonts.ready can report the same settled cycle.
			if (!mounted || document.fonts.status !== 'loaded' || epoch !== undefined) return;
			recordColdStart('fonts-ready');
			recordColdStart('layout-epoch-ready');
			epoch = `${LAYOUT_EPOCH}:profiles-${epochRevision++}`;
			surface = {
				get epoch() {
					return mounted && document.fonts.status === 'loaded' ? epoch : undefined;
				},
				withBlock<T>(
					block: PreparedBlock,
					expected: string,
					detail: GeometryDetail,
					visit: (profile: BlockLayoutProfile, readExact: () => BlockLayoutProfile) => T,
					metrics?: LayoutProfileMetrics
				): T {
					let result!: T;
					profile([block], expected, metrics, detail, (measured, exact) => {
						result = visit(measured, exact);
					});
					return result;
				}
			};
		}
		function invalidate() {
			recordColdStart(
				mounted ? 'layout-epoch-invalidated-fonts' : 'layout-epoch-invalidated-unmount'
			);
			epoch = undefined;
			surface = undefined;
		}
		function profile(
			blocks: readonly PreparedBlock[],
			expectedEpoch: string,
			metrics?: LayoutProfileMetrics,
			detail: GeometryDetail = 'exact',
			visit?: (profile: BlockLayoutProfile, readExact: () => BlockLayoutProfile) => void
		) {
			const checkEpoch = () => {
				if (!mounted || document.fonts.status !== 'loaded' || epoch !== expectedEpoch)
					throw new StaleLayoutProfileError();
			};
			checkEpoch();
			const blockReadMs = metrics ? blocks.map(() => 0) : [];
			function write(next: readonly PageFragment[]) {
				const startedAt = metrics ? performance.now() : 0;
				try {
					flushSync(() => {
						fragments = next;
					});
				} finally {
					if (metrics) metrics.profileDomUpdateMs += performance.now() - startedAt;
				}
			}
			function read(index: number, measure: () => void) {
				const startedAt = metrics ? performance.now() : 0;
				try {
					measure();
				} finally {
					if (metrics) {
						const elapsed = performance.now() - startedAt;
						metrics.profileReadMs += elapsed;
						blockReadMs[index] += elapsed;
						metrics.maxProfileBlockMs = Math.max(metrics.maxProfileBlockMs, blockReadMs[index]);
					}
				}
			}
			try {
				write(blocks.map((block) => block.fragment));
				checkEpoch();
				const elements = [...element.children];
				if (elements.length !== blocks.length) throw new Error('Missing profile batch elements.');
				const profiles: BlockLayoutProfile[] = [];
				const fixed = [...fragments];
				let hasTables = false;
				// All first-pass reads follow one batch write, with no writes in this loop.
				fragments.forEach((fragment, i) => {
					read(i, () => {
						const block = elements[i];
						if (!(block instanceof HTMLElement)) throw new Error('Missing profile block.');
						if (fragment.type === 'table') {
							if (!(block instanceof HTMLTableElement)) throw new Error('Missing profile table.');
							fixed[i] = { ...fragment, columnWidths: readTableColumns(block, fragment) };
							hasTables = true;
						} else
							profiles[i] =
								fragment.type === 'heading'
									? readHeadingProfile(block, fragment)
									: ((detail === 'bounds' ? readParagraphBounds(block, fragment) : undefined) ??
										readParagraphProfile(block, fragment));
					});
				});
				if (hasTables) {
					// Canonicalize all tables together. Pagination never requests a row slice.
					write(fixed);
					checkEpoch();
					fixed.forEach((fragment, i) => {
						if (fragment.type !== 'table') return;
						read(i, () => {
							const table = element.children[i];
							if (!(table instanceof HTMLTableElement))
								throw new Error('Missing fixed profile table.');
							profiles[i] = readTableProfile(table, fragment);
						});
					});
				}
				checkEpoch();
				visit?.(profiles[0], () => {
					if (profiles[0].kind !== 'paragraph' || profiles[0].lines) return profiles[0];
					checkEpoch();
					const block = element.children[0];
					const fragment = fragments[0];
					if (!(block instanceof HTMLElement) || fragment.type !== 'paragraph')
						throw new Error('Missing scoped paragraph.');
					read(0, () => {
						profiles[0] = readParagraphProfile(block, fragment);
					});
					return profiles[0];
				});
				checkEpoch();
				return { epoch: expectedEpoch, profiles };
			} finally {
				// Release content and its hidden DOM after all reads, including failed batches.
				write([]);
			}
		}
		// Never publish fallback-font geometry as a ready epoch. A live getter also
		// invalidates retained handles before a queued result can enter the cache.
		void document.fonts.ready.then(publish);
		document.fonts.addEventListener('loading', invalidate);
		document.fonts.addEventListener('loadingdone', publish);
		document.fonts.addEventListener('loadingerror', publish);
		return () => {
			mounted = false;
			invalidate();
			document.fonts.removeEventListener('loading', invalidate);
			document.fonts.removeEventListener('loadingdone', publish);
			document.fonts.removeEventListener('loadingerror', publish);
		};
	});
</script>

<div
	class="layout-profile-surface contract-document contract-flow"
	aria-hidden="true"
	inert
	bind:this={element}
	style:--contract-content-width={`${PAGE_FORMAT.contentWidth}px`}
>
	{#each fragments as fragment}
		<BlockFragment
			{fragment}
			profileMode
			selectedAnnotationId={null}
			canOpenPlaybookItems={false}
			onAnnotationSelect={ignoreAnnotationSelect}
		/>
	{/each}
</div>
