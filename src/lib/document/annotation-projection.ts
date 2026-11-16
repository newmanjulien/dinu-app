import { pointPosition, type SourceIndex } from './source-index';
import { unitsInRange } from './ranges';
import { sameSourceTarget, type SourceTarget } from './source-model';
import type {
	AnnotationMembership,
	DocumentAnnotation,
	DocumentAnnotationItem
} from '../playbook/document-overlay';
import type { AnnotationActivation } from './annotation-anchor';
import type {
	AnnotationRegistry,
	AnnotationSegment,
	ProjectedOccurrence
} from './annotation-registry';
import type { DocumentHighlightController } from './highlights/controller';
import type { ResolvedRun } from './model';
import type { PaginatedPage } from './pagination/types';
import type { AnnotationProjectionDocument } from './runtime/types';
import type { SelectionDocument } from './selection/selection-model';

export type AnnotationDomRevision = {
	id: number;
	pages: readonly PaginatedPage[];
	selectionDocument?: SelectionDocument;
};
type Token = { element: HTMLElement; page: number; from: number; to: number; visual?: SourceTarget };
type PageTokens = {
	page: PaginatedPage;
	element: HTMLElement;
	tokens: Map<string, Token[]>;
	generated: Token[];
};
type Owner = {
	element: HTMLElement;
	anchor: Element;
	page: number;
	release: () => void;
	group: string;
	annotation: AnnotationMembership;
};

/** Annotation membership is projected onto already prepared source/provenance. It never
 * splits text, changes a token, or asks the layout worker to compose/profile/paginate. */
