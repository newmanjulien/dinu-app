import type {
	SessionResource,
	SessionVerificationFirstFactor,
	SessionVerificationResource,
	SessionVerificationSecondFactor,
	SessionVerifyPrepareFirstFactorParams,
	SessionVerifyPrepareSecondFactorParams
} from '@clerk/shared/types';
import { getErrorMessage } from './account-errors';

export type ClerkSessionVerificationStatus = 'idle' | 'preparing' | 'awaitingInput' | 'verifying';
export type ClerkSessionVerificationFactor =
	| { level: 'first_factor'; strategy: 'password' }
	| {
			level: 'first_factor';
			strategy: 'email_code';
			safeIdentifier: string;
	  }
	| {
			level: 'first_factor';
			strategy: 'phone_code';
			safeIdentifier: string;
	  }
	| { level: 'first_factor'; strategy: 'passkey' }
	| {
			level: 'second_factor';
			strategy: 'phone_code';
			safeIdentifier: string;
	  }
	| { level: 'second_factor'; strategy: 'totp' }
	| { level: 'second_factor'; strategy: 'backup_code' };

type SupportedFirstFactor = Extract<
	SessionVerificationFirstFactor,
	{ strategy: 'password' | 'email_code' | 'phone_code' | 'passkey' }
>;
type SupportedSecondFactor = Extract<
	SessionVerificationSecondFactor,
	{ strategy: 'phone_code' | 'totp' | 'backup_code' }
>;

type ResendParams =
	| { level: 'first_factor'; params: SessionVerifyPrepareFirstFactorParams }
	| { level: 'second_factor'; params: SessionVerifyPrepareSecondFactorParams };

type CreateClerkSessionVerificationOptions = {
	isCurrent: (session: SessionResource) => boolean;
	onComplete: (session: SessionResource) => Promise<void> | void;
};

export function needsStrictReverification(session: SessionResource) {
	try {
		return !session.checkAuthorization({ reverification: 'strict' });
	} catch {
		return true;
	}
}

