import { tick } from 'svelte';
import type { SignInFutureResource, SignUpFutureResource } from '@clerk/shared/types';

type ClerkMutationResult = { error: unknown | null };
type SignInEmailCodeFactor = Extract<
	SignInFutureResource['supportedFirstFactors'][number],
	{ strategy: 'email_code' }
>;

export type ClerkEmailCodeAuthController = {
	sendJoinCode(email: string): Promise<void>;
	sendLoginCode(email: string): Promise<void>;
	sendInvitationCode(email: string): Promise<void>;
	acceptTicket(ticket: string): Promise<void>;
	acceptSignInTicket(ticket: string): Promise<void>;
	verifyCode(code: string): Promise<void>;
	resendCode(): Promise<void>;
	reset(): void;
	getErrorMessage(error: unknown): string;
};

type ClerkEmailCodeAuthControllerDeps = {
	getSignIn: () => SignInFutureResource | null;
	getSignUp: () => SignUpFutureResource | null;
	waitForClerkUpdate?: () => Promise<void>;
};

// Clerk shares its current resources across mounted flows. Drain abandoned requests
// before starting another operation so their responses cannot replace a newer attempt.
let pendingOperation: Promise<void> = Promise.resolve();

export function createClerkEmailCodeAuthController({
	getSignIn,
	getSignUp,
	waitForClerkUpdate = tick
}: ClerkEmailCodeAuthControllerDeps): ClerkEmailCodeAuthController {
	let generation = 0;
	let attempt:
		| { mode: 'signIn' | 'invitation'; id: string; emailAddressId?: string }
		| { mode: 'signUp'; id: string }
		| null = null;

	function reset() {
		generation++;
		attempt = null;
	}

	function check(current: number) {
		if (current !== generation) throw new Error('This authentication attempt was abandoned.');
	}

	function run(operation: (current: number) => Promise<void>) {
		const current = generation;
		const result = pendingOperation.then(() => {
			check(current);
			return operation(current);
		});
		pendingOperation = result.catch(() => {});
		return result;
	}

	async function mutate(current: number, result: Promise<ClerkMutationResult>) {
		const completed = await result;
		check(current);
		throwIfClerkError(completed);
		await waitForClerkUpdate();
		check(current);
	}

	function requireResource<T extends { readonly id?: string }>(resource: T | null, id?: string): T {
		if (!resource) throw new Error('Clerk is still loading.');
		if (id && resource.id !== id) throw new Error('Start the email verification again.');
		return resource;
	}

	function begin(email: string, mode: 'signIn' | 'signUp' | 'invitation') {
		const normalized = email.trim().toLowerCase();
		if (!normalized) return Promise.reject(new Error('Enter your work email.'));
		reset();
		return run(async (current) => {
			if (mode !== 'signUp') {
				await mutate(
					current,
					requireResource(getSignIn()).create({
						identifier: normalized,
						...(mode === 'invitation' ? { signUpIfMissing: true } : {})
					})
				);
				const signIn = requireResource(getSignIn());
				const factor =
					mode === 'signIn' ? signIn.supportedFirstFactors.find(isEmailCodeFactor) : undefined;
				if (mode === 'signIn' && !factor)
					throw new Error('Email code sign-in is not enabled in Clerk.');
				if (!signIn.id) throw new Error('Start the email verification again.');
				const id = signIn.id;
				const emailAddressId = factor?.emailAddressId;
				await mutate(current, signIn.emailCode.sendCode({ emailAddressId }));
				requireResource(getSignIn(), id);
				attempt = { mode, id, emailAddressId };
			} else {
				await mutate(current, requireResource(getSignUp()).create({ emailAddress: normalized }));
				const signUp = requireResource(getSignUp());
				if (!signUp.id) throw new Error('Start the email verification again.');
				const id = signUp.id;
				await mutate(current, signUp.verifications.sendEmailCode());
				requireResource(getSignUp(), id);
				attempt = { mode, id };
			}
		});
	}

	function verifyCode(code: string) {
		const normalizedCode = code.trim();
		if (!normalizedCode) return Promise.reject(new Error('Enter your verification code.'));
		return run(async (current) => {
			if (!attempt) throw new Error('Start the email verification again.');
			const { mode, id } = attempt;
			if (mode !== 'signUp') {
				const signIn = requireResource(getSignIn(), id);
				if (signIn.status !== 'complete' && !(mode === 'invitation' && signIn.isTransferable))
					await mutate(current, signIn.emailCode.verifyCode({ code: normalizedCode }));
				const verified = requireResource(getSignIn(), id);
				if (mode === 'invitation' && verified.isTransferable) {
					// Clerk carries the verified email into signup; no second code or account choice.
					await mutate(current, requireResource(getSignUp()).create({ transfer: true }));
					const signUp = requireResource(getSignUp());
					if (!signUp.id) throw new Error('Start the email verification again.');
					attempt = { mode: 'signUp', id: signUp.id };
					assertSignUpComplete(signUp);
					await mutate(current, signUp.finalize());
					return;
				}
				assertSignInComplete(verified);
				await mutate(current, verified.finalize());
			} else {
				const signUp = requireResource(getSignUp(), id);
				if (signUp.status !== 'complete')
					await mutate(current, signUp.verifications.verifyEmailCode({ code: normalizedCode }));
				const verified = requireResource(getSignUp(), id);
				assertSignUpComplete(verified);
				await mutate(current, verified.finalize());
			}
		});
	}

	function resendCode() {
		return run(async (current) => {
			if (!attempt) throw new Error('Start the email verification again.');
			if (attempt.mode !== 'signUp') {
				await mutate(
					current,
					requireResource(getSignIn(), attempt.id).emailCode.sendCode({
						emailAddressId: attempt.emailAddressId
					})
				);
			} else {
				await mutate(
					current,
					requireResource(getSignUp(), attempt.id).verifications.sendEmailCode()
				);
			}
		});
	}

	function acceptTicket(ticket: string) {
		reset();
		return run(async (current) => {
			await mutate(current, requireResource(getSignUp()).create({ strategy: 'ticket', ticket }));
			const signUp = requireResource(getSignUp());
			if (signUp.status !== 'complete')
				throw new Error(
					'This invitation could not finish signup. Continue with your email address.'
				);
			await mutate(current, signUp.finalize());
		});
	}

	function acceptSignInTicket(ticket: string) {
		reset();
		return run(async (current) => {
			await mutate(current, requireResource(getSignIn()).ticket({ ticket }));
			const signIn = requireResource(getSignIn());
			assertSignInComplete(signIn);
			await mutate(current, signIn.finalize());
		});
	}

	return {
		sendJoinCode: (email) => begin(email, 'signUp'),
		sendLoginCode: (email) => begin(email, 'signIn'),
		sendInvitationCode: (email) => begin(email, 'invitation'),
		acceptTicket,
		acceptSignInTicket,
		verifyCode,
		resendCode,
		reset,
		getErrorMessage
	};
}

