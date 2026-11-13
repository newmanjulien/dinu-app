<script module lang="ts">
	// Distinct mounts/handles cannot reuse geometry from a departed surface.
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
	import { DOCUMENT_STYLE } from '$lib/document/format';

	let { surface = $bindable() }: { surface?: LayoutProfileSurface } = $props();
	let element: HTMLDivElement;
	let fragment = $state.raw<PageFragment>();

	onMount(() => {
		countStartupWork('profileSurfaceMount');
		recordColdStart('profile-surface-mounted');
		let mounted = true;
		const epoch = `${LAYOUT_EPOCH}:profiles-${epochRevision++}`;
		surface = {
			get epoch() {
				return mounted ? epoch : undefined;
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
		recordColdStart('layout-epoch-ready');
		// Keep this synchronous: pagination may request exact geometry before the measured DOM is cleared.
		function profile<T>(
			prepared: PreparedBlock,
			expectedEpoch: string,
			detail: GeometryDetail,
			visit: (profile: BlockLayoutProfile, readExact: () => BlockLayoutProfile) => T,
			metrics?: LayoutProfileMetrics
		): T {
			const checkEpoch = () => {
				if (!mounted || epoch !== expectedEpoch) throw new StaleLayoutProfileError();
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

		return () => {
			mounted = false;
			surface = undefined;
			recordColdStart('layout-epoch-invalidated-unmount');
		};
	});
</script>

<div
	class="document-content pointer-events-none invisible fixed top-0 left-[-100000px] flex h-auto w-(--document-content-width) flex-col"
	aria-hidden="true"
	inert
	bind:this={element}
	style={DOCUMENT_STYLE}
	style:--document-content-width={`${PAGE_FORMAT.contentWidth}px`}
>
	{#if fragment}
		<BlockFragment {fragment} profileMode />
	{/if}
</div>
