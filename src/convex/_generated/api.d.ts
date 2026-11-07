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
import type * as accountViews from "../accountViews.js";
import type * as accounts from "../accounts.js";
import type * as admin from "../admin.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as authoringMigration from "../authoringMigration.js";
import type * as authoringValidation from "../authoringValidation.js";
import type * as avatars from "../avatars.js";
import type * as baselineParser from "../baselineParser.js";
import type * as baselineStorage from "../baselineStorage.js";
import type * as baselineUploadValidators from "../baselineUploadValidators.js";
import type * as baselineUploads from "../baselineUploads.js";
import type * as baselineValidators from "../baselineValidators.js";
import type * as baselines from "../baselines.js";
import type * as chunks from "../chunks.js";
import type * as cleanup from "../cleanup.js";
import type * as clerk from "../clerk.js";
import type * as companies from "../companies.js";
import type * as companyDeletion from "../companyDeletion.js";
import type * as companyInvitations from "../companyInvitations.js";
import type * as contract from "../contract.js";
import type * as contractApprovals from "../contractApprovals.js";
import type * as contractCleanup from "../contractCleanup.js";
import type * as contractCleanupValidators from "../contractCleanupValidators.js";
import type * as contractDirectory from "../contractDirectory.js";
import type * as contractEmail from "../contractEmail.js";
import type * as contractExports from "../contractExports.js";
import type * as contractFormatting from "../contractFormatting.js";
import type * as contractPolicy from "../contractPolicy.js";
import type * as contractSaving from "../contractSaving.js";
import type * as contractValidators from "../contractValidators.js";
import type * as contracts from "../contracts.js";
import type * as crons from "../crons.js";
import type * as csmBookingValidators from "../csmBookingValidators.js";
import type * as csmBookings from "../csmBookings.js";
import type * as csmCal from "../csmCal.js";
import type * as csmReplacements from "../csmReplacements.js";
import type * as csmSetupAppointments from "../csmSetupAppointments.js";
import type * as csmSetupChain from "../csmSetupChain.js";
import type * as csmSetupLifecycle from "../csmSetupLifecycle.js";
import type * as csmSetupValidators from "../csmSetupValidators.js";
import type * as deletionPolicy from "../deletionPolicy.js";
import type * as deletionValidators from "../deletionValidators.js";
import type * as emailDeliveries from "../emailDeliveries.js";
import type * as emailDisposal from "../emailDisposal.js";
import type * as emailNotifications from "../emailNotifications.js";
import type * as emailSelectionChunks from "../emailSelectionChunks.js";
import type * as emailSender from "../emailSender.js";
import type * as emailValidators from "../emailValidators.js";
import type * as http from "../http.js";
import type * as hubspotApi from "../hubspotApi.js";
import type * as hubspotCleanup from "../hubspotCleanup.js";
import type * as hubspotConnections from "../hubspotConnections.js";
import type * as hubspotDeals from "../hubspotDeals.js";
import type * as hubspotDelivery from "../hubspotDelivery.js";
import type * as hubspotDeliveryPolicy from "../hubspotDeliveryPolicy.js";
import type * as hubspotExportActions from "../hubspotExportActions.js";
import type * as hubspotExports from "../hubspotExports.js";
import type * as hubspotOAuth from "../hubspotOAuth.js";
import type * as hubspotOperations from "../hubspotOperations.js";
import type * as hubspotProvenance from "../hubspotProvenance.js";
import type * as hubspotRecords from "../hubspotRecords.js";
import type * as hubspotSender from "../hubspotSender.js";
import type * as hubspotValidators from "../hubspotValidators.js";
import type * as invitationDeliverySummary from "../invitationDeliverySummary.js";
import type * as invitationEmail from "../invitationEmail.js";
import type * as invitationLinks from "../invitationLinks.js";
import type * as invitationValidators from "../invitationValidators.js";
import type * as legacyAccounts from "../legacyAccounts.js";
import type * as legacyExports from "../legacyExports.js";
import type * as legacyPlaybook from "../legacyPlaybook.js";
import type * as legacyTemplates from "../legacyTemplates.js";
import type * as legacyViews from "../legacyViews.js";
import type * as loopsEmail from "../loopsEmail.js";
import type * as memberships from "../memberships.js";
import type * as names from "../names.js";
import type * as operator from "../operator.js";
import type * as permissions from "../permissions.js";
import type * as playbookItemRevisions from "../playbookItemRevisions.js";
import type * as playbookItems from "../playbookItems.js";
import type * as playbookValidators from "../playbookValidators.js";
import type * as profiles from "../profiles.js";
import type * as readabilityMigration from "../readabilityMigration.js";
import type * as recovery from "../recovery.js";
import type * as reviews from "../reviews.js";
import type * as savedContractValidators from "../savedContractValidators.js";
import type * as savedContracts from "../savedContracts.js";
import type * as settings from "../settings.js";
import type * as storageCapacity from "../storageCapacity.js";
import type * as storageOwnership from "../storageOwnership.js";
import type * as templateCapacity from "../templateCapacity.js";
import type * as templates from "../templates.js";
import type * as uploadHttp from "../uploadHttp.js";
import type * as wordExport from "../wordExport.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  accountViews: typeof accountViews;
  accounts: typeof accounts;
  admin: typeof admin;
  approvals: typeof approvals;
  auth: typeof auth;
  authoringMigration: typeof authoringMigration;
  authoringValidation: typeof authoringValidation;
  avatars: typeof avatars;
  baselineParser: typeof baselineParser;
  baselineStorage: typeof baselineStorage;
  baselineUploadValidators: typeof baselineUploadValidators;
  baselineUploads: typeof baselineUploads;
  baselineValidators: typeof baselineValidators;
  baselines: typeof baselines;
  chunks: typeof chunks;
  cleanup: typeof cleanup;
  clerk: typeof clerk;
  companies: typeof companies;
  companyDeletion: typeof companyDeletion;
  companyInvitations: typeof companyInvitations;
  contract: typeof contract;
  contractApprovals: typeof contractApprovals;
  contractCleanup: typeof contractCleanup;
  contractCleanupValidators: typeof contractCleanupValidators;
  contractDirectory: typeof contractDirectory;
  contractEmail: typeof contractEmail;
  contractExports: typeof contractExports;
  contractFormatting: typeof contractFormatting;
  contractPolicy: typeof contractPolicy;
  contractSaving: typeof contractSaving;
  contractValidators: typeof contractValidators;
  contracts: typeof contracts;
  crons: typeof crons;
  csmBookingValidators: typeof csmBookingValidators;
  csmBookings: typeof csmBookings;
  csmCal: typeof csmCal;
  csmReplacements: typeof csmReplacements;
  csmSetupAppointments: typeof csmSetupAppointments;
  csmSetupChain: typeof csmSetupChain;
  csmSetupLifecycle: typeof csmSetupLifecycle;
  csmSetupValidators: typeof csmSetupValidators;
  deletionPolicy: typeof deletionPolicy;
  deletionValidators: typeof deletionValidators;
  emailDeliveries: typeof emailDeliveries;
  emailDisposal: typeof emailDisposal;
  emailNotifications: typeof emailNotifications;
  emailSelectionChunks: typeof emailSelectionChunks;
  emailSender: typeof emailSender;
  emailValidators: typeof emailValidators;
  http: typeof http;
  hubspotApi: typeof hubspotApi;
  hubspotCleanup: typeof hubspotCleanup;
  hubspotConnections: typeof hubspotConnections;
  hubspotDeals: typeof hubspotDeals;
  hubspotDelivery: typeof hubspotDelivery;
  hubspotDeliveryPolicy: typeof hubspotDeliveryPolicy;
  hubspotExportActions: typeof hubspotExportActions;
  hubspotExports: typeof hubspotExports;
  hubspotOAuth: typeof hubspotOAuth;
  hubspotOperations: typeof hubspotOperations;
  hubspotProvenance: typeof hubspotProvenance;
  hubspotRecords: typeof hubspotRecords;
  hubspotSender: typeof hubspotSender;
  hubspotValidators: typeof hubspotValidators;
  invitationDeliverySummary: typeof invitationDeliverySummary;
  invitationEmail: typeof invitationEmail;
  invitationLinks: typeof invitationLinks;
  invitationValidators: typeof invitationValidators;
  legacyAccounts: typeof legacyAccounts;
  legacyExports: typeof legacyExports;
  legacyPlaybook: typeof legacyPlaybook;
  legacyTemplates: typeof legacyTemplates;
  legacyViews: typeof legacyViews;
  loopsEmail: typeof loopsEmail;
  memberships: typeof memberships;
  names: typeof names;
  operator: typeof operator;
  permissions: typeof permissions;
  playbookItemRevisions: typeof playbookItemRevisions;
  playbookItems: typeof playbookItems;
  playbookValidators: typeof playbookValidators;
  profiles: typeof profiles;
  readabilityMigration: typeof readabilityMigration;
  recovery: typeof recovery;
  reviews: typeof reviews;
  savedContractValidators: typeof savedContractValidators;
  savedContracts: typeof savedContracts;
  settings: typeof settings;
  storageCapacity: typeof storageCapacity;
  storageOwnership: typeof storageOwnership;
  templateCapacity: typeof templateCapacity;
  templates: typeof templates;
  uploadHttp: typeof uploadHttp;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  hubspotPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"hubspotPool">;
};
