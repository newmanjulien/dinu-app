import { readFile } from 'node:fs/promises';
import { SaxesParser } from 'saxes';

class SetupError extends Error {}

const templateEnv = {
	invitation: 'LOOPS_INVITATION_ID',
	approval: 'LOOPS_APPROVAL_ID',
	decision: 'LOOPS_DECISION_ID'
};
// These are transactional templates. Contact and event fallbacks belong to
// campaign/workflow messages and make this request needlessly ambiguous.
const fallbackFields = ['dataVariablesFallbacks'];
const updateFields = new Set([
	'expectedRevisionId',
	'subject',
	'previewText',
	'fromName',
	'fromEmail',
	'replyToEmail',
	'ccEmail',
	'bccEmail',
	'languageCode',
	'emailFormat',
	'lmx',
	...fallbackFields
]);
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(`Publish or check Dinu's repository-owned Loops templates; never sends email.

Usage: npm run email:setup [-- --check | --check-source | --diagnose]

Server-side environment:
  LOOPS_API_KEY              Loops key with Content API access
  LOOPS_SENDER_LOCAL_PART    Mailbox before @ on the verified juliennewman.com domain
  LOOPS_INVITATION_ID        Optional explicit invitation template ID
  LOOPS_APPROVAL_ID          Optional explicit approval template ID
  LOOPS_DECISION_ID          Optional explicit completed-review template ID

Default discovers templates by their stable repo names, creates missing templates,
updates and validates all changed drafts, then publishes and verifies them.
Run one publisher at a time; publication has no atomic revision guard.
--check reads published templates without making changes.
--check-source validates repo source without credentials or account requests.
--diagnose makes the same changes as setup but reports only a safely classified
provider validation area on failure; it never prints response bodies or values.
CC/BCC support is required for the completed-review template.
Deployment activation is separate. See docs/email-delivery.md.`);
} else {
	try {
		if (
			args.length > 1 ||
			args.some((arg) => !['--check', '--check-source', '--diagnose'].includes(arg))
		)
			throw new SetupError('Unknown option. Use --help.');
		await main(args[0]);
	} catch (cause) {
		// Provider responses may echo content or addresses. Print only our own diagnostics.
		console.error(cause instanceof SetupError ? cause.message : 'Loops setup failed. Use --help.');
		process.exitCode = 1;
	}
}

/**
 * Compare LMX as Loops renders it: whitespace collapses except in CodeBlock.
 * A template without a repository Style block delegates styling to Loops. The
 * Content API reads that provider default back as a top-level Style block, so
 * it is omitted only when the repository deliberately has no Style of its own.
 */
function canonicalLmx(source, { omitTopLevelStyle = false } = {}) {
	const tokens = [];
	let depth = 0;
	let omittedStyleDepth;
	const tags = [];
	const parser = new SaxesParser();
	parser.on('opentag', (tag) => {
		depth++;
		tags.push(tag.name);
		const omitted =
			omittedStyleDepth !== undefined ||
			(omitTopLevelStyle && depth === 2 && tag.name === 'Style');
		if (omitted && omittedStyleDepth === undefined) omittedStyleDepth = depth;
		if (depth > 1 && !omitted)
			tokens.push(['open', tag.name, Object.entries(tag.attributes).sort()]);
	});
	parser.on('text', (text) => {
		if (depth > 1 && omittedStyleDepth === undefined)
			tokens.push([
				'text',
				tags.includes('CodeBlock') ? text : text.replace(/\s+/g, ' ')
			]);
		else if (text.trim()) throw new SetupError('LMX contains text outside a block.');
	});
	parser.on('closetag', (tag) => {
		const name = tags.pop();
		if (name !== tag.name) throw new SetupError('LMX has an invalid closing tag.');
		const omitted = omittedStyleDepth !== undefined;
		if (depth === omittedStyleDepth) omittedStyleDepth = undefined;
		if (depth-- > 1 && !omitted) tokens.push(['close', tag.name]);
	});
	parser.write(`<Document>${source}</Document>`).close();
	return JSON.stringify(tokens);
}

function hasTopLevelStyle(source) {
	let depth = 0;
	let hasStyle = false;
	const parser = new SaxesParser();
	parser.on('opentag', (tag) => {
		if (++depth === 2 && tag.name === 'Style') hasStyle = true;
	});
	parser.on('closetag', () => depth--);
	parser.write(`<Document>${source}</Document>`).close();
	return hasStyle;
}

