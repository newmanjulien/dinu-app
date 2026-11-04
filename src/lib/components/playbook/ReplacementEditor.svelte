<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		createReferenceRecognizer,
		recognizeReplacementContent,
		type RecognizedReference
	} from '$lib/contract/reference-recognition';
	import type { ReferenceCatalog } from '$lib/contract/reference-catalog';
	import type { ReplacementAtom } from '$lib/contract/source-model';
	import { referenceText } from '$lib/contract/numbering';
	import {
		sameReplacementAtoms,
		type ReplacementAtomValue
	} from '$lib/contract/replacement-content';
	import type { DeepReadonly } from '$lib/playbook/draft';
	import { fieldClass } from '$lib/ui/field-styles';
	import {
		clearReplacementReferenceHighlights,
		setReplacementReferenceHighlights
	} from './replacement-reference-highlights';

	type Bookmark = { start: number; end: number };
	type TextSegment = { node: Text; start: number; end: number };
	type TextSnapshot = { text: string; segments: readonly TextSegment[] };

	let {
		value,
		label,
		placeholder,
		disabled = false,
		catalog,
		paragraphs = true,
		onChange
	}: {
		value: DeepReadonly<ReplacementAtom[]>;
		label: string;
		placeholder: string;
		disabled?: boolean;
		catalog: ReferenceCatalog;
		paragraphs?: boolean;
		onChange: (atoms: ReplacementAtom[]) => void;
	} = $props();

	const highlightOwner = Symbol('replacement-editor');
	const blockElements = new Set(['DIV', 'P', 'LI', 'PRE']);
	let editor = $state<HTMLDivElement>();
	let empty = $state(true);
	let composing = false;
	let initialized = false;
	let lastAtoms: readonly ReplacementAtomValue[] = [];
	let lastVisibleText = '';
	let lastCatalogText = '';
	let lastCatalog: ReferenceCatalog | undefined;
	let lastParagraphs: boolean | undefined;
	const recognize = $derived(createReferenceRecognizer(catalog));

	function atomText(atoms: readonly ReplacementAtomValue[]) {
		return atoms
			.map((atom) =>
				atom.kind === 'text'
					? atom.text
					: atom.kind === 'paragraph-break'
						? '\n'
						: referenceText(
								atom as Extract<ReplacementAtom, { kind: 'reference' }>,
								catalog.addresses
							)
			)
			.join('');
	}

	function length(node: Node): number {
		if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
		if (node instanceof HTMLElement && node.tagName === 'BR') return 1;
		return Array.from(node.childNodes).reduce((total, child) => total + length(child), 0);
	}

	function position(container: Node, offset: number): number {
		if (!editor) return 0;
		let result =
			container.nodeType === Node.TEXT_NODE
				? offset
				: Array.from(container.childNodes)
						.slice(0, offset)
						.reduce((total, child) => total + length(child), 0);
		let node = container;
		while (node !== editor && node.parentNode) {
			for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling)
				result += length(sibling);
			node = node.parentNode;
		}
		return result;
	}

	function bookmark(): Bookmark {
		const selection = window.getSelection();
		if (!editor || !selection?.rangeCount) return { start: 0, end: 0 };
		const range = selection.getRangeAt(0);
		if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer))
			return { start: 0, end: 0 };
		return {
			start: position(range.startContainer, range.startOffset),
			end: position(range.endContainer, range.endOffset)
		};
	}

	function endpoint(offset: number): [Node, number] {
		const root = editor!;
		function descend(parent: Node, remaining: number): [Node, number] {
			for (const [index, child] of Array.from(parent.childNodes).entries()) {
				const childLength = length(child);
				if (child.nodeType === Node.TEXT_NODE && remaining <= childLength)
					return [child, remaining];
				if (child instanceof HTMLElement && child.tagName === 'BR') {
					if (remaining < childLength) return [parent, index];
				} else if (remaining <= childLength) return descend(child, remaining);
				remaining -= childLength;
			}
			return [parent, parent.childNodes.length];
		}
		return descend(root, Math.max(0, Math.min(offset, length(root))));
	}

	function restore(selection: Bookmark) {
		if (!editor || document.activeElement !== editor) return;
		const range = document.createRange();
		range.setStart(...endpoint(selection.start));
		range.setEnd(...endpoint(selection.end));
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
	}

	function hasOnlyPlaceholderBreak(element: Element) {
		return (
			element.childNodes.length === 1 &&
			element.firstChild instanceof HTMLElement &&
			element.firstChild.tagName === 'BR'
		);
	}

	/** Read the browser's plain editable DOM without requiring it to use one exact paragraph shape. */
	function snapshot(): TextSnapshot {
		const segments: TextSegment[] = [];
		let text = '';
		const appendBreak = () => {
			text += '\n';
		};
		const visit = (node: Node, placeholder = false) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const value = node.textContent ?? '';
				segments.push({ node: node as Text, start: text.length, end: text.length + value.length });
				text += value;
				return;
			}
			if (!(node instanceof HTMLElement) || node.dataset.placeholder !== undefined) return;
			if (node.tagName === 'BR') {
				if (!placeholder) appendBreak();
				return;
			}
			for (const child of node.childNodes)
				visit(child, placeholder || hasOnlyPlaceholderBreak(node));
		};
		const children = Array.from(editor?.childNodes ?? []);
		for (const [index, child] of children.entries()) {
			const block = child instanceof HTMLElement && blockElements.has(child.tagName);
			if (index && block) appendBreak();
			visit(child);
		}
		return { text: text.replace(/\r\n?/gu, '\n'), segments };
	}

	function textPoint(
		snapshot: TextSnapshot,
		offset: number,
		ending: boolean
	): [Text, number] | null {
		const segments = ending ? [...snapshot.segments].reverse() : snapshot.segments;
		for (const segment of segments) {
			if (offset < segment.start || offset > segment.end) continue;
			return [segment.node, offset - segment.start];
		}
		return null;
	}

	function referenceRanges(snapshot: TextSnapshot, references: readonly RecognizedReference[]) {
		const ranges: Range[] = [];
		for (const reference of references) {
			const start = textPoint(snapshot, reference.start, false);
			const end = textPoint(snapshot, reference.end, true);
			if (!start || !end) continue;
			const range = document.createRange();
			range.setStart(...start);
			range.setEnd(...end);
			ranges.push(range);
		}
		return ranges;
	}

	function decorate(current: TextSnapshot) {
		const recognition = recognizeReplacementContent(current.text, recognize, paragraphs);
		setReplacementReferenceHighlights(
			highlightOwner,
			referenceRanges(current, recognition.references)
		);
		return recognition;
	}

	function render(text: string) {
		if (!editor) return;
		clearReplacementReferenceHighlights(highlightOwner);
		const fragment = document.createDocumentFragment();
		const lines = text.split('\n');
		for (const [index, line] of lines.entries()) {
			if (line) fragment.append(document.createTextNode(line));
			if (index + 1 < lines.length) fragment.append(document.createElement('br'));
		}
		if (!text) {
			const placeholder = document.createElement('br');
			placeholder.dataset.placeholder = '';
			fragment.append(placeholder);
		}
		editor.replaceChildren(fragment);
		const current = snapshot();
		empty = !current.text;
		decorate(current);
	}

	function insertPlainText(text: string) {
		try {
			if (document.execCommand('insertText', false, text)) {
				commit();
				return;
			}
		} catch {
			// The selection fallback below is for engines without the undo-preserving command.
		}
		const selection = window.getSelection();
		if (!editor || !selection?.rangeCount) return;
		const range = selection.getRangeAt(0);
		if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		range.setStart(node, node.length);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		commit();
	}

	function commit() {
		if (!editor) return;
		const current = snapshot();
		const recognition = decorate(current);
		empty = !current.text;
		lastVisibleText = current.text;
		lastCatalogText = atomText(recognition.atoms);
		lastCatalog = catalog;
		lastParagraphs = paragraphs;
		if (sameReplacementAtoms(recognition.atoms, lastAtoms)) return;
		lastAtoms = recognition.atoms;
		onChange(recognition.atoms);
	}

	$effect(() => {
		if (!editor) return;
		const incomingText = atomText(value);
		const current = snapshot();
		const matchesLocalValue = initialized && sameReplacementAtoms(value, lastAtoms);
		const catalogChanged = catalog !== lastCatalog || paragraphs !== lastParagraphs;
		if (!matchesLocalValue) {
			const selection = bookmark();
			untrack(() => render(incomingText));
			restore(selection);
			lastAtoms = value;
			lastVisibleText = incomingText;
			lastCatalogText = incomingText;
			lastCatalog = catalog;
			lastParagraphs = paragraphs;
			initialized = true;
			return;
		}
		let rendered = false;
		if (incomingText !== lastCatalogText && current.text === lastVisibleText) {
			const selection = bookmark();
			untrack(() => render(incomingText));
			restore(selection);
			lastVisibleText = incomingText;
			rendered = true;
		}
		lastCatalogText = incomingText;
		if (catalogChanged && !rendered) decorate(snapshot());
		lastCatalog = catalog;
		lastParagraphs = paragraphs;
	});

	onDestroy(() => clearReplacementReferenceHighlights(highlightOwner));
