<script lang="ts">
	import type { FocusedPreview } from '$lib/contract/document-preview';
	import type { DocumentChange } from '$lib/document/contract-document';
	import { buildSourceIndex, type SourceIndex } from '$lib/document/source-index';
	import type { SourceBlock } from '$lib/document/source-model';
	import PlaybookText from './PlaybookText.svelte';
	let { preview }: { preview: FocusedPreview } = $props();
	function fragment(
		part: DocumentChange['parts'][number],
		side: 'before' | 'after',
		index: SourceIndex
	) {
		const atomText = (atom: Extract<SourceBlock, { kind: 'paragraph' }>['content'][number]) =>
			atom.kind === 'text' ? atom.text : (index.byKey.get(atom.sourceKey)?.displayText ?? '');
		return part.kind === 'text'
			? part[side].pieces.map((piece) => atomText(piece.atom)).join('')
			: part[side].blocks
					.map((block) =>
						block.kind === 'table'
							? block.rows.map((row) => row.join('\t')).join('\n')
							: block.content.map(atomText).join('')
					)
					.join('\n\n');
	}
	const comparisons = $derived.by(() => {
		const before = buildSourceIndex(preview.approved.blocks),
			after = buildSourceIndex(preview.document.blocks);
		return (
			preview.patch?.parts.map((part) => ({
				before: fragment(part, 'before', before),
				after: fragment(part, 'after', after)
			})) ?? []
		);
	});
</script>

{#if comparisons.length}
	<div class="flex flex-col gap-3 border-t border-edge pt-3" aria-label="Focused change preview">
		{#each comparisons as comparison}
			<div class="flex flex-col gap-1">
				<p class="m-0 text-xs text-ink-muted">Current wording</p>
				<PlaybookText text={comparison.before || 'No wording'} />
				<p class="m-0 mt-2 text-xs text-ink-muted">Proposed wording</p>
				<PlaybookText text={comparison.after || 'Wording removed'} />
			</div>
		{/each}
	</div>
{/if}
