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
import type * as approvalEmail from "../approvalEmail.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as clerk from "../clerk.js";
import type * as companies from "../companies.js";
import type * as companyDeletion from "../companyDeletion.js";
import type * as companyInvitations from "../companyInvitations.js";
import type * as companyTemplateImport from "../companyTemplateImport.js";
import type * as contract from "../contract.js";
import type * as contractValidators from "../contractValidators.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as invitationEmail from "../invitationEmail.js";
import type * as invitationLinks from "../invitationLinks.js";
import type * as invitationValidators from "../invitationValidators.js";
import type * as permissions from "../permissions.js";
import type * as playbookItems from "../playbookItems.js";
import type * as playbookValidators from "../playbookValidators.js";
import type * as profiles from "../profiles.js";
import type * as savedContractValidators from "../savedContractValidators.js";
import type * as savedContracts from "../savedContracts.js";
import type * as settings from "../settings.js";
import type * as sourceValidators from "../sourceValidators.js";
import type * as templates from "../templates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  admin: typeof admin;
  approvalEmail: typeof approvalEmail;
  approvals: typeof approvals;
  auth: typeof auth;
  clerk: typeof clerk;
  companies: typeof companies;
  companyDeletion: typeof companyDeletion;
  companyInvitations: typeof companyInvitations;
  companyTemplateImport: typeof companyTemplateImport;
  contract: typeof contract;
  contractValidators: typeof contractValidators;
  crons: typeof crons;
  http: typeof http;
  invitationEmail: typeof invitationEmail;
  invitationLinks: typeof invitationLinks;
  invitationValidators: typeof invitationValidators;
  permissions: typeof permissions;
  playbookItems: typeof playbookItems;
  playbookValidators: typeof playbookValidators;
  profiles: typeof profiles;
  savedContractValidators: typeof savedContractValidators;
  savedContracts: typeof savedContracts;
  settings: typeof settings;
  sourceValidators: typeof sourceValidators;
  templates: typeof templates;
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