</script>

<div class="flex min-w-0 flex-col gap-2">
	<div
		bind:this={editor}
		class={`${fieldClass} replacement-editor block min-h-28 resize-y overflow-auto whitespace-pre-wrap py-2 leading-[1.45]`}
		class:empty
		contenteditable={disabled ? 'false' : 'plaintext-only'}
		role="textbox"
		aria-label={label}
		aria-multiline="true"
		aria-disabled={disabled}
		data-placeholder={placeholder}
		tabindex={disabled ? -1 : 0}
		oninput={() => {
			if (!composing) commit();
		}}
		onblur={commit}
		oncompositionstart={() => (composing = true)}
		oncompositionend={() => {
			composing = false;
			commit();
		}}
		onbeforeinput={(event) => {
			if (event.inputType.startsWith('format')) event.preventDefault();
		}}
		onpaste={(event) => {
			event.preventDefault();
			insertPlainText((event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/gu, '\n'));
		}}
		ondrop={(event) => event.preventDefault()}
	></div>
</div>

<style>
	.replacement-editor {
		position: relative;
	}
	.replacement-editor.empty::before {
		position: absolute;
		content: attr(data-placeholder);
		color: var(--color-ink-muted);
		pointer-events: none;
	}
	.replacement-editor[aria-disabled='true'] {
		background: var(--color-canvas);
	}
	:global(::highlight(dinu-replacement-reference)) {
		text-decoration: underline dotted color-mix(in srgb, var(--color-accent) 52%, transparent);
		text-underline-offset: 0.16em;
	}
</style>
