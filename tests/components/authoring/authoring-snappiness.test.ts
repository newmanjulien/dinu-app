import { AuthoringController } from '../../../src/lib/playbook/authoring-controller.svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { TemplateAuthoringSession } from '../../../src/lib/playbook/template-authoring-session.svelte';
import { TemplateSource } from '../../../src/lib/playbook/template-source.svelte';
import { documentAnnotations } from '../../../src/lib/playbook/document-overlay';
import { isRepItem } from '../../../src/lib/playbook/model';
import type { SessionEditor } from '../../../src/lib/auth/viewer-session.svelte';
import { DocumentSourceController } from '../../../src/lib/document/runtime/source.svelte';
import { companyId, documentFixture, membershipId } from '../../support/document';
import { controlledClient } from '../../support/transport';
import { settle } from '../../support/svelte';
import { observe } from '../../support/observers.svelte';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(count = 12, sourceReady = true) {
	const data = documentFixture(count),
		network = controlledClient();
	let lifecycle!: SessionEditor;
	const templateSource = new TemplateSource(network.client, membershipId);
	const session = new TemplateAuthoringSession({
		templateSource,
		client: network.client,
		membershipId,
		companyId,
		audience: 'rep',
		registerEditor: (editor) => {
			lifecycle = editor;
			return () => {};
		}
	});
	session.installController(AuthoringController);
	session.start();
	const source = new DocumentSourceController();
	source.accept({
		kind: 'structure',
		blocks: { data: data.blocks },
		structure: { data: data.structure }
	});
	const detach = session.attach(() => ({
		document: source.compiled,
		geometry: source.geometry,
		items: source.structuralItems,
		itemsCurrent: true,
		available: sourceReady,
		lookup: (id) => {
			const record = session.detail(id);
			return record ? { record, annotations: documentAnnotations(record) } : null;
		},
		detailStatus: (id) => session.detailStatus(id)
	}));
	session.configurePreloading(data.structure.templateSourceFingerprint);
	network.publish('playbookItems:currentStructure', data.structure);
	cleanups.push(() => {
		session.destroy();
		templateSource.destroy();
		source.destroy();
	});
	const open = (i: number) =>
		session.select(data.records[i]._id, documentAnnotations(data.records[i])[0].id);
	const respond = (i: number) => network.publishDetail(data.records[i]._id, data.detail(i));
	const close = () => {
		expect(session.controller.cancel()).toBe('closed');
		session.acceptSource();
	};
	return {
		data,
		network,
		session,
		source,
		open,
		respond,
		close,
		detach,
		setSourceReady() {
			sourceReady = true;
			session.acceptSource();
		},
		get lifecycle() {
			return lifecycle;
		}
	};
}

it('shares one-shot source reads across audiences and keeps structures until the workspace owner leaves', async () => {
	const network = controlledClient();
	const source = new TemplateSource(network.client, membershipId);
	const sessions = (['rep', 'buyer'] as const).map(
		(audience) =>
			new TemplateAuthoringSession({
				client: network.client,
				membershipId,
				companyId,
				audience,
				templateSource: source,
				registerEditor: () => () => {}
			})
	);
	cleanups.push(() => {
		sessions.forEach((session) => session.destroy());
		source.destroy();
	});
	const [rep, buyer] = sessions;
	const releaseRoute = rep.retainReads();
	const releaseMounted = rep.retainReads();
	const releaseBuyer = buyer.retainReads();
	await settle();
	const structures = network.live('playbookItems:currentStructure');
	expect(network.live('templateSources:authoringSource')).toHaveLength(1);
	expect(structures.map((read) => read.args)).toEqual([{ audience: 'rep' }, { audience: 'buyer' }]);
	expect(network.onUpdate).toHaveBeenCalledTimes(3);
	const data = documentFixture();
	network.publish('templateSources:authoringSource', {
		blocks: data.blocks,
		templateSourceFingerprint: data.structure.templateSourceFingerprint
	});
	await settle();
	expect(network.live('templateSources:authoringSource')).toHaveLength(0);
	const reads = network.onUpdate.mock.calls.length;
	releaseRoute();
	releaseRoute();
	releaseMounted();
	releaseBuyer();
	await settle();
	expect(network.live('playbookItems:currentStructure')).toEqual(structures);
	const releaseAgain = rep.retainReads();
	expect(network.onUpdate).toHaveBeenCalledTimes(reads);
	releaseAgain();
	sessions.forEach((session) => session.destroy());
	expect(network.live('playbookItems:currentStructure')).toHaveLength(0);
	expect(network.live('templateSources:authoringSource')).toHaveLength(0);
	expect(network.mutation).not.toHaveBeenCalled();
});

