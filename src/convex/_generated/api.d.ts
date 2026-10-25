/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountDeletion from "../accountDeletion.js";
import type * as admin from "../admin.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as baselineParser from "../baselineParser.js";
import type * as baselineStorage from "../baselineStorage.js";
import type * as baselineUploadValidators from "../baselineUploadValidators.js";
import type * as baselineUploads from "../baselineUploads.js";
import type * as clerk from "../clerk.js";
import type * as companies from "../companies.js";
import type * as companyDeletion from "../companyDeletion.js";
import type * as companyInvitations from "../companyInvitations.js";
import type * as companyTemplateImport from "../companyTemplateImport.js";
import type * as contract from "../contract.js";
import type * as contractDirectory from "../contractDirectory.js";
import type * as contractEmail from "../contractEmail.js";
import type * as contractExports from "../contractExports.js";
import type * as contractValidators from "../contractValidators.js";
import type * as crons from "../crons.js";
import type * as decisionNotifications from "../decisionNotifications.js";
import type * as delegation from "../delegation.js";
import type * as delegationUploads from "../delegationUploads.js";
import type * as delegationValidators from "../delegationValidators.js";
import type * as emailDeliveries from "../emailDeliveries.js";
import type * as emailMigration from "../emailMigration.js";
import type * as emailSnapshots from "../emailSnapshots.js";
import type * as emailValidators from "../emailValidators.js";
import type * as http from "../http.js";
import type * as invitationEmail from "../invitationEmail.js";
import type * as invitationLinks from "../invitationLinks.js";
import type * as invitationValidators from "../invitationValidators.js";
import type * as permissions from "../permissions.js";
import type * as playbookItemRevisions from "../playbookItemRevisions.js";
import type * as playbookItems from "../playbookItems.js";
import type * as playbookValidators from "../playbookValidators.js";
import type * as profiles from "../profiles.js";
import type * as reviewAttributions from "../reviewAttributions.js";
import type * as savedContractValidators from "../savedContractValidators.js";
import type * as savedContracts from "../savedContracts.js";
import type * as settings from "../settings.js";
import type * as smtpEmail from "../smtpEmail.js";
import type * as sourceValidators from "../sourceValidators.js";
import type * as storageOwnership from "../storageOwnership.js";
import type * as templateCapacity from "../templateCapacity.js";
import type * as templates from "../templates.js";
import type * as wordExport from "../wordExport.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  admin: typeof admin;
  approvals: typeof approvals;
  auth: typeof auth;
  baselineParser: typeof baselineParser;
  baselineStorage: typeof baselineStorage;
  baselineUploadValidators: typeof baselineUploadValidators;
  baselineUploads: typeof baselineUploads;
  clerk: typeof clerk;
  companies: typeof companies;
  companyDeletion: typeof companyDeletion;
  companyInvitations: typeof companyInvitations;
  companyTemplateImport: typeof companyTemplateImport;
  contract: typeof contract;
  contractDirectory: typeof contractDirectory;
  contractEmail: typeof contractEmail;
  contractExports: typeof contractExports;
  contractValidators: typeof contractValidators;
  crons: typeof crons;
  decisionNotifications: typeof decisionNotifications;
  delegation: typeof delegation;
  delegationUploads: typeof delegationUploads;
  delegationValidators: typeof delegationValidators;
  emailDeliveries: typeof emailDeliveries;
  emailMigration: typeof emailMigration;
  emailSnapshots: typeof emailSnapshots;
  emailValidators: typeof emailValidators;
  http: typeof http;
  invitationEmail: typeof invitationEmail;
  invitationLinks: typeof invitationLinks;
  invitationValidators: typeof invitationValidators;
  permissions: typeof permissions;
  playbookItemRevisions: typeof playbookItemRevisions;
  playbookItems: typeof playbookItems;
  playbookValidators: typeof playbookValidators;
  profiles: typeof profiles;
  reviewAttributions: typeof reviewAttributions;
  savedContractValidators: typeof savedContractValidators;
  savedContracts: typeof savedContracts;
  settings: typeof settings;
  smtpEmail: typeof smtpEmail;
  sourceValidators: typeof sourceValidators;
  storageOwnership: typeof storageOwnership;
  templateCapacity: typeof templateCapacity;
  templates: typeof templates;
  wordExport: typeof wordExport;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