export class DocumentAnnotationProjection {
	private snapshot: AnnotationProjectionDocument | null = null;
	private domRevision: AnnotationDomRevision | null = null;
	private pageTokens = new Map<number, PageTokens>();
	private tokens = new Map<string, Token[]>();
	private generated: Token[] = [];
	private owners = new Map<string, Owner>();
	private projected = new Map<
		string,
		{ annotation: DocumentAnnotation; owners: string[] }
	>();
	private containers = new WeakMap<Element, number>();
	private nextContainer = 0;
	private layers = new Map<HTMLElement, HTMLElement>();
	private releaseGeometry: () => void;
	private releaseRebind: () => void;
	private current: {
		snapshot: AnnotationProjectionDocument;
		items: readonly DocumentAnnotationItem[];
		selected: string | null;
		capable: boolean;
		enabled: boolean;
		domRevision: AnnotationDomRevision;
	} | null = null;
	private listeners = new AbortController();
	private intentVersion = 0;
	private pendingPreparation: {
		owner: Owner;
		occurrence: ProjectedOccurrence;
		snapshot: AnnotationProjectionDocument | null;
		reveal: boolean;
		intent: number;
	} | null = null;
	constructor(
		private stage: HTMLElement,
		private highlights: DocumentHighlightController,
		private registry: AnnotationRegistry,
		private select: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void,
		private label = 'saved instructions'
	) {
		for (const event of ['focus', 'keydown', 'pointerdown', 'wheel', 'touchstart', 'touchmove'])
			stage.ownerDocument.addEventListener(event, () => this.intentVersion++, {
				capture: true,
				passive: true,
				signal: this.listeners.signal
			});
		this.releaseGeometry = highlights.subscribeGeometry((change) => {
			if (change === 'measure' || change === 'invalidate') this.positionOwners();
			if (change === 'measure') this.completePreparation();
		});
		this.releaseRebind = highlights.subscribeAnnotationRebind((pages) => {
			const current = this.current;
			if (current) this.update({ ...current, rebindPages: pages });
		});
	}
	update({
		snapshot,
		items,
		selected,
		capable,
		enabled,
		domRevision,
		rebindPages = new Set<number>()
	}: {
		snapshot: AnnotationProjectionDocument;
		items: readonly DocumentAnnotationItem[];
		selected: string | null;
		capable: boolean;
		enabled: boolean;
		domRevision: AnnotationDomRevision;
		rebindPages?: ReadonlySet<number>;
	}) {
		this.current = { snapshot, items, selected, capable, enabled, domRevision };
		const dirtyPages = this.index(snapshot, domRevision, rebindPages);
		const includedPages = new Set(snapshot.pages.map((page) => page.number));
		const next = new Set<string>();
		const seen = new Set<string>();
		const changed = new Set<string>();
		const positioned = new Set<Owner>();
		let reordered = false;
		for (const item of items)
			for (const annotation of item.annotations) {
				seen.add(annotation.id);
				const membership: AnnotationMembership = {
					...annotation,
					applied:
						annotation.kind === 'concession-effect' &&
						snapshot.concessions[item.itemId] === annotation.concessionId
				};
				const cached = this.projected.get(annotation.id);
				const reusable =
					cached &&
					cached.annotation.highlightKind === annotation.highlightKind &&
					sameSourceTarget(cached.annotation.target, annotation.target);
				const ownerKeys: string[] = [];
				if (reusable) {
					for (const key of cached.owners) {
						const owner = this.owners.get(key);
						if (!owner || dirtyPages.has(owner.page) || !includedPages.has(owner.page)) continue;
						next.add(key);
						ownerKeys.push(key);
						owner.annotation = membership;
						const state = this.updateState(owner, selected, capable, enabled);
						if (
							cached.annotation.pending !== annotation.pending ||
							cached.annotation.passive !== annotation.passive
						)
							this.updateOwnerLabel(
								owner.element,
								annotation,
								this.registry.occurrence(owner.element)?.ranges ?? []
							);
						if (state.changed) changed.add(owner.group);
						reordered ||= state.orderChanged;
					}
				}
				const pagesToProject = reusable ? dirtyPages : includedPages;
				const byContainer = new Map<Element, { token: HTMLElement; range: Range }[]>();
				for (const { token, range } of this.ranges(
					annotation.target,
					snapshot.source.sourceIndex,
					pagesToProject
				)) {
					const container = token.closest('p, h1, h2, h3, td, th');
					if (!container) continue;
					const ranges = byContainer.get(container) ?? [];
					ranges.push({ token, range });
					byContainer.set(container, ranges);
				}
				for (const [container, coverage] of byContainer) {
					coverage.sort((a, b) =>
						a.token === b.token
							? a.range.startOffset - b.range.startOffset
							: a.token.compareDocumentPosition(b.token) & Node.DOCUMENT_POSITION_FOLLOWING
								? -1
								: 1
					);
					const ranges = coverage.map(({ range }) => range);
					const page = container.closest<HTMLElement>('.document-page');
					if (!page) continue;
					const pageNumber = Number(page.dataset.pageNumber);
					let containerId = this.containers.get(container);
					if (!containerId) this.containers.set(container, (containerId = ++this.nextContainer));
					const key = JSON.stringify([annotation.id, containerId]);
					next.add(key);
					ownerKeys.push(key);
					let owner = this.owners.get(key);
					if (!owner || !owner.element.isConnected) {
						if (owner) {
							if (this.pendingPreparation?.owner === owner) this.pendingPreparation = null;
							owner.release();
							this.highlights.clearGroup(owner.group);
						}
						const element = document.createElement('span');
						element.className = 'playbook-trigger absolute pointer-events-none';
						element.dataset.documentControl = '';
						element.dataset.annotationProjected = '';
						element.dataset.annotationId = annotation.id;
						element.addEventListener('keydown', (event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							event.stopPropagation();
							if (!event.repeat && element.getAttribute('aria-disabled') !== 'true')
								this.select(element.dataset.itemId!, element.dataset.annotationId!, {
									owner: element
								});
						});
						reordered = true;
						element.addEventListener('focus', () => {
							const current = this.owners.get(key);
							if (current && !this.registry.programmaticFocus) this.prepare(current, true);
						});
						this.layer(page).append(element);
						owner = {
							element,
							anchor: container,
							page: pageNumber,
							release: this.registry.register(element, [annotation.id]),
							group: `annotation:${key}`,
							annotation: membership
						};
						this.owners.set(key, owner);
					}
					owner.annotation = membership;
					owner.page = pageNumber;
					const element = owner.element;
					const state = this.updateState(owner, selected, capable, enabled);
					if (state.changed) changed.add(owner.group);
					reordered ||= state.orderChanged;
					this.updateOwnerLabel(element, annotation, ranges);
					const anchor = coverage[0].token;
					if (owner.anchor !== anchor) reordered = true;
					owner.anchor = anchor;
					const current = owner;
					this.registry.updateOccurrence(element, {
						ranges,
						segments: coverage.map(({ token, range }) => this.segment(token, range)),
						prepare: () => this.prepare(current, false)
					});
					this.highlights.setGroup(
						owner.group,
						annotation.highlightKind,
						ranges,
						undefined,
						annotation.passive ? undefined : element,
						{ rebindFromSource: true }
					);
					positioned.add(owner);
				}
				this.projected.set(annotation.id, {
					annotation,
					owners: ownerKeys
				});
			}
		for (const [key, owner] of this.owners)
			if (!next.has(key)) {
				if (this.pendingPreparation?.owner === owner) this.pendingPreparation = null;
				owner.release();
				owner.element.remove();
				this.highlights.clearGroup(owner.group);
				this.owners.delete(key);
			}
		for (const id of this.projected.keys()) if (!seen.has(id)) this.projected.delete(id);
		if (reordered) this.orderOwners();
		this.highlights.annotationsChanged(changed);
		this.positionOwners(positioned);
	}
	private updateOwnerLabel(
		element: HTMLElement,
		annotation: DocumentAnnotation,
		ranges: readonly Range[]
	) {
		if (annotation.passive) {
			element.removeAttribute('aria-label');
			return;
		}
		const text = ranges
			.map((range) => range.toString())
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 140);
		element.setAttribute(
			'aria-label',
			annotation.pending
				? 'Saving changes'
				: text
					? `Open ${this.label}: ${text}`
					: `Open ${this.label}`
		);
	}
	private updateState(owner: Owner, selected: string | null, capable: boolean, enabled: boolean) {
		const { element, annotation } = owner;
		const state = String(annotation.id === selected),
			pending = String(Boolean(annotation.pending));
		const priority = String(annotation.kind === 'trigger' ? 0 : annotation.applied ? 1 : 2);
		const orderChanged = element.dataset.annotationPriority !== priority;
		const changed =
			element.dataset.annotationSelected !== state ||
			element.dataset.annotationPending !== pending ||
			element.dataset.annotationPriority !== priority;
		element.dataset.itemId = annotation.itemId;
		element.dataset.annotationSelected = state;
		element.dataset.annotationPending = pending;
		element.dataset.annotationPriority = priority;
		const actionable = capable && !annotation.passive;
		element.setAttribute('role', actionable ? 'button' : 'presentation');
		element.tabIndex = actionable ? 0 : -1;
		element.setAttribute('aria-pressed', state);
		element.setAttribute(
			'aria-disabled',
			String(!enabled || Boolean(annotation.pending) || Boolean(annotation.passive))
		);
		if (annotation.passive) element.removeAttribute('aria-label');
		return { changed, orderChanged };
	}
	private layer(page: HTMLElement) {
		let layer = this.layers.get(page);
		if (!layer?.isConnected) {
			layer = document.createElement('div');
			layer.dataset.annotationLayer = '';
			layer.className = 'absolute inset-0 pointer-events-none';
			page.append(layer);
			this.layers.set(page, layer);
		}
		return layer;
	}
	private orderOwners() {
		const focused =
			document.activeElement instanceof HTMLElement &&
			document.activeElement.hasAttribute('data-annotation-projected')
				? document.activeElement
				: null;
		const buckets = new Map<Element, Owner[]>();
		for (const owner of this.owners.values()) {
			const layer = owner.element.parentElement;
			if (!layer) continue;
			const bucket = buckets.get(layer) ?? [];
			bucket.push(owner);
			buckets.set(layer, bucket);
		}
		for (const [layer, owners] of buckets) {
			owners.sort((a, b) => {
				if (a.anchor !== b.anchor)
					return a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING
						? -1
						: 1;
				return (
					Number(a.element.dataset.annotationPriority) -
						Number(b.element.dataset.annotationPriority) ||
					a.annotation.id.localeCompare(b.annotation.id)
				);
			});
			for (let i = 0; i < owners.length; i++)
				if (layer.children[i] !== owners[i].element)
					layer.insertBefore(owners[i].element, layer.children[i] ?? null);
		}
		if (focused?.isConnected && document.activeElement !== focused) this.registry.focus(focused);
	}
	private index(
		snapshot: AnnotationProjectionDocument,
		revision: AnnotationDomRevision,
		rebindPages: ReadonlySet<number>
	) {
		if (this.snapshot === snapshot && this.domRevision?.id === revision.id && !rebindPages.size)
			return new Set<number>();
		const previous = this.snapshot;
		const oldRevision = this.domRevision;
		const rebuildAll =
			previous?.source.sourceIndex !== snapshot.source.sourceIndex ||
			previous?.view !== snapshot.view ||
			oldRevision?.selectionDocument !== revision.selectionDocument;
		this.snapshot = snapshot;
		this.domRevision = revision;
		for (const [page, layer] of this.layers)
			if (!page.isConnected) {
				layer.remove();
				this.layers.delete(page);
			}
		const index = snapshot.source.sourceIndex;
		const includedPages = new Set(snapshot.pages.map((page) => page.number));
		const mounted = new Map(
			Array.from(this.stage.querySelectorAll<HTMLElement>('.document-page'), (element) => [
				Number(element.dataset.pageNumber),
				element
			] as const)
		);
		const dirtyPages = new Set<number>();
		if (rebuildAll) {
			for (const number of this.pageTokens.keys()) dirtyPages.add(number);
			this.pageTokens.clear();
			this.tokens.clear();
			this.generated = [];
		}
		for (const number of this.pageTokens.keys())
			if (!includedPages.has(number) || !mounted.has(number)) {
				this.dropPageTokens(number);
				dirtyPages.add(number);
			}
		for (const page of snapshot.pages) {
			const element = mounted.get(page.number);
			if (!element) continue;
			const cached = this.pageTokens.get(page.number);
			if (
				!rebuildAll &&
				!rebindPages.has(page.number) &&
				cached?.page === page &&
				cached.element === element &&
				oldRevision?.pages.includes(page)
			)
				continue;
			dirtyPages.add(page.number);
			this.dropPageTokens(page.number);
			const tokens = new Map<string, Token[]>();
			const generated: Token[] = [];
			for (const token of element.querySelectorAll<HTMLElement>('[data-document-token]')) {
				if (
					token.closest('[data-annotation-layer]') ||
					token.dataset.generated === 'separator' ||
					(snapshot.view === 'effective' && token.dataset.generated === 'empty-hit-target')
				)
					continue;
				let visual: SourceTarget | undefined;
				try {
					if (token.dataset.visualSource) visual = JSON.parse(token.dataset.visualSource);
				} catch {
					continue;
				}
				if (visual) {
					try {
						generated.push({
							element: token,
							page: page.number,
							visual,
							from: visual.kind === 'text' ? pointPosition(index, visual.range.start) : 0,
							to: visual.kind === 'text' ? pointPosition(index, visual.range.end) : 0
						});
					} catch {
						/* Stale provenance cannot authorize annotation membership. */
					}
					continue;
				}
				const unit = index.byKey.get(token.dataset.sourceStartKey!);
				if (!unit || token.dataset.sourceEndKey !== unit.sourceKey) continue;
				const entries = tokens.get(unit.sourceKey) ?? [];
				entries.push({
					element: token,
					page: page.number,
					from: unit.position + Number(token.dataset.sourceStartOffset),
					to: unit.position + Number(token.dataset.sourceEndOffset)
				});
				tokens.set(unit.sourceKey, entries);
			}
			this.pageTokens.set(page.number, { page, element, tokens, generated });
			for (const [key, entries] of tokens)
				this.tokens.set(key, [...(this.tokens.get(key) ?? []), ...entries]);
			this.generated.push(...generated);
		}
		return dirtyPages;
	}
	private dropPageTokens(number: number) {
		const previous = this.pageTokens.get(number);
		if (!previous) return;
		this.pageTokens.delete(number);
		for (const key of previous.tokens.keys()) {
			const remaining = this.tokens.get(key)?.filter((token) => token.page !== number) ?? [];
			if (remaining.length) this.tokens.set(key, remaining);
			else this.tokens.delete(key);
		}
		if (previous.generated.length)
			this.generated = this.generated.filter((token) => token.page !== number);
	}
	private *ranges(target: SourceTarget, index: SourceIndex, pages: ReadonlySet<number>) {
		if (target.kind === 'boundary') {
			for (const token of this.generated)
				if (pages.has(token.page) && token.visual && sameSourceTarget(target, token.visual)) {
					const text = token.element.firstChild;
					if (!text?.textContent?.length) continue;
					const range = document.createRange();
					range.selectNodeContents(token.element);
					yield { token: token.element, range };
				}
			return;
		}
		let start: number, end: number;
		try {
			start = pointPosition(index, target.range.start);
			end = pointPosition(index, target.range.end);
		} catch {
			return;
		}
		const units =
			start === end
				? [index.byKey.get(target.range.start.sourceKey)!]
				: unitsInRange(index, target.range);
		const candidates = units.flatMap((unit) => this.tokens.get(unit.sourceKey) ?? []);
		for (const token of this.generated)
			if (
				pages.has(token.page) &&
				token.visual?.kind === 'text' &&
				(start === end
					? sameSourceTarget(target, token.visual)
					: start <= token.from && end >= token.to)
			)
				candidates.push(token);
		for (const token of candidates) {
			if (!pages.has(token.page)) continue;
			if (!token.element.isConnected) continue;
			const text = token.element.firstChild;
			if (text?.nodeType !== Node.TEXT_NODE || !text.textContent?.length) continue;
			const from = Math.max(start, token.from),
				to = Math.min(end, token.to);
			if (!token.visual && from >= to) continue;
			const range = document.createRange();
			const direct = !token.visual && token.element.dataset.sourceKind === 'text';
			range.setStart(text, direct ? from - token.from : 0);
			range.setEnd(text, direct ? to - token.from : text.textContent.length);
			yield { token: token.element, range };
		}
	}
	private segment(token: HTMLElement, range: Range): AnnotationSegment {
		if (token.dataset.visualSource) {
			const visualSource = JSON.parse(token.dataset.visualSource) as SourceTarget;
			const offset = Number(token.dataset.generatedOffset ?? 0);
			return {
				source: visualSource.kind === 'text' ? visualSource.range : undefined,
				visualSource,
				generated: token.dataset.generated as ResolvedRun['generated'],
				generatedStart:
					offset + (range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : 0),
				generatedEnd:
					offset +
					(range.endContainer.nodeType === Node.TEXT_NODE
						? range.endOffset
						: (token.textContent?.length ?? 0))
			};
		}
		const direct = token.dataset.sourceKind === 'text';
		return {
			source: {
				start: {
					sourceKey: token.dataset.sourceStartKey!,
					offset: Number(token.dataset.sourceStartOffset) + (direct ? range.startOffset : 0)
				},
				end: {
					sourceKey: token.dataset.sourceEndKey!,
					offset: direct
						? Number(token.dataset.sourceStartOffset) + range.endOffset
						: Number(token.dataset.sourceEndOffset)
				}
			}
		};
	}
	private prepare(owner: Owner, native: boolean) {
		const descriptor = this.registry.occurrence(owner.element);
		if (!descriptor || !owner.element.isConnected) return;
		const cold = owner.element.dataset.annotationMeasured !== 'true';
		// Every owner is page-local; the first real range identifies its one measurement page.
		if (descriptor.ranges[0]) this.highlights.ensureRangeGeometry(descriptor.ranges[0]);
		this.positionOwners([owner]);
		if (owner.element.dataset.annotationMeasured === 'true') {
			if (native && cold) owner.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			this.pendingPreparation = null;
		} else
			this.pendingPreparation = {
				owner,
				occurrence: descriptor,
				snapshot: this.snapshot,
				reveal: native && cold,
				intent: this.intentVersion
			};
	}
	private completePreparation() {
		const pending = this.pendingPreparation;
		if (!pending) return;
		const element = pending.owner.element;
		if (
			pending.snapshot !== this.snapshot ||
			this.registry.occurrence(element) !== pending.occurrence ||
			!element.isConnected ||
			element.ownerDocument.activeElement !== element
		) {
			this.pendingPreparation = null;
			return;
		}
		if (element.dataset.annotationMeasured !== 'true') return;
		this.pendingPreparation = null;
		if (pending.reveal && pending.intent === this.intentVersion)
			element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
	private positionOwners(owners: Iterable<Owner> = this.owners.values()) {
		for (const owner of owners) {
			const rects = this.highlights.annotationBounds(owner.group);
			owner.element.dataset.annotationMeasured = String(Boolean(rects.length));
			if (!rects.length) {
				Object.assign(owner.element.style, {
					left: '0px',
					top: '0px',
					width: '1px',
					height: '1px'
				});
				continue;
			}
			const left = Math.min(...rects.map((rect) => rect.x)),
				top = Math.min(...rects.map((rect) => rect.y));
			Object.assign(owner.element.style, {
				left: `${left}px`,
				top: `${top}px`,
				width: `${Math.max(...rects.map((rect) => rect.x + rect.width)) - left}px`,
				height: `${Math.max(...rects.map((rect) => rect.y + rect.height)) - top}px`
			});
		}
	}
	destroy() {
		this.releaseGeometry();
		this.releaseRebind();
		this.listeners.abort();
		this.pendingPreparation = null;
		this.current = null;
		for (const owner of this.owners.values()) {
			owner.release();
			this.highlights.clearGroup(owner.group);
			owner.element.remove();
		}
		for (const layer of this.layers.values()) layer.remove();
		this.owners.clear();
		this.projected.clear();
		this.layers.clear();
		this.pageTokens.clear();
		this.tokens.clear();
		this.generated = [];
	}
}