function throwIfClerkError(result: ClerkMutationResult) {
	if (result.error) {
		throw result.error;
	}
}

export function getClerkErrorCode(error: unknown) {
	const clerkErrors = (error as { errors?: { code?: string }[] })?.errors;
	return clerkErrors?.[0]?.code ?? (error as { code?: string })?.code;
}

export function getErrorMessage(error: unknown) {
	const clerkErrors = (error as { errors?: { longMessage?: string; message?: string }[] })?.errors;
	const clerkError = error as { longMessage?: string; message?: string };
	return (
		clerkErrors?.[0]?.longMessage ??
		clerkErrors?.[0]?.message ??
		clerkError.longMessage ??
		clerkError.message ??
		(error instanceof Error ? error.message : 'Something went wrong.')
	);
}

function describeClerkFields(fields: readonly string[]) {
	return fields.length > 0 ? fields.join(', ') : 'none reported';
}

function assertSignInComplete(signIn: SignInFutureResource) {
	if (signIn.status !== 'complete') {
		throw new Error(`Clerk sign-in is not complete. Current status: ${signIn.status}.`);
	}
}

function assertSignUpComplete(signUp: SignUpFutureResource) {
	if (signUp.status !== 'complete') {
		throw new Error(
			`Clerk sign-up is not complete. Current status: ${signUp.status}. Missing required fields: ${describeClerkFields(signUp.missingFields)}.`
		);
	}
}

function isEmailCodeFactor(
	factor: SignInFutureResource['supportedFirstFactors'][number]
): factor is SignInEmailCodeFactor {
	return factor.strategy === 'email_code';
}