/** Safe source-shape diagnostic: never includes provider copy or addresses. */
function lmxShape(source) {
	const blocks = [];
	let textLength = 0;
	let depth = 0;
	const parser = new SaxesParser();
	parser.on('opentag', (tag) => {
		if (++depth === 2) blocks.push(tag.name);
	});
	parser.on('text', (text) => {
		if (depth > 1) textLength += text.replace(/\s+/g, ' ').length;
	});
	parser.on('closetag', () => depth--);
	parser.write(`<Document>${source}</Document>`).close();
	const variables = [
		...new Set(
			Array.from(source.matchAll(/\{(?:data\.|DATA_VARIABLE:)([a-zA-Z0-9_-]+)\}/g), (match) => match[1])
		)
	].sort();
	return `blocks ${blocks.join(', ') || 'none'}; variables ${variables.join(', ') || 'none'}; text ${textLength} characters`;
}

function id(value) {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value))
		throw new SetupError('Invalid Loops resource ID.');
	return value;
}

/** Classify an error without printing provider content, addresses or credentials. */
function providerFailureArea(response) {
	let value;
	try {
		value = JSON.parse(response);
	} catch {
		return 'no safely reportable validation area';
	}
	const candidates = [];
	const collect = (candidate) => {
		if (!candidate || typeof candidate !== 'object') return;
		candidates.push(candidate);
		if (candidate.error) collect(candidate.error);
		if (Array.isArray(candidate.errors)) candidate.errors.forEach(collect);
		if (Array.isArray(candidate.issues)) candidate.issues.forEach(collect);
	};
	collect(value);
	for (const candidate of candidates) {
		const path = candidate.path;
		const field = Array.isArray(path)
			? path.find((part) => typeof part === 'string' && updateFields.has(part))
			: typeof path === 'string'
				? path.split(/[.[\]]/).find((part) => updateFields.has(part))
				: undefined;
		if (field) return field;
	}
	const messages = candidates
		.map((candidate) => (typeof candidate.message === 'string' ? candidate.message : ''))
		.join('\n')
		.toLowerCase();
	if (/\bcc\b|\bbcc\b/.test(messages)) return 'CC/BCC field or template validation';
	if (/sender|from[ -]?email|sending domain/.test(messages)) return 'fromEmail';
	if (/reply[ -]?to/.test(messages)) return 'replyToEmail';
	if (/revision/.test(messages)) return 'expectedRevisionId';
	if (/lmx|markup|xml|paragraph|variable/.test(messages)) return 'lmx or data-variable syntax';
	return 'no safely reportable validation area';
}

