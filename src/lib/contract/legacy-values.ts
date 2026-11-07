/** One-time format conversions. These preserve identities and never create a new operation. */
type Row = Record<string, unknown>;
function row(value: unknown): Row {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Expected a stored record.');
	return value as Row;
}
function entries(value: unknown) {
	return Object.entries(row(value));
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error('Expected a stored array.');
	return value;
}
function rename(value: Row, old: string, name: string) {
	if (!(old in value)) return;
	if (name in value && value[name] !== value[old]) throw new Error(`Conflicting stored ${name}.`);
	value[name] = value[old];
	delete value[old];
}

export function legacyChoices(selections: unknown, identities: unknown = {}) {
	const applications = row(identities);
	const result = Object.fromEntries(
		entries(selections).map(([id, concessionId]) => {
			if (typeof concessionId !== 'string') throw new Error('Invalid stored concession identity.');
			const applicationId = applications[id];
			if (applicationId !== undefined && typeof applicationId !== 'string')
				throw new Error('Invalid stored application identity.');
			return [id, { concessionId, ...(applicationId === undefined ? {} : { applicationId }) }];
		})
	);
	if (Object.keys(applications).some((id) => !Object.hasOwn(result, id)))
		throw new Error('Orphaned stored application identity.');
	return result;
}

export function legacyContract(value: unknown): Row {
	const result = { ...row(value) };
	if (!('applications' in result)) {
		const reviews = row(result.reviews);
		result.applications = Object.fromEntries(
			entries(result.selectedConcessions).map(([id, concessionId]) => {
				if (typeof concessionId !== 'string')
					throw new Error('Invalid stored concession identity.');
				const review = reviews[id] === undefined ? undefined : row(reviews[id]);
				if (review && review.concessionId !== concessionId)
					throw new Error('Stored review belongs to another concession.');
				return [
					id,
					{
						concessionId,
						...(review
							? {
									approval: {
										applicationId: review.applicationId ?? review.lifecycle,
										status: review.status
									}
								}
							: {})
					}
				];
			})
		);
		if (Object.keys(reviews).some((id) => !Object.hasOwn(row(result.applications), id)))
			throw new Error('Orphaned stored review.');
		delete result.selectedConcessions;
		delete result.reviews;
	}
	rename(result, 'companyName', 'buyerCompanyName');
	rename(result, 'revision', 'editRevision');
	return result;
}

export function legacyPlaybook(value: unknown): Row {
	const result = { ...row(value) };
	const instructions =
		result.instructions === undefined ? undefined : { ...row(result.instructions) };
	if (!('approvalPolicy' in result)) {
		const guidance = instructions?.changesNeedApproval;
		if (guidance !== undefined && typeof guidance !== 'string')
			throw new Error('Invalid stored approval instructions.');
		result.approvalPolicy =
			typeof guidance === 'string' && guidance.trim()
				? { kind: 'required', instructions: guidance }
				: { kind: 'none' };
	}
	if (instructions) {
		delete instructions.changesNeedApproval;
		result.instructions = instructions;
	}
	const trigger = { ...row(result.trigger) };
	rename(trigger, 'range', 'target');
	result.trigger = trigger;
	result.concessions = array(result.concessions).map((value) => {
		const concession = { ...row(value) };
		concession.changes = array(concession.changes).map((value) => {
			const change = { ...row(value) };
			rename(change, 'range', 'target');
			return change;
		});
		return concession;
	});
	rename(result, 'revision', 'contentRevision');
	rename(result, 'publishedRevisionId', 'currentRevisionId');
	if ('lastOperationId' in result || 'lastOperationCaller' in result) {
		if (
			typeof result.lastOperationId !== 'string' ||
			typeof result.lastOperationCaller !== 'string'
		)
			throw new Error('Incomplete stored replay identity.');
		result.lastOperation = { id: result.lastOperationId, callerId: result.lastOperationCaller };
		delete result.lastOperationId;
		delete result.lastOperationCaller;
	}
	return result;
}

export function legacyEmailSelection(value: unknown): Row {
	const result = { ...row(value) };
	const applicationId = result.applicationId ?? result.lifecycle;
	if (applicationId !== undefined || result.reviewStatus !== undefined) {
		if (
			typeof applicationId !== 'string' ||
			(result.reviewStatus !== 'pending' &&
				result.reviewStatus !== 'approved' &&
				result.reviewStatus !== 'rejected')
		)
			throw new Error('Incomplete stored email approval.');
		result.approval = { applicationId, status: result.reviewStatus };
		delete result.applicationId;
		delete result.lifecycle;
		delete result.reviewStatus;
	}
	return result;
}

/** Used only by the staged administrative conversion, never ordinary application reads. */
export function legacyRow(table: string, value: unknown): Row {
	const result = { ...row(value) };
	switch (table) {
		case 'baselines':
			if (result.state === 'published') result.state = 'active';
			rename(result, 'publishedAt', 'activatedAt');
			break;
		case 'playbookItems':
			return legacyPlaybook(result);
		case 'playbookItemRevisions':
			result.body = legacyPlaybook(result.body);
			rename(result, 'revision', 'contentRevision');
			rename(result, 'draftVersionId', 'mutableVersionId');
			break;
		case 'savedContracts':
			return legacyContract(result);
		case 'contractDirectory':
		case 'approvalRequests':
			rename(result, 'companyName', 'buyerCompanyName');
			break;
		case 'concessionDecisions':
			rename(result, 'lifecycle', 'applicationId');
			break;
		case 'templateVersions':
			rename(result, 'publishedAt', 'updatedAt');
			if ('draft' in result) {
				if (typeof result.draft !== 'boolean')
					throw new Error('Invalid stored template mutability.');
				result.mutability = result.draft ? 'mutable' : 'frozen';
				delete result.draft;
			}
			break;
		case 'emailDeliveries': {
			const event = { ...row(result.event) };
			if (event.kind === 'approval' || event.kind === 'decision')
				rename(event, 'companyName', 'buyerCompanyName');
			result.event = event;
			break;
		}
		case 'emailSnapshots':
		case 'emailSelectionChunks':
			result.selections = array(result.selections).map(legacyEmailSelection);
			break;
		case 'companyDeletions':
			if (result.phase === 'emailSnapshots') result.phase = 'emailSelectionChunks';
			break;
	}
	return result;
}