it('waits for nearby demand before speculative reads and lets cold foreground demand bypass them', async () => {
	const f = fixture(20, false);
	expect(f.network.details()).toHaveLength(0);
	const nearby = f.data.records.slice(0, 8).map((r) => r._id);
	f.session.itemPreload!(nearby);
	await settle();
	expect(f.network.details()).toHaveLength(1);
	expect(f.network.details()[0].args.ids).toEqual(nearby);
	expect(f.session.controller.entry).toBeNull();
	expect(f.network.mutation).not.toHaveBeenCalled();
	f.setSourceReady();
	f.open(19);
	await settle();
	expect(f.network.details()).toHaveLength(2);
	expect(f.network.details()[1].args.ids).toEqual([f.data.records[19]._id]);
	expect(f.session.pendingPanel?.itemId).toBe(f.data.records[19]._id);
	f.respond(19);
	await settle();
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[19]._id);
	expect(f.session.selectionRequest?.status).toBe('opened');
	// The background batch remains unanswered and cannot delay the foreground result.
	expect(f.network.details()).toHaveLength(1);
	expect(f.network.details()[0].args.ids).toEqual(nearby);
});

it('cancellation and supersession never open a late cold response', async () => {
	const f = fixture(20);
	f.open(18);
	await settle();
	const cancelled = f.network.details()[0];
	expect(f.session.cancelSelection()).toBe(true);
	cancelled.update([{ id: f.data.records[18]._id, content: f.data.detail(18) }]);
	await settle();
	expect(f.session.controller.entry).toBeNull();
	f.open(17);
	await settle();
	const superseded = f.network.details()[0];
	f.open(19);
	await settle();
	superseded.update([{ id: f.data.records[17]._id, content: f.data.detail(17) }]);
	await settle();
	expect(f.session.controller.entry).toBeNull();
	f.respond(19);
	await settle();
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[19]._id);
});

it('a formerly warm instruction waits for its current revision rather than presenting stale content', async () => {
	const f = fixture();
	f.session.itemPreload!([f.data.records[0]._id]);
	await settle();
	f.respond(0);
	await settle();
	const updated = {
		...f.data.records[0],
		contentRevision: 2,
		instructions: { summary: 'Current guidance' }
	};
	f.network.publish('playbookItems:currentStructure', {
		...f.data.structure,
		authoringGeneration: 2,
		items: f.data.structure.items.map((head, i) => (i ? head : { ...head, contentRevision: 2 }))
	});
	f.open(0);
	await settle();
	expect(f.session.pendingPanel).not.toBeNull();
	expect(f.session.controller.entry).toBeNull();
	f.respond(0);
	await settle();
	expect(f.session.controller.entry).toBeNull();
	f.network.publishDetail(updated._id, f.data.detail(0, updated));
	await settle();
	expect(f.session.pendingPanel).toBeNull();
	const draft = f.session.controller.draft;
	expect(draft && isRepItem(draft) ? draft.instructions.summary : undefined).toBe(
		'Current guidance'
	);
});

it('keeps optional failures local, retries explicitly, and reuses warm instructions through A → B → A', async () => {
	const f = fixture();
	f.session.itemPreload!(f.data.records.slice(0, 3).map((r) => r._id));
	await settle();
	const failed = f.network.details()[0];
	failed.error(new Error('Speculative read failed'));
	await settle();
	expect(f.session.message).toBe('');
	expect(failed.released).toBe(true);
	f.open(0);
	await settle();
	expect(f.network.details()[0].args.ids).toEqual([f.data.records[0]._id]);
	f.respond(0);
	await settle();
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[0]._id);
	f.close();
	f.session.itemPreload!([f.data.records[1]._id]);
	await settle();
	f.respond(1);
	await settle();
	const reads = f.network.onUpdate.mock.calls.length;
	for (const i of [0, 1, 0]) {
		expect(f.open(i).status).toBe('accepted');
		// The warm click must open synchronously, with no tick or extra response.
		expect(f.session.selectionRequest?.status).toBe('opened');
		expect(f.session.controller.draft?.persistedId).toBe(f.data.records[i]._id);
		expect(f.session.pendingPanel).toBeNull();
		f.close();
	}
	expect(f.network.onUpdate).toHaveBeenCalledTimes(reads);
});

it('prioritizes nearby demand, renews the reporter after same-templateSource refresh, and fences retired reports', async () => {
	const f = fixture(24),
		nearby = [f.data.records[20]._id, f.data.records[19]._id];
	const first = f.session.itemPreload!;
	first(nearby);
	await settle();
	expect(f.network.details()[0].args.ids).toEqual(nearby);
	f.session.retryReads();
	expect(f.session.itemPreload).toBeUndefined();
	f.network.publish('playbookItems:currentStructure', f.data.structure);
	const renewed = f.session.itemPreload!;
	expect(renewed).toBeTypeOf('function');
	expect(renewed).not.toBe(first);
	renewed(nearby);
	await settle();
	const calls = f.network.onUpdate.mock.calls.length;
	first([f.data.records[23]._id]);
	await settle();
	expect(f.network.onUpdate).toHaveBeenCalledTimes(calls);
	expect(f.network.details()[0].args.ids).toEqual(nearby);
});