async function main(mode) {
	const manifest = JSON.parse(
		await readFile(new URL('../emails/templates.json', import.meta.url), 'utf8')
	);
	if (Object.keys(manifest).sort().join(',') !== Object.keys(templateEnv).sort().join(','))
		throw new SetupError(
			'The repo must define exactly invitation, approval and decision templates.'
		);
	const templates = await Promise.all(
		Object.entries(manifest).map(async ([kind, definition]) => {
			const { name, ...settings } = definition;
			const lmx = (
				await readFile(new URL(`../emails/${kind}.lmx`, import.meta.url), 'utf8')
			).trim();
			canonicalLmx(lmx);
			if (typeof name !== 'string' || !name || typeof settings.subject !== 'string' || !lmx)
				throw new SetupError(`Invalid ${kind} template source.`);
			const variables = [
				...new Set(
					Array.from(
						[lmx, settings.subject, settings.ccEmail ?? '']
							.join('\n')
						.matchAll(/\{(?:data\.|DATA_VARIABLE:)([a-zA-Z0-9_-]+)\}/g),
						(match) => match[1]
					)
				)
			].sort();
			return {
				kind,
				name,
				variables,
				settings: {
					previewText: '',
					fromName: 'Dinu',
					replyToEmail: '',
					dataVariablesFallbacks: {},
					emailFormat: 'plain',
					...settings,
					lmx
				}
			};
		})
	);
	if (mode === '--check-source') {
		for (const template of templates)
			console.log(`${template.kind}: valid XML; variables ${template.variables.join(', ')}`);
		return;
	}
	const apiKey = process.env.LOOPS_API_KEY?.trim();
	const sender = process.env.LOOPS_SENDER_LOCAL_PART?.trim().toLowerCase();
	if (!apiKey) throw new SetupError('Set LOOPS_API_KEY securely in the operator environment.');
	if (
		!sender ||
		sender.length > 64 ||
		!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(sender)
	)
		throw new SetupError(
			'Set LOOPS_SENDER_LOCAL_PART to the mailbox before @ on your verified Loops domain.'
		);

	async function request(path, method = 'GET', body) {
		let response;
		try {
			response = await fetch(`https://app.loops.so/api/v1/${path}`, {
				method,
				redirect: 'error',
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000)
			});
		} catch {
			throw new SetupError(
				`Loops ${method} could not be confirmed. No request was retried; inspect the account if creation was uncertain.`
			);
		}
		if (!response.ok) {
			const diagnostic =
				mode === '--diagnose'
					? ` Provider validation area: ${providerFailureArea(await response.text())}.`
					: '';
			const guidance =
				response.status === 422
					? 'Loops rejected the LMX source during compilation.'
					: 'Check Content API access, verified domain and template configuration.';
			throw new SetupError(
				`Loops ${method} returned HTTP ${response.status}. ${guidance}${diagnostic}`
			);
		}
		let value;
		try {
			value = await response.json();
		} catch {
			throw new SetupError(
				`Loops ${method} returned an unreadable response. No request was retried.`
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new SetupError(`Loops ${method} returned an unexpected response.`);
		return value;
	}

	const resources = [];
	const cursors = new Set();
	let cursor;
	do {
		const query = new URLSearchParams({ perPage: '50', ...(cursor ? { cursor } : {}) });
		const page = await request(`transactional-emails?${query}`);
		if (!Array.isArray(page.data) || !page.pagination)
			throw new SetupError('Loops returned an invalid template page.');
		resources.push(...page.data);
		cursor = page.pagination.nextCursor;
		if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor)))
			throw new SetupError('Loops returned an invalid pagination cursor.');
		if (cursor) cursors.add(cursor);
	} while (cursor);

	// Resolve all identities before publishing. Partial runs rediscover created templates.
	const chosenIds = new Set();
	for (const template of templates) {
		const explicitId = process.env[templateEnv[template.kind]]?.trim();
		const matches = resources.filter((resource) => resource.name === template.name);
		if (!explicitId && matches.length > 1)
			throw new SetupError(
				`Duplicate ${template.kind} templates: set ${templateEnv[template.kind]} to the intended resource ID.`
			);
		template.resource = explicitId
			? await request(`transactional-emails/${id(explicitId)}`)
			: matches[0];
		if (
			template.resource &&
			(template.resource.name !== template.name ||
				(explicitId && template.resource.id !== explicitId))
		)
			throw new SetupError(`The explicit ${template.kind} ID belongs to a different template.`);
		if (template.resource) {
			const resourceId = id(template.resource.id);
			if (chosenIds.has(resourceId))
				throw new SetupError('Each notification requires its own transactional ID.');
			chosenIds.add(resourceId);
		} else if (mode === '--check')
			throw new SetupError(`The ${template.kind} template does not exist.`);
	}

	function difference(message, expected) {
		// The editor's stored header spelling and LMX namespaces refer to the same variables.
		const header = (value) =>
			typeof value === 'string'
				? value.replace(/\{DATA_VARIABLE:([a-zA-Z0-9_-]+)\}/g, '{data.$1}')
				: value;
		for (const [key, value] of Object.entries(expected)) {
			const actual = message[key];
			if (key === 'lmx') {
				if (
					typeof actual !== 'string' ||
					canonicalLmx(actual, { omitTopLevelStyle: !hasTopLevelStyle(value) }) !==
						canonicalLmx(value)
				)
					return key;
			} else if (value && typeof value === 'object') {
				if (
					(actual != null && (typeof actual !== 'object' || Array.isArray(actual))) ||
					JSON.stringify(Object.entries(actual ?? {}).sort()) !==
						JSON.stringify(Object.entries(value).sort())
				)
					return key;
			} else if (
				header(actual) !== header(value) &&
				!(value === '' && (actual === undefined || actual === null))
			)
				return key;
		}
		return null;
	}
	function verifyMessage(message, messageId, transactionalId) {
		if (message.id !== messageId || message.transactionalId !== transactionalId)
			throw new SetupError('Loops returned an email message with a different identity.');
		if (
			message.warnings !== undefined &&
			(!Array.isArray(message.warnings) || message.warnings.length)
		)
			throw new SetupError('Loops returned unverified compiler warnings; publication stopped.');
		return message;
	}
	async function readMessage(messageId, transactionalId) {
		return verifyMessage(
			await request(`email-messages/${id(messageId)}`),
			messageId,
			transactionalId
		);
	}
	async function publishedDifference(template, transactional, draft) {
		if (!transactional.publishedEmailMessageId) return 'publication';
		const message = await readMessage(transactional.publishedEmailMessageId, transactional.id);
		if (draft && (message.id !== draft.messageId || message.contentRevisionId !== draft.revisionId))
			return 'published draft/revision';
		const changed = difference(message, template.expected);
		if (changed) return changed;
		if (
			!Array.isArray(transactional.dataVariables) ||
			JSON.stringify([...transactional.dataVariables].sort()) !== JSON.stringify(template.variables)
		)
			return 'data variables';
		return null;
	}
	async function validateDraft(template) {
		const { resource, draft, expected } = template;
		const current = await request(`transactional-emails/${id(resource.id)}`);
		if (
			current.id !== resource.id ||
			current.name !== template.name ||
			current.draftEmailMessageId !== draft.messageId
		)
			throw new SetupError(`The ${template.kind} draft identity changed; publication stopped.`);
		const message = await readMessage(draft.messageId, resource.id);
		if (message.contentRevisionId !== draft.revisionId)
			throw new SetupError(`The ${template.kind} draft revision changed; publication stopped.`);
		const changed = difference(message, expected);
		if (changed) {
			const diagnostic =
				mode === '--diagnose' && changed === 'lmx'
					? ` Expected ${lmxShape(expected.lmx)}. Stored ${lmxShape(message.lmx)}.`
					: '';
			throw new SetupError(
				`The saved ${template.kind} draft differs from the repo in ${changed}; publication stopped.${diagnostic}`
			);
		}
	}

	// Prepare every changed draft before any publication. Published variables describe
	// the live version, so draft validation uses its actual source and configuration.
	for (const template of templates) {
		const expected = (template.expected = { ...template.settings, fromEmail: sender });
		const transactional = template.resource;
		const changed = transactional ? await publishedDifference(template, transactional) : 'missing';
		if (changed && mode === '--check')
			throw new SetupError(
				`The published ${template.kind} template differs from the repo in ${changed}.`
			);
		if (changed) {
			const draft = transactional
				? await request(`transactional-emails/${id(transactional.id)}/draft`, 'POST')
				: await request('transactional-emails', 'POST', { name: template.name });
			const transactionalId = id(draft.id);
			if (
				draft.name !== template.name ||
				(transactional && transactionalId !== transactional.id) ||
				(!transactional && chosenIds.has(transactionalId))
			)
				throw new SetupError(
					`Loops returned a different ${template.kind} resource while preparing its draft.`
				);
			console.log(`${templateEnv[template.kind]}=${transactionalId}`);
			chosenIds.add(transactionalId);
			if (
				!draft.draftEmailMessageId ||
				typeof draft.draftEmailMessageContentRevisionId !== 'string' ||
				!draft.draftEmailMessageContentRevisionId
			)
				throw new SetupError(
					`Loops did not return the ${template.kind} draft and revision. Reuse the printed ID.`
				);
			const messageId = id(draft.draftEmailMessageId);
			const before = await readMessage(messageId, transactionalId);
			if (before.contentRevisionId !== draft.draftEmailMessageContentRevisionId)
				throw new SetupError(
					`The ${template.kind} draft revision changed before update; publication stopped.`
				);
			// Fallback maps merge per key: {} does not remove stale provider values.
			const update = { ...expected, expectedRevisionId: before.contentRevisionId };
			for (const field of fallbackFields)
				update[field] = {
					...Object.fromEntries(Object.keys(before[field] ?? {}).map((key) => [key, null])),
					...expected[field]
				};
			const updated = verifyMessage(
				await request(`email-messages/${messageId}`, 'POST', update),
				messageId,
				transactionalId
			);
			if (typeof updated.contentRevisionId !== 'string' || !updated.contentRevisionId)
				throw new SetupError(
					`Loops did not return the updated ${template.kind} revision; publication stopped.`
				);
			template.resource = draft;
			template.draft = { messageId, revisionId: updated.contentRevisionId };
		} else {
			console.log(`${templateEnv[template.kind]}=${id(transactional.id)}`);
			console.log(`Published ${template.kind} template matches the repo.`);
		}
	}
	const changedTemplates = templates.filter((template) => template.draft);
	for (const template of changedTemplates) await validateDraft(template);
	const attempted = [];
	const verified = [];
	try {
		for (const template of changedTemplates) {
			// Publish has no expectedRevisionId. Recheck immediately before the call,
			// but require an exclusive publisher: this is not an atomic revision lock.
			await validateDraft(template);
			attempted.push(template.kind);
			await request(`transactional-emails/${id(template.resource.id)}/publish`, 'POST');
			const published = await request(`transactional-emails/${id(template.resource.id)}`);
			if (published.id !== template.resource.id || published.name !== template.name)
				throw new SetupError('Loops returned a different published template identity.');
			const changed = await publishedDifference(template, published, template.draft);
			if (changed)
				throw new SetupError(
					`The published ${template.kind} template differs from the repo in ${changed}.`
				);
			verified.push(template.kind);
			console.log(`Published ${template.kind} template matches the repo.`);
		}
	} catch (cause) {
		console.error(
			`Publication batch stopped; published versions may be mixed. Attempted: ${attempted.join(', ') || 'none'}. Verified: ${verified.join(', ') || 'none'}. Run --check before activation.`
		);
		throw cause;
	}
	console.log(
		'Configuration checked. Provider rendering, To/CC delivery and live Convex runtime remain unverified.'
	);
}
