import { pointPosition } from '$lib/contract/source-index';
import { validateRange } from '$lib/contract/ranges';
import type { SourcePoint, SourceTarget } from '$lib/contract/source-model';
import type { RenderSnapshot } from '../runtime/types';
import type { PaginatedPage } from '../pagination/types';
import { sourceTextToken, readSelectedDomEnvelope } from './dom-selection';
import type { CapturedNativeSelection } from './selection-gesture';
import {
	breakGroupKey,
	comparePositions,
	presentationToken,
	type DisplayPosition,
	type DisplayOccurrence,
	type SelectionDocument,
	type TextOccurrence,
	type BreakOccurrence,
	type SelectionCandidate
} from './selection-model';
export type { DisplayPosition } from './selection-model';
export type DisplayExtent = {
	document: SelectionDocument;
	anchor: DisplayPosition;
	head: DisplayPosition;
};
export type SelectionValue = {
	extent: DisplayExtent | null;
	target: SourceTarget | null;
	candidate: SelectionCandidate | null;
	range: Range | null;
	backward: boolean;
	breakKeys: string[];
	nativeInput?: CapturedNativeSelection;
	unavailable?: 'unsupported' | 'unowned' | 'stale';
};
type Endpoint = { node: Text; offset: number };
type TextBinding = {
	occurrence: TextOccurrence;
	node: Text;
	start: number;
	block: HTMLElement;
	page: HTMLElement;
};
export type VisibleBreak = {
	occurrence: BreakOccurrence;
	element: HTMLElement;
	key: string;
	page: number;
};
const mounts = new WeakMap<HTMLElement, { page: PaginatedPage; document?: SelectionDocument }>();
/** The renderer, rather than equal text or geometry, qualifies each mounted page. */
export function mountSelectionPage(
	element: HTMLElement,
	value: { page: PaginatedPage; document?: SelectionDocument }
) {
	mounts.set(element, value);
	return {
		update(next: typeof value) {
			mounts.set(element, next);
		},
		destroy() {
			mounts.delete(element);
		}
	};
}
const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);