it('retains at most 64 optional records in one bounded batch, including warm editor demotion', async () => {
	const f = fixture(90);
	expect(f.network.details()).toHaveLength(0);
	f.session.itemPreload!(f.data.records.map((r) => r._id));
	await settle();
	expect(f.network.details()).toHaveLength(1);
	expect(f.network.details()[0].args.ids).toEqual(f.data.records.slice(0, 64).map((r) => r._id));
	for (let i = 0; i < 64; i++) f.respond(i);
	await settle();
	expect(f.network.details()).toHaveLength(0);
	const retained = () => f.data.records.filter((r) => f.session.readDetail(r._id));
	expect(retained()).toHaveLength(64);
	f.open(0);
	f.open(1);
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[1]._id);
	f.close();
	expect(retained().length).toBeLessThanOrEqual(64);
	expect(f.network.details()).toHaveLength(0);
});

it('enforces the encoded-body budget without repeatedly fetching the body that exceeded it', async () => {
	const f = fixture(20),
		large = 'x'.repeat(3 * 1024 * 1024);
	f.session.itemPreload!(f.data.records.map((r) => r._id));
	await settle();
	f.network.publishDetails(
		f.data.records.map((record, i) =>
			f.data.detail(i, i < 2 ? { ...record, instructions: { summary: large } } : record)
		)
	);
	await settle();
	const retained = f.data.records.map((r) => f.session.readDetail(r._id)).filter((r) => r !== null);
	const bytes = retained.reduce(
		(sum, r) => sum + new TextEncoder().encode(JSON.stringify(r)).byteLength,
		0
	);
	expect(bytes).toBeGreaterThan(3 * 1024 * 1024);
	expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
	expect(f.session.readDetail(f.data.records[1]._id)).toBeNull();
	expect(f.session.readDetail(f.data.records[2]._id)).not.toBeNull();
	const calls = f.network.onUpdate.mock.calls.length;
	for (let i = 0; i < 10; i++) f.session.acceptSource();
	await settle();
	expect(f.network.onUpdate).toHaveBeenCalledTimes(calls);
});

it('optional arrivals do not notify the foreground projection or reaccept document content', async () => {
	const f = fixture(),
		accept = vi.fn();
	f.session.itemPreload!(f.data.records.slice(0, 5).map((r) => r._id));
	const release = observe(
		() => f.session.hydratedDetails,
		(details) => {
			accept(details);
			f.source.accept({
				blocks: { data: f.data.blocks },
				kind: 'structure',
				structure: { data: f.data.structure },
				details: details.filter(isRepItem)
			});
		}
	);
	cleanups.push(release);
	await settle();
	const projection = f.session.hydratedDetails,
		renderSource = f.source.renderSource;
	const calls = accept.mock.calls.length;
	for (const i of [0, 1, 2, 3, 4]) f.respond(i);
	await settle();
	expect(accept).toHaveBeenCalledTimes(calls);
	expect(f.session.hydratedDetails).toBe(projection);
	expect(f.source.renderSource).toBe(renderSource);
	expect(f.source.domain.metrics.compiledDocumentBuilds).toBe(1);
});

it('releases speculative work on freeze and detach, and ignores callbacks from released reads', async () => {
	const f = fixture(),
		nearby = f.data.records.slice(0, 8).map((r) => r._id);
	f.session.itemPreload!(nearby);
	await settle();
	const old = f.network.details()[0];
	f.lifecycle.freeze(true);
	expect(f.network.details()).toHaveLength(0);
	expect(f.session.itemPreload).toBeUndefined();
	old.update(nearby.map((id, i) => ({ id, content: f.data.detail(i) })));
	await settle();
	expect(f.session.detail(f.data.records[0]._id)).toBeNull();
	f.lifecycle.freeze(false);
	expect(f.network.details()).toHaveLength(0);
	f.session.itemPreload!(nearby);
	await settle();
	expect(f.network.details()).toHaveLength(1);
	f.detach();
	expect(f.network.details()).toHaveLength(0);
	expect(f.session.itemPreload).toBeUndefined();
	expect(f.network.live('playbookItems:currentStructure')).toHaveLength(1);
	f.session.destroy();
	expect(f.network.live('playbookItems:currentStructure')).toHaveLength(0);
	expect(f.network.details()).toHaveLength(0);
	flushSync();
});
