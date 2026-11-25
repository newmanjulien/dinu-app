import { fixtureOperationId } from '../../support/operation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionArgs, type FunctionReference } from 'convex/server';
import type { RequestEvent } from '@sveltejs/kit';
import {
	api,
	internal,
	fixture,
	integrationClock,
	currentContract,
	NOW
} from '../../support/linked-contract';
import { POST } from '../../../src/routes/api/buyer/[token]/download/+server';
import { elements, readDocx, textContent } from './docx';

const boundary = vi.hoisted(() => ({
	clients: 0,
	query: vi.fn(),
	afterSnapshot: undefined as (() => Promise<void>) | undefined
}));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_CONVEX_URL: 'https://test.convex.cloud' } }));
vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		readonly number = ++boundary.clients;
		query(ref: unknown, args: unknown) {
			return boundary.query(ref, args, this.number);
		}
	}
}));
vi.mock('../../../src/lib/server/document/export/word', async (original) => {
	const actual = await original<typeof import('../../../src/lib/server/document/export/word')>();
	return {
		generateWord: async (...args: Parameters<typeof actual.generateWord>) => {
			await boundary.afterSnapshot?.();
			return actual.generateWord(...args);
		}
	};
});

integrationClock();
const buyerCode = 'Ab3Cd4Ef5Gh6I';
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
	});
	vi.setSystemTime(NOW);
	boundary.clients = 0;
	boundary.query.mockReset();
	boundary.afterSnapshot = undefined;
});
async function buyer() {
	const f = await fixture();
	const contract = await currentContract(f);
	const link = await f.t.mutation(internal.buyerLinks.capture, {
		membershipId: f.owner.membershipId,
		id: f.id,
		token: buyerCode,
		operationId: fixtureOperationId('first-link'),
		expectedStateRevision: contract.root.stateRevision
	});
	boundary.query.mockImplementation(
		(
			ref: FunctionReference<'query'>,
			args: {
				token: string;
				displayIdentity?: string;
				templateVersionId?: FunctionArgs<
					typeof api.buyerLinks.templateContent
				>['templateVersionId'];
			}
		) => {
			if (getFunctionName(ref) === 'buyerLinks:currentState')
				return f.root.query(api.buyerLinks.currentState, { token: args.token });
			if (getFunctionName(ref) === 'buyerLinks:templateContent')
				return f.root.query(
					api.buyerLinks.templateContent,
					args as { token: string; templateVersionId: never }
				);
			if (getFunctionName(ref) === 'buyerLinks:authorizeDownload')
				return f.root.query(
					api.buyerLinks.authorizeDownload,
					args as { token: string; displayIdentity: string }
				);
			throw new Error('Unexpected download query');
		}
	);
	const snapshot = await f.root.query(api.buyerLinks.currentState, { token: link.token });
	return { ...f, link, snapshot };
}
const request = (token: string, displayIdentity: unknown) =>
	POST({
		params: { token },
		request: new Request(`https://dinu.example/api/buyer/${token}/download`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayIdentity })
		})
	} as RequestEvent<{ token: string }, '/api/buyer/[token]/download'>);

describe('buyer Word acquisition and final authorization', () => {
	it('serves the displayed document with download headers and reauthorizes through a fresh client', async () => {
		const f = await buyer();
		const response = await request(f.link.token, f.snapshot.displayIdentity);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(response.headers.get('Content-Type')).toBe(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
		expect(response.headers.get('Content-Disposition')).toBe(
			"attachment; filename*=UTF-8''Original%20deal%20%26%20contract%20-%20Contract.docx"
		);
		const parts = await readDocx(await response.blob());
		expect(elements(parts['word/document.xml'], 'w:t').map(textContent)).toEqual([
			'Synthetic contract.'
		]);
		expect(boundary.query.mock.calls.map(([, , client]) => client)).toEqual([1, 1, 2]);
		expect(boundary.query.mock.calls[2].slice(0, 2)).toEqual([
			api.buyerLinks.authorizeDownload,
			{ token: f.link.token, displayIdentity: f.snapshot.displayIdentity }
		]);
	});

	it('refuses a stale displayed identity before generating or authorizing a download', async () => {
		const f = await buyer();
		const generating = vi.fn();
		boundary.afterSnapshot = generating;
		const response = await request(f.link.token, 'f'.repeat(64));
		expect(response.status).toBe(409);
		expect(generating).not.toHaveBeenCalled();
		expect(boundary.query).toHaveBeenCalledTimes(1);
	});

	it.each(['changed', 'revoked', 'deleted'] as const)(
		'does not return Word bytes if the contract is %s after the snapshot is read',
		async (change) => {
			const f = await buyer();
			boundary.afterSnapshot = async () => {
				if (change === 'changed')
					await f.t.mutation(api.contracts.rename, {
						membershipId: f.owner.membershipId,
						id: f.id,
						title: 'New contract title'
					});
				else if (change === 'deleted')
					await f.t.mutation(api.contracts.remove, {
						membershipId: f.owner.membershipId,
						id: f.id
					});
				else await f.t.run(({ db }) => db.patch('buyerLinks', f.link.id, { currentView: null }));
			};
			const response = await request(f.link.token, f.snapshot.displayIdentity);
			expect(response.status).toBe(409);
			expect(response.headers.get('Cache-Control')).toBe('private, no-store');
			expect(response.headers.has('Content-Disposition')).toBe(false);
			expect(await response.text()).toContain('unavailable');
			await expect(
				f.root.query(api.buyerLinks.authorizeDownload, {
					token: f.link.token,
					displayIdentity: f.snapshot.displayIdentity
				})
			).rejects.toThrow('displayed contract changed');
		}
	);

	it.each([undefined, null, '', 'bad', 'F'.repeat(64), 123])(
		'rejects malformed display identity %s before acquiring content',
		async (identity) => {
			const response = await request(buyerCode, identity);
			expect(response.status).toBe(400);
			expect(response.headers.get('Cache-Control')).toBe('private, no-store');
			expect(boundary.query).not.toHaveBeenCalled();
		}
	);
});