/** Disposable DOM adapter. Logical positions contain only immutable physical model coordinates. */
export class SelectionSurface {
	readonly document: SelectionDocument;
	readonly index;
	readonly breaks: VisibleBreak[] = [];
	#texts = new WeakMap<Text, TextBinding>();
	#bindings = new Map<number, TextBinding[]>();
	#breaks = new Map<number, VisibleBreak>();
	#pageBreaks = new Map<number, VisibleBreak[]>();
	#presentation = new WeakMap<Text, string>();
	#invalidPrefix: number[] = [0];
	#reversedPrefix: number[] = [0];
	constructor(
		readonly root: HTMLElement,
		readonly snapshot: RenderSnapshot
	) {
		this.document = snapshot.selectionDocument;
		this.index = this.document.index;
		for (const page of root.querySelectorAll<HTMLElement>('.document-page')) {
			const mount = mounts.get(page);
			if (
				mount?.document !== this.document ||
				snapshot.pages[Number(page.dataset.pageNumber) - 1] !== mount.page
			)
				continue;
			const blocks = new Map(
				Array.from(page.querySelectorAll<HTMLElement>('[data-source-fragment-key]'), (block) => [
					block.dataset.sourceFragmentKey!,
					block
				])
			);
			for (const occurrence of this.document.pages.get(mount.page.number) ?? []) {
				if (occurrence.kind === 'break') {
					const element = page.querySelector<HTMLElement>(
						`[data-selection-group="${occurrence.group.id}"]`
					);
					if (!element) continue;
					const entry = {
						occurrence,
						element,
						key: breakGroupKey(occurrence.group),
						page: occurrence.page
					};
					this.breaks.push(entry);
					const local = this.#pageBreaks.get(occurrence.page) ?? [];
					local.push(entry);
					this.#pageBreaks.set(occurrence.page, local);
					this.#breaks.set(occurrence.order, entry);
					continue;
				}
				const block = blocks.get(occurrence.fragment);
				if (!block) continue;
				const leaf =
					occurrence.row === undefined
						? block.querySelector<HTMLElement>(
								`[data-selection-token-index="${occurrence.tokenIndex}"]`
							)
						: block.querySelector<HTMLElement>(
								`[data-source-row="${occurrence.row}"][data-source-cell="${occurrence.cell}"]`
							);
				if (!leaf) continue;
				const texts: Text[] = [];
				const walker = root.ownerDocument.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					if (
						(node as Text).parentElement?.closest('[data-selection-line-anchor]') &&
						(node as Text).data === '\u200b'
					)
						this.#presentation.set(node as Text, (node as Text).data);
					else texts.push(node as Text);
				}
				if (texts.map((text) => text.data).join('') !== occurrence.value) continue;
				let start = 0;
				const bindings = texts.map((node) => {
					const binding = { occurrence, node, start, block, page };
					start += node.length;
					this.#texts.set(node, binding);
					return binding;
				});
				this.#bindings.set(occurrence.order, bindings);
			}
			// Existing presentation anchors and truly collapsed paragraphs retain layout/owners only.
			for (const placement of mount.page.placements) {
				const block = blocks.get(
					`${placement.fragment.blockKey}:${placement.fragment.interval?.start ?? 0}:${placement.fragment.interval?.end ?? 'whole'}`
				);
				if (!block) continue;
				const tokens = block.querySelectorAll<HTMLElement>('[data-selection-token-index]');
				for (const span of tokens) {
					const prepared = placement.prepared.fragment;
					const token =
						prepared.type === 'paragraph'
							? prepared.tokens[Number(span.dataset.selectionTokenIndex)]
							: undefined;
					if (
						token &&
						(placement.prepared.flowRole === 'empty' || presentationToken(token)) &&
						span.textContent === token.value
					)
						for (const node of span.childNodes)
							if (node.nodeType === Node.TEXT_NODE)
								this.#presentation.set(node as Text, (node as Text).data);
				}
			}
		}
		let previous = -Infinity;
		for (const entry of this.document.occurrences) {
			let invalid = 0,
				reversed = 0;
			if (entry.kind === 'text') {
				const token = this.#token(entry);
				if (token) {
					reversed = Number(token.unit.position + token.from < previous);
					previous = token.unit.position + token.to;
				} else invalid = Number(Boolean(entry.value.length) && !this.#separator(entry));
			}
			this.#invalidPrefix.push(this.#invalidPrefix.at(-1)! + invalid);
			this.#reversedPrefix.push(this.#reversedPrefix.at(-1)! + reversed);
		}
	}
	pageBreaks(page: number): readonly VisibleBreak[] {
		return this.#pageBreaks.get(page) ?? [];
	}
	entry(position: DisplayPosition) {
		return this.document.occurrences[position.occurrence];
	}
	position(
		node: Node,
		offset: number,
		affinity?: DisplayPosition['affinity']
	): DisplayPosition | null {
		if (node.nodeType !== Node.TEXT_NODE) return null;
		const binding = this.#texts.get(node as Text);
		return binding && offset >= 0 && offset <= (node as Text).length
			? {
					document: this.document,
					occurrence: binding.occurrence.order,
					offset: binding.start + offset,
					affinity
				}
			: null;
	}
	breakPosition(entry: VisibleBreak): DisplayPosition {
		return { document: this.document, occurrence: entry.occurrence.order, offset: 0 };
	}
	#pageLive(page: HTMLElement, entry: DisplayOccurrence) {
		const mount = mounts.get(page);
		return (
			this.root.isConnected &&
			this.root.contains(page) &&
			!this.root.closest('[inert]') &&
			mount?.document === this.document &&
			this.snapshot.pages[entry.page - 1] === mount.page &&
			mount.page.placements.includes(entry.placement)
		);
	}
	live(position: DisplayPosition) {
		if (position.document !== this.document) return false;
		const entry = this.entry(position);
		if (
			!entry ||
			position.offset < 0 ||
			position.offset > (entry.kind === 'text' ? entry.value.length : 1)
		)
			return false;
		if (entry.kind === 'break') {
			const handle = this.#breaks.get(entry.order),
				page = handle?.element.closest<HTMLElement>('.document-page');
			return Boolean(
				handle &&
				page &&
				this.#pageLive(page, entry) &&
				page.contains(handle.element) &&
				Number(handle.element.dataset.selectionGroup) === entry.group.id
			);
		}
		const bindings = this.#bindings.get(entry.order);
		return Boolean(
			bindings?.length &&
			bindings.every(
				(binding) =>
					this.#pageLive(binding.page, entry) &&
					binding.page.contains(binding.block) &&
					binding.block.dataset.sourceFragmentKey === entry.fragment &&
					binding.block.contains(binding.node)
			) &&
			bindings.map((binding) => binding.node.data).join('') === entry.value
		);
	}
	#token(entry: TextOccurrence) {
		const bindings = this.#bindings.get(entry.order);
		if (
			!entry.token?.source ||
			entry.token.revision ||
			entry.row !== undefined ||
			bindings?.length !== 1
		)
			return null;
		const token = sourceTextToken(this.root, bindings[0].node, this.index);
		return token &&
			token.unit.sourceKey === entry.token.source.start.sourceKey &&
			token.unit.sourceKey === entry.token.source.end.sourceKey &&
			token.from === entry.token.source.start.offset &&
			token.to === entry.token.source.end.offset &&
			token.unit.kind === entry.token.sourceKind &&
			bindings[0].node.data === entry.value
			? token
			: null;
	}
	#separator(entry: TextOccurrence) {
		return entry.token?.generated === 'separator' && !entry.token.source && !entry.token.revision;
	}
	#source(position: DisplayPosition, end: boolean): SourcePoint | undefined {
		const entry = this.entry(position);
		if (entry.kind === 'break') return end ? entry.group.after : entry.group.before;
		const token = this.#token(entry);
		return token
			? {
					sourceKey: token.unit.sourceKey,
					offset: token.unit.kind === 'text' ? token.from + position.offset : end ? 1 : 0
				}
			: undefined;
	}
	endpoint(position: DisplayPosition, end: boolean): Endpoint | null {
		const entry = this.entry(position);
		if (entry.kind === 'text') {
			const bindings = this.#bindings.get(entry.order) ?? [];
			const binding = end
				? bindings.findLast((b) => b.start <= position.offset)
				: bindings.find((b) => b.start + b.node.length >= position.offset);
			return binding
				? {
						node: binding.node,
						offset: Math.min(binding.node.length, Math.max(0, position.offset - binding.start))
					}
				: null;
		}
		// Physical neighbors supply projection, never a substitute source target.
		const step = end ? 1 : -1;
		for (let i = entry.order + step; i >= 0 && i < this.document.occurrences.length; i += step) {
			const next = this.document.occurrences[i];
			if (next.kind !== 'text' || !next.value.length) continue;
			const endpoint = this.endpoint(
				{ document: this.document, occurrence: i, offset: end ? 0 : next.value.length },
				end
			);
			if (endpoint) return endpoint;
		}
		for (let i = entry.order - step; i >= 0 && i < this.document.occurrences.length; i -= step) {
			const next = this.document.occurrences[i];
			if (next.kind !== 'text' || !next.value.length) continue;
			const endpoint = this.endpoint(
				{ document: this.document, occurrence: i, offset: end ? next.value.length : 0 },
				end
			);
			if (endpoint) return endpoint;
		}
		return null;
	}
	#ordered(extent: DisplayExtent) {
		const backward = comparePositions(extent.anchor, extent.head) > 0;
		let low = backward ? extent.head : extent.anchor,
			high = backward ? extent.anchor : extent.head;
		// Adjacent token edges can describe the same caret. Trim only zero selected text,
		// before expanding partial atom labels; a native text-end→text-start gap then
		// becomes exactly the same indivisible break as a mouse gap drag.
		while (low.occurrence < high.occurrence) {
			const entry = this.entry(low);
			if (entry.kind !== 'text' || low.offset !== entry.value.length) break;
			low = { ...low, occurrence: low.occurrence + 1, offset: 0 };
		}
		while (high.occurrence > low.occurrence) {
			const entry = this.entry(high);
			if (entry.kind !== 'text' || high.offset !== 0) break;
			const previous = this.document.occurrences[high.occurrence - 1];
			high = {
				...high,
				occurrence: previous.order,
				offset: previous.kind === 'text' ? previous.value.length : 1
			};
		}
		if (comparePositions(low, high) === 0 && this.entry(low).kind === 'text')
			return { low, high, backward };
		const normalize = (position: DisplayPosition, end: boolean) => {
			const entry = this.entry(position);
			return entry.kind === 'break'
				? { ...position, offset: end ? 1 : 0 }
				: entry.token?.sourceKind && entry.token.sourceKind !== 'text'
					? { ...position, offset: end ? entry.value.length : 0 }
					: position;
		};
		low = normalize(low, false);
		high = normalize(high, true);
		return { low, high, backward };
	}
	*#slices(low: DisplayPosition, high: DisplayPosition) {
		for (let i = low.occurrence; i <= high.occurrence; i++) {
			const entry = this.document.occurrences[i];
			yield {
				entry,
				from: i === low.occurrence ? low.offset : 0,
				to: i === high.occurrence ? high.offset : entry.kind === 'text' ? entry.value.length : 1
			};
		}
	}
	#envelope(range: Range) {
		let previous = -1;
		return readSelectedDomEnvelope(this.root, range, (node, from) => {
			if (this.#presentation.get(node) === node.data) return true;
			const binding = this.#texts.get(node);
			if (
				!binding ||
				binding.occurrence.order < previous ||
				!this.live({
					document: this.document,
					occurrence: binding.occurrence.order,
					offset: binding.start + from
				})
			)
				return false;
			previous = binding.occurrence.order;
			return true;
		});
	}
	resolve(
		extent: DisplayExtent,
		final = false,
		original?: CapturedNativeSelection
	): SelectionValue | null {
		if (extent.document !== this.document || !this.live(extent.anchor) || !this.live(extent.head))
			return null;
		if (
			comparePositions(extent.anchor, extent.head) === 0 &&
			this.entry(extent.anchor).kind !== 'break'
		)
			return null;
		const { low, high, backward } = this.#ordered(extent);
		const pureBreak = low.occurrence === high.occurrence && this.entry(low).kind === 'break';
		if (!pureBreak && comparePositions(low, high) >= 0) return null;
		const a = this.endpoint(low, false),
			b = this.endpoint(high, true);
		let range: Range | null = null;
		if (a && b) {
			range = this.root.ownerDocument.createRange();
			range.setStart(a.node, a.offset);
			range.setEnd(b.node, b.offset);
			if (range.collapsed && !pureBreak) range = null;
		}
		// Traversed separators remain in the physical extent/copy, but only a pure gap paints a bar.
		const breakKeys = pureBreak ? [breakGroupKey((this.entry(low) as BreakOccurrence).group)] : [];
		let target: SourceTarget | null = null;
		if (pureBreak) {
			const entry = this.entry(low) as BreakOccurrence;
			if (entry.group.canonical)
				target = { kind: 'boundary', afterBlockKey: entry.group.canonical };
		} else {
			const start = this.#source(low, false),
				end = this.#source(high, true);
			if (start && end)
				try {
					validateRange(this.index, { start, end });
					const invalid =
						this.#invalidPrefix[high.occurrence + 1] - this.#invalidPrefix[low.occurrence];
					if (
						invalid > 0 ||
						this.#reversedPrefix[high.occurrence + 1] !== this.#reversedPrefix[low.occurrence + 1]
					)
						throw new Error('Unsupported interval');
					if (final) {
						let previous = pointPosition(this.index, start);
						for (const { entry, from, to } of this.#slices(low, high)) {
							if (entry.kind === 'text' && !entry.value.length) continue;
							if (!this.live({ document: this.document, occurrence: entry.order, offset: from }))
								throw new Error('Stale occurrence');
							if (entry.kind === 'break' || from >= to) continue;
							const token = this.#token(entry);
							if (!token) {
								if (
									!this.#separator(entry) ||
									entry.order === low.occurrence ||
									entry.order === high.occurrence
								)
									throw new Error('Unsupported contribution');
								continue;
							}
							const first =
								token.unit.position + (token.unit.kind === 'text' ? token.from + from : 0);
							if (first < previous) throw new Error('Nonmonotone source');
							previous = token.unit.position + (token.unit.kind === 'text' ? token.from + to : 1);
						}
					}
					target = { kind: 'text', range: { start, end } };
				} catch {
					target = null;
				}
		}
		// Both original native input and any atom-expanded/custom envelope must be fully owned.
		const owned =
			!final ||
			((!original || this.#envelope(original.range)) && (!range || this.#envelope(range)));
		if (!owned) target = null;
		const normalized = {
			document: this.document,
			anchor: backward ? high : low,
			head: backward ? low : high
		};
		const candidate =
			final && target
				? {
						token: {},
						document: this.document,
						target
					}
				: null;
		return {
			extent: normalized,
			target,
			candidate,
			range,
			backward,
			breakKeys,
			nativeInput: original,
			unavailable: target ? undefined : owned ? 'unsupported' : 'unowned'
		};
	}
	project(value: SelectionValue) {
		const selection = this.root.ownerDocument.getSelection();
		if (!selection || !value.extent) return;
		const range = value.range;
		if (!range || range.collapsed) {
			selection.removeAllRanges();
			return;
		}
		const a = { node: range.startContainer, offset: range.startOffset },
			b = { node: range.endContainer, offset: range.endOffset };
		const anchor = value.backward ? b : a,
			head = value.backward ? a : b;
		if (
			selection.anchorNode !== anchor.node ||
			selection.anchorOffset !== anchor.offset ||
			selection.focusNode !== head.node ||
			selection.focusOffset !== head.offset
		)
			selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
	}
	bridge(value: SelectionValue) {
		if (!value.extent) return;
		this.project(value);
		if (value.range && !value.range.collapsed) return;
		const endpoint =
			this.endpoint(value.extent.head, !value.backward) ??
			this.endpoint(value.extent.head, value.backward);
		if (endpoint) this.root.ownerDocument.getSelection()?.collapse(endpoint.node, endpoint.offset);
	}
	importNative(captured: CapturedNativeSelection): SelectionValue | null {
		if (captured.context !== this || captured.range.collapsed) return null;
		const range = captured.range;
		const nativeOnly = (): SelectionValue => ({
			extent: null,
			target: null,
			candidate: null,
			range,
			backward: captured.backward,
			breakKeys: [],
			nativeInput: captured,
			unavailable: 'unowned'
		});
		// Read the original envelope before element endpoint normalization can discard evidence.
		if (!this.#envelope(range)) return nativeOnly();
		let low = this.position(range.startContainer, range.startOffset),
			high = this.position(range.endContainer, range.endOffset);
		if (!low || !high) {
			const walker = this.root.ownerDocument.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const text = node as Text,
					binding = this.#texts.get(text);
				if (!binding) continue;
				const from =
					range.startContainer === text
						? range.startOffset
						: range.comparePoint(text, 0) >= 0
							? 0
							: text.length;
				const to =
					range.endContainer === text
						? range.endOffset
						: range.comparePoint(text, text.length) <= 0
							? text.length
							: 0;
				if (from < to) {
					low ??= this.position(text, from);
					high = this.position(text, to);
				}
			}
		}
		for (const handle of this.breaks) {
			if (handle.occurrence.gap <= 0) continue;
			const owner = handle.element.parentElement,
				parent = owner?.parentNode;
			if (!owner || !parent) continue;
			const offset = Array.prototype.indexOf.call(parent.childNodes, owner);
			if (
				range.comparePoint(parent, offset) === 0 &&
				range.comparePoint(parent, offset + 1) === 0
			) {
				const before = this.breakPosition(handle),
					after = { ...before, offset: 1 };
				if (!low || comparePositions(before, low) < 0) low = before;
				if (!high || comparePositions(after, high) > 0) high = after;
			}
		}
		if (!low || !high) return nativeOnly();
		return (
			this.resolve(
				{
					document: this.document,
					anchor: captured.backward ? high : low,
					head: captured.backward ? low : high
				},
				true,
				captured
			) ?? nativeOnly()
		);
	}
	/** Plain and safe structural HTML follow selected physical occurrences, including header repeats. */
	serialize(value: SelectionValue): { text: string; html: string } | null {
		if (!value.extent || !this.live(value.extent.anchor) || !this.live(value.extent.head))
			return null;
		const { low, high } = this.#ordered(value.extent);
		if (value.range && !this.#envelope(value.range)) return null;
		let text = '',
			html = '',
			paragraph = '',
			table = '',
			row = '',
			cell = '';
		let previous: TextOccurrence | undefined,
			broke = false;
		let cellTag: 'td' | 'th' = 'td',
			paragraphTag: 'p' | 'h1' | 'h2' = 'p';
		const closeCell = () => {
			if (cell) {
				row += cell + `</${cellTag}>`;
				cell = '';
			}
		};
		const closeRow = () => {
			closeCell();
			if (row) {
				table += '<tr>' + row + '</tr>';
				row = '';
			}
		};
		const closeTable = () => {
			closeRow();
			if (table) {
				html += '<table><tbody>' + table + '</tbody></table>';
				table = '';
			}
		};
		const closeParagraph = () => {
			if (paragraph) {
				html +=
					`<${paragraphTag} style="margin:0;white-space:pre-wrap">` +
					paragraph +
					`</${paragraphTag}>`;
				paragraph = '';
			}
		};
		for (const { entry, from, to } of this.#slices(low, high)) {
			if (entry.kind === 'break') {
				text += '\n';
				closeParagraph();
				closeTable();
				if (!html) html += '<p style="margin:0"><br></p>';
				broke = true;
				continue;
			}
			if (from >= to && entry.row === undefined) continue;
			if (
				entry.value.length &&
				!this.live({ document: this.document, occurrence: entry.order, offset: from })
			)
				return null;
			const content = entry.value.slice(from, to),
				escaped = escapeHtml(content);
			if (entry.row !== undefined) {
				closeParagraph();
				if (previous && previous.placement !== entry.placement) {
					closeTable();
					if (!broke) text += '\n';
				} else if (previous?.row !== undefined && !broke)
					text += previous.row === entry.row ? '\t' : '\n';
				else if (previous && !broke) text += '\n';
				if (previous?.row !== entry.row) closeRow();
				else closeCell();
				cellTag =
					entry.placement.fragment.type === 'table' &&
					entry.row < entry.placement.fragment.headerRowCount
						? 'th'
						: 'td';
				cell = `<${cellTag} style="white-space:pre-wrap">` + escaped;
			} else {
				closeTable();
				if (
					previous &&
					previous.placement.fragment.blockKey !== entry.placement.fragment.blockKey &&
					!broke
				) {
					text += '\n';
					closeParagraph();
				}
				if (!paragraph && entry.placement.fragment.type === 'paragraph')
					paragraphTag =
						entry.placement.fragment.role === 'title'
							? 'h1'
							: entry.placement.fragment.role === 'heading'
								? 'h2'
								: 'p';
				paragraph +=
					entry.token?.revision === 'removed'
						? '<del>' + escaped + '</del>'
						: entry.token?.revision === 'added'
							? '<ins>' + escaped + '</ins>'
							: escaped;
			}
			text += content;
			previous = entry;
			broke = false;
		}
		closeParagraph();
		closeTable();
		if (broke && previous) html += '<p style="margin:0"><br></p>';
		return { text, html };
	}
}
