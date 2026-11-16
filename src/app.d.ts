import type { AuthObject } from '@clerk/backend';

declare global {
	namespace App {
		interface Locals {
			auth?: () => AuthObject;
			buyerPageCredential?: () => Promise<import('$lib/server/buyer-token').BuyerCredential>;
		}
		interface PageData {
			workspaceHints?: import('$lib/auth/workspace-hint-cookie').WorkspaceHintSeed | null;
			startup?: Promise<import('$lib/auth/startup-data').StartupData | null> | null;
		}
	}
}

export {};
