import { validBookingUid, type ProviderBooking } from './csmCal';

export type PendingSuccessors = { uids: string[]; overflow: boolean };
type PendingRow = {
	currentUid: string;
	pendingSuccessors?: PendingSuccessors;
	successorHint?: string;
};

/** Canonicalize old and new writers together. Lost/unreadable obligations latch overflow. */
export function pendingSuccessors(row: PendingRow, hint?: string): PendingSuccessors {
	const pending: PendingSuccessors = {
		uids: [],
		overflow: row.pendingSuccessors?.overflow ?? false
	};
	for (const uid of [...(row.pendingSuccessors?.uids ?? []), row.successorHint, hint]) {
		if (uid === undefined) continue;
		if (!validBookingUid(uid)) pending.overflow = true;
		else if (uid !== row.currentUid && !pending.uids.includes(uid)) {
			if (pending.uids.length < 8) pending.uids.push(uid);
			else pending.overflow = true;
		}
	}
	if (!validBookingUid(row.currentUid)) pending.overflow = true;
	return pending;
}

export class SetupChainError extends Error {
	constructor(readonly issue: 'chain' | 'cap') {
		super('Setup chain requires review.');
	}
}
export class SetupDeferredError extends Error {
	constructor(readonly retryAt: number) {
		super('Setup refresh deferred.');
	}
}
export type SetupChainResult =
	| { kind: 'success'; booking: ProviderBooking; anchor: ProviderBooking; proofUids: string[] }
	| { kind: 'failure'; issue: 'provider' | 'chain' | 'cap' }
	| { kind: 'deferred'; retryAt: number };

/** One scoped cache and nine-read envelope, including legacy admission's first record. */
export async function proveSetupChain(
	currentUid: string,
	pending: PendingSuccessors,
	read: (uid: string) => Promise<ProviderBooking>,
	options: { includeAncestors?: boolean; initial?: ProviderBooking } = {}
): Promise<SetupChainResult> {
	try {
		if (pending.overflow) throw new SetupChainError('cap');
		const roots = [currentUid, ...pending.uids];
		if (roots.length > 9 || roots.some((uid) => !validBookingUid(uid)))
			throw new SetupChainError('chain');
		const records = new Map<string, ProviderBooking>();
		if (options.initial) records.set(options.initial.uid, options.initial);
		const get = async (uid: string) => {
			if (!validBookingUid(uid)) throw new SetupChainError('chain');
			let booking = records.get(uid);
			if (!booking) {
				if (records.size >= 9) throw new SetupChainError('cap');
				booking = await read(uid);
				if (booking.uid !== uid) throw new SetupChainError('chain');
				records.set(uid, booking);
			}
			if (booking.fromUid === uid || booking.toUid === uid) throw new SetupChainError('chain');
			return booking;
		};
		const forward = async (uid: string) => {
			const path = new Set<string>();
			while (true) {
				if (path.has(uid)) throw new SetupChainError('chain');
				path.add(uid);
				const booking = await get(uid);
				if (!booking.toUid) return;
				uid = booking.toUid;
			}
		};
		// Validate all fetched evidence, including missing reciprocal links, as one path.
		const graph = () => {
			const next = new Map<string, string>(),
				previous = new Map<string, string>();
			const edge = (parentUid: string, childUid: string) => {
				const parent = records.get(parentUid),
					child = records.get(childUid);
				if (!parent || !child) return;
				if (
					parentUid === childUid ||
					(parent.toUid && parent.toUid !== childUid) ||
					(child.fromUid && child.fromUid !== parentUid) ||
					(next.has(parentUid) && next.get(parentUid) !== childUid) ||
					(previous.has(childUid) && previous.get(childUid) !== parentUid)
				)
					throw new SetupChainError('chain');
				next.set(parentUid, childUid);
				previous.set(childUid, parentUid);
			};
			for (const b of records.values()) {
				if (b.toUid) edge(b.uid, b.toUid);
				if (b.fromUid) edge(b.fromUid, b.uid);
			}
			const leaf = (uid: string) => {
				const path = new Set<string>();
				while (next.has(uid)) {
					if (path.has(uid)) throw new SetupChainError('chain');
					path.add(uid);
					uid = next.get(uid)!;
				}
				return uid;
			};
			const leaves = new Set([...records.keys()].map(leaf));
			return { previous, leafUid: leaves.size === 1 ? [...leaves][0] : undefined };
		};
		for (const uid of roots) await forward(uid);
		// Legacy admission also freezes the earliest authenticated visible predecessor.
		if (options.includeAncestors) {
			let booking = await get(currentUid);
			const path = new Set<string>();
			while (booking.fromUid) {
				if (path.has(booking.uid)) throw new SetupChainError('chain');
				path.add(booking.uid);
				booking = await get(booking.fromUid);
				await forward(booking.uid);
			}
		}
		let connected = graph();
		while (!connected.leafUid) {
			// Search both sides for authenticated predecessor evidence. Cached one-sided
			// links are joined first, so a delayed ancestor cannot roll current backwards.
			const boundary = [...records.values()].find((b) => b.fromUid && !records.has(b.fromUid));
			if (!boundary?.fromUid) throw new SetupChainError('chain');
			await forward(boundary.fromUid);
			connected = graph();
		}
		const booking = records.get(connected.leafUid)!;
		if (booking.toUid) throw new SetupChainError('chain');
		let anchorUid = booking.uid;
		while (connected.previous.has(anchorUid)) anchorUid = connected.previous.get(anchorUid)!;
		return {
			kind: 'success',
			booking,
			anchor: records.get(anchorUid)!,
			proofUids: [...records.keys()]
		};
	} catch (error) {
		if (error instanceof SetupDeferredError) return { kind: 'deferred', retryAt: error.retryAt };
		return { kind: 'failure', issue: error instanceof SetupChainError ? error.issue : 'provider' };
	}
}

/** Receiver checks the certificate against persisted obligations, never an action-side boolean. */
export function coversSetupProof(
	proofUids: string[],
	required: string[],
	pending: PendingSuccessors
) {
	return (
		!pending.overflow &&
		proofUids.length > 0 &&
		proofUids.length <= 9 &&
		proofUids.every(validBookingUid) &&
		new Set(proofUids).size === proofUids.length &&
		[...required, ...pending.uids].every((uid) => proofUids.includes(uid))
	);
}
