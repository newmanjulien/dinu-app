import type { AuthObject } from '@clerk/backend';

declare global {
	namespace App {
		interface Locals {
			auth?: () => AuthObject;
		}
		interface PageData {
			startup?: Promise<import('$lib/auth/startup-data').StartupData | null> | null;
		}
	}
}

export {};
