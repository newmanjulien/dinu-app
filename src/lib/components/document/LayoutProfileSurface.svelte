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
		readParagraphProfile,
		readParagraphBounds,
		readTableColumns,
		readTableProfile
	} from '$lib/document/pagination/profile-dom';
	import BlockFragment from './BlockFragment.svelte';
	import { CONTRACT_STYLE } from '$lib/contract/format';

	let { surface = $bindable() }: { surface?: LayoutProfileSurface } = $props();
	let element: HTMLDivElement;
	let fragment = $state.raw<PageFragment>();

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
					return profile(block, expected, detail, visit, metrics);
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
		function profile<T>(
			prepared: PreparedBlock,
			expectedEpoch: string,
			detail: GeometryDetail,
			visit: (profile: BlockLayoutProfile, readExact: () => BlockLayoutProfile) => T,
			metrics?: LayoutProfileMetrics
		): T {
			const checkEpoch = () => {
				if (!mounted || document.fonts.status !== 'loaded' || epoch !== expectedEpoch)
					throw new StaleLayoutProfileError();
			};
			checkEpoch();
			let blockReadMs = 0;
			function write(next?: PageFragment) {
				const startedAt = metrics ? performance.now() : 0;
				try {
					flushSync(() => {
						fragment = next;
					});
				} finally {
					if (metrics) metrics.profileDomUpdateMs += performance.now() - startedAt;
				}
			}
			function read<R>(measure: () => R): R {
				const startedAt = metrics ? performance.now() : 0;
				try {
					return measure();
				} finally {
					if (metrics) {
						const elapsed = performance.now() - startedAt;
						metrics.profileReadMs += elapsed;
						blockReadMs += elapsed;
						metrics.maxProfileBlockMs = Math.max(metrics.maxProfileBlockMs, blockReadMs);
					}
				}
			}
			function currentElement(): HTMLElement {
				const current = element.firstElementChild;
				if (!(current instanceof HTMLElement)) throw new Error('Missing profile block.');
				return current;
			}
			try {
				const whole = prepared.fragment;
				write(whole);
				checkEpoch();
				let measured: BlockLayoutProfile;
				if (whole.type === 'table') {
					const table = currentElement();
					if (!(table instanceof HTMLTableElement)) throw new Error('Missing profile table.');
					const fixed = { ...whole, columnWidths: read(() => readTableColumns(table, whole)) };
					write(fixed);
					checkEpoch();
					const canonical = currentElement();
					if (!(canonical instanceof HTMLTableElement))
						throw new Error('Missing fixed profile table.');
					measured = read(() => readTableProfile(canonical, fixed));
				} else {
					const current = currentElement();
					measured = read(
						() =>
							(detail === 'bounds' ? readParagraphBounds(current, whole) : undefined) ??
							readParagraphProfile(current, whole)
					);
				}
				checkEpoch();
				const result = visit(measured, () => {
					checkEpoch();
					if (measured.kind === 'paragraph' && !measured.lines && whole.type === 'paragraph')
						measured = read(() => readParagraphProfile(currentElement(), whole));
					checkEpoch();
					return measured;
				});
				checkEpoch();
				return result;
			} finally {
				write();
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
	class="contract-document pointer-events-none invisible fixed top-0 left-[-100000px] flex h-auto w-(--contract-content-width) flex-col"
	aria-hidden="true"
	inert
	bind:this={element}
	style={CONTRACT_STYLE}
	style:--contract-content-width={`${PAGE_FORMAT.contentWidth}px`}
>
	{#if fragment}
		<BlockFragment {fragment} profileMode />
	{/if}
</div>