// Shared across modal instances: Clerk verification state belongs to the session.
const verificationQueues = new Map<string, Promise<void>>();
function enqueueVerification(sessionId: string, work: () => Promise<void>) {
	const previous = verificationQueues.get(sessionId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(work);
	verificationQueues.set(sessionId, next);
	void next
		.finally(() => {
			if (verificationQueues.get(sessionId) === next) verificationQueues.delete(sessionId);
		})
		.catch(() => {});
	return next;
}

export function createClerkSessionVerification(options: CreateClerkSessionVerificationOptions) {
	let status = $state<ClerkSessionVerificationStatus>('idle');
	let factor = $state<ClerkSessionVerificationFactor | null>(null);
	let input = $state('');
	let errorText = $state<string | null>(null);
	let resendNotice = $state<string | null>(null);
	let resending = $state(false);
	let resendParams = $state<ResendParams | null>(null);
	let generation = 0;
	type Attempt = { session: SessionResource; sessionId: string; generation: number };
	let attempt: Attempt | null = null;
	const busy = $derived(status === 'preparing' || status === 'verifying' || resending);
	const canSubmit = $derived(
		status === 'awaitingInput' &&
			!resending &&
			factor !== null &&
			(factor.strategy === 'passkey' || input.trim().length > 0)
	);
	const canResend = $derived(status === 'awaitingInput' && !busy && resendParams !== null);
	function current(a: Attempt) {
		return (
			a.generation === generation && a.session.id === a.sessionId && options.isCurrent(a.session)
		);
	}
	function reset() {
		generation++;
		attempt = null;
		status = 'idle';
		factor = null;
		input = '';
		errorText = null;
		resendNotice = null;
		resending = false;
		resendParams = null;
	}
	function clearError() {
		errorText = null;
		resendNotice = null;
	}
	function unsupported(a: Attempt) {
		if (!current(a)) return;
		status = 'idle';
		factor = null;
		resendParams = null;
		errorText = 'This action requires a verification method that is not supported here.';
	}
	function expired(a: Attempt) {
		if (!current(a)) return;
		status = 'idle';
		factor = null;
		resendParams = null;
		errorText = 'Your verification session expired. Try again to request a new code.';
	}
	async function run(a: Attempt, work: () => Promise<void>, fallback: string) {
		await enqueueVerification(a.sessionId, async () => {
			if (!current(a)) return;
			try {
				await work();
			} catch (error) {
				if (!current(a)) return;
				errorText = getErrorMessage(error, fallback);
				status = factor ? 'awaitingInput' : 'idle';
			}
		});
	}
	async function start(session: SessionResource) {
		reset();
		const a = { session, sessionId: session.id, generation };
		attempt = a;
		if (!current(a)) return;
		status = 'preparing';
		await run(
			a,
			async () => {
				if (!current(a)) return;
				const result = await a.session.startVerification({ level: 'second_factor' });
				if (!current(a)) return;
				await handleResult(a, result);
			},
			'Unable to start identity verification.'
		);
	}
	async function resend() {
		if (!canResend || !attempt || !resendParams) return;
		const a = attempt;
		const prepared = resendParams;
		if (!current(a)) return;
		errorText = null;
		resendNotice = null;
		resending = true;
		await enqueueVerification(a.sessionId, async () => {
			if (!current(a)) return;
			try {
				if (prepared.level === 'first_factor') {
					await a.session.prepareFirstFactorVerification(prepared.params);
				} else {
					await a.session.prepareSecondFactorVerification(prepared.params);
				}
				if (!current(a)) return;
				input = '';
				resendNotice = 'A new verification code has been sent.';
			} catch (error) {
				if (!current(a)) return;
				errorText = getErrorMessage(error, 'Unable to send a new verification code.');
			} finally {
				if (current(a)) resending = false;
			}
		});
	}
	async function submit() {
		if (!canSubmit || !factor || !attempt || busy) return;
		const a = attempt;
		const selectedFactor = factor;
		const value = input;
		if (!current(a)) return;
		errorText = null;
		resendNotice = null;
		status = 'verifying';
		await run(
			a,
			async () => {
				if (!current(a)) return;
				const result =
					selectedFactor.strategy === 'passkey'
						? await a.session.verifyWithPasskey()
						: selectedFactor.level === 'first_factor'
							? await a.session.attemptFirstFactorVerification(
									selectedFactor.strategy === 'password'
										? { strategy: 'password', password: value }
										: { strategy: selectedFactor.strategy, code: value.trim() }
								)
							: await a.session.attemptSecondFactorVerification({
									strategy: selectedFactor.strategy,
									code: value.trim()
								});
				if (!current(a)) return;
				await handleAttemptResult(a, result);
			},
			'Unable to verify your identity.'
		);
	}
	async function handleAttemptResult(a: Attempt, result: SessionVerificationResource) {
		if (!current(a)) return;
		const error = getVerificationError(result, factor);
		if (error) {
			errorText = error.longMessage ?? error.message ?? 'Unable to verify your identity.';
			status = 'awaitingInput';
			return;
		}
		input = '';
		await handleResult(a, result);
	}
	async function handleResult(a: Attempt, result: SessionVerificationResource) {
		if (!current(a)) return;
		errorText = null;
		resendNotice = null;
		if (result.status === 'complete') {
			resendParams = null;
			await options.onComplete(a.session);
			if (!current(a)) return;
			status = 'idle';
			return;
		}
		input = '';
		if (result.status === 'needs_first_factor') {
			const supported = findSupportedFirstFactor(result.supportedFirstFactors);
			if (!supported) {
				unsupported(a);
				return;
			}
			if (supported.strategy === 'email_code' || supported.strategy === 'phone_code') {
				const params = getFirstFactorPreparationParams(supported);
				if (!params) {
					unsupported(a);
					return;
				}
				factor = {
					level: 'first_factor',
					strategy: supported.strategy,
					safeIdentifier: supported.safeIdentifier
				};
				resendParams = { level: 'first_factor', params };
				status = 'preparing';
				if (!current(a)) return;
				await a.session.prepareFirstFactorVerification(params);
				if (!current(a)) return;
				status = 'awaitingInput';
			} else if (supported.strategy === 'passkey') {
				factor = { level: 'first_factor', strategy: 'passkey' };
				resendParams = null;
				status = 'verifying';
				if (!current(a)) return;
				const verified = await a.session.verifyWithPasskey();
				if (!current(a)) return;
				await handleAttemptResult(a, verified);
			} else {
				factor = { level: 'first_factor', strategy: 'password' };
				resendParams = null;
				status = 'awaitingInput';
			}
		} else if (result.status === 'needs_second_factor') {
			const supported = findSupportedSecondFactor(result.supportedSecondFactors);
			if (!supported) {
				unsupported(a);
				return;
			}
			if (supported.strategy === 'phone_code') {
				const params = getSecondFactorPreparationParams(supported);
				if (!params) {
					unsupported(a);
					return;
				}
				factor = {
					level: 'second_factor',
					strategy: 'phone_code',
					safeIdentifier: supported.safeIdentifier
				};
				resendParams = { level: 'second_factor', params };
				status = 'preparing';
				if (!current(a)) return;
				await a.session.prepareSecondFactorVerification(params);
				if (!current(a)) return;
			} else {
				factor = { level: 'second_factor', strategy: supported.strategy };
				resendParams = null;
			}
			status = 'awaitingInput';
		} else {
			expired(a);
		}
	}
	return {
		get status() {
			return status;
		},
		get factor() {
			return factor;
		},
		get input() {
			return input;
		},
		set input(value: string) {
			input = value;
		},
		get errorText() {
			return errorText;
		},
		get resendNotice() {
			return resendNotice;
		},
		get resending() {
			return resending;
		},
		get busy() {
			return busy;
		},
		get canSubmit() {
			return canSubmit;
		},
		get canResend() {
			return canResend;
		},
		clearError,
		reset,
		start,
		resend,
		submit
	};
}

function getVerificationError(
	result: SessionVerificationResource,
	factor: ClerkSessionVerificationFactor | null
) {
	if (!factor) {
		return null;
	}

	return factor.level === 'first_factor'
		? result.firstFactorVerification.error
		: result.secondFactorVerification.error;
}

function findSupportedFirstFactor(factors: SessionVerificationFirstFactor[] | null) {
	return (
		factors?.find((factor): factor is SupportedFirstFactor => {
			return (
				factor.strategy === 'password' ||
				factor.strategy === 'email_code' ||
				factor.strategy === 'phone_code' ||
				factor.strategy === 'passkey'
			);
		}) ?? null
	);
}

function findSupportedSecondFactor(factors: SessionVerificationSecondFactor[] | null) {
	return (
		factors?.find((factor): factor is SupportedSecondFactor => {
			return (
				factor.strategy === 'phone_code' ||
				factor.strategy === 'totp' ||
				factor.strategy === 'backup_code'
			);
		}) ?? null
	);
}

function getFirstFactorPreparationParams(
	factor: SupportedFirstFactor
): SessionVerifyPrepareFirstFactorParams | null {
	switch (factor.strategy) {
		case 'email_code':
			return {
				strategy: 'email_code',
				emailAddressId: factor.emailAddressId
			};
		case 'phone_code':
			return {
				strategy: 'phone_code',
				phoneNumberId: factor.phoneNumberId,
				channel: factor.channel
			};
		case 'passkey':
		case 'password':
			return null;
	}
}

function getSecondFactorPreparationParams(
	factor: SupportedSecondFactor
): SessionVerifyPrepareSecondFactorParams | null {
	if (factor.strategy !== 'phone_code') {
		return null;
	}

	return {
		strategy: 'phone_code',
		phoneNumberId: factor.phoneNumberId
	};
}
