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
import type * as accountDeletionActions from "../accountDeletionActions.js";
import type * as accountViews from "../accountViews.js";
import type * as accounts from "../accounts.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as authorPresentation from "../authorPresentation.js";
import type * as authoringValidation from "../authoringValidation.js";
import type * as avatars from "../avatars.js";
import type * as buyerActivity from "../buyerActivity.js";
import type * as buyerActivityQuota from "../buyerActivityQuota.js";
import type * as buyerActivityValidators from "../buyerActivityValidators.js";
import type * as buyerLinks from "../buyerLinks.js";
import type * as buyerValidators from "../buyerValidators.js";
import type * as chunks from "../chunks.js";
import type * as cleanup from "../cleanup.js";
import type * as clerk from "../clerk.js";
import type * as companies from "../companies.js";
import type * as companyDeletion from "../companyDeletion.js";
import type * as companyInvitations from "../companyInvitations.js";
import type * as companySetupState from "../companySetupState.js";
import type * as contractBuyer from "../contractBuyer.js";
import type * as contractCleanup from "../contractCleanup.js";
import type * as contractCleanupValidators from "../contractCleanupValidators.js";
import type * as contractDirectory from "../contractDirectory.js";
import type * as contractEmail from "../contractEmail.js";
import type * as contractExports from "../contractExports.js";
import type * as contractPolicy from "../contractPolicy.js";
import type * as contractSaving from "../contractSaving.js";
import type * as contractState from "../contractState.js";
import type * as contractValidators from "../contractValidators.js";
import type * as contracts from "../contracts.js";
import type * as crons from "../crons.js";
import type * as csmAttemptState from "../csmAttemptState.js";
import type * as csmBookingValidators from "../csmBookingValidators.js";
import type * as csmBookings from "../csmBookings.js";
import type * as csmCal from "../csmCal.js";
import type * as csmErasureGuardValidators from "../csmErasureGuardValidators.js";
import type * as csmErasureGuards from "../csmErasureGuards.js";
import type * as csmEvidence from "../csmEvidence.js";
import type * as csmEvidenceValidators from "../csmEvidenceValidators.js";
import type * as csmHistoricalAppointments from "../csmHistoricalAppointments.js";
import type * as csmHistory from "../csmHistory.js";
import type * as csmIdentity from "../csmIdentity.js";
import type * as csmMaintenance from "../csmMaintenance.js";
import type * as csmMeetingPreparation from "../csmMeetingPreparation.js";
import type * as csmMeetingValidators from "../csmMeetingValidators.js";
import type * as csmProviderFailures from "../csmProviderFailures.js";
import type * as csmRecoveryPolicy from "../csmRecoveryPolicy.js";
import type * as csmReplacements from "../csmReplacements.js";
import type * as csmSetupAppointments from "../csmSetupAppointments.js";
import type * as csmSetupChain from "../csmSetupChain.js";
import type * as csmSetupLifecycle from "../csmSetupLifecycle.js";
import type * as csmSetupReview from "../csmSetupReview.js";
import type * as csmSetupState from "../csmSetupState.js";
import type * as csmSetupValidators from "../csmSetupValidators.js";
import type * as deletionPolicy from "../deletionPolicy.js";
import type * as deletionValidators from "../deletionValidators.js";
import type * as discussionCapacity from "../discussionCapacity.js";
import type * as discussionCommands from "../discussionCommands.js";
import type * as discussionContext from "../discussionContext.js";
import type * as discussionInvalidation from "../discussionInvalidation.js";
import type * as discussionService from "../discussionService.js";
import type * as discussionValidators from "../discussionValidators.js";
import type * as discussions from "../discussions.js";
import type * as emailDeliveries from "../emailDeliveries.js";
import type * as emailNotifications from "../emailNotifications.js";
import type * as emailSender from "../emailSender.js";
import type * as emailValidators from "../emailValidators.js";
import type * as exportValidators from "../exportValidators.js";
import type * as http from "../http.js";
import type * as hubspotApi from "../hubspotApi.js";
import type * as hubspotCleanup from "../hubspotCleanup.js";
import type * as hubspotConnections from "../hubspotConnections.js";
import type * as hubspotCredentials from "../hubspotCredentials.js";
import type * as hubspotDeals from "../hubspotDeals.js";
import type * as hubspotDelivery from "../hubspotDelivery.js";
import type * as hubspotDeliveryPolicy from "../hubspotDeliveryPolicy.js";
import type * as hubspotExportDeliveries from "../hubspotExportDeliveries.js";
import type * as hubspotExportDeliveryValidators from "../hubspotExportDeliveryValidators.js";
import type * as hubspotInstallation from "../hubspotInstallation.js";
import type * as hubspotJournal from "../hubspotJournal.js";
import type * as hubspotOAuth from "../hubspotOAuth.js";
import type * as hubspotOperations from "../hubspotOperations.js";
import type * as hubspotQuoteActions from "../hubspotQuoteActions.js";
import type * as hubspotQuoteProvider from "../hubspotQuoteProvider.js";
import type * as hubspotQuoteRecovery from "../hubspotQuoteRecovery.js";
import type * as hubspotQuoteValidators from "../hubspotQuoteValidators.js";
import type * as hubspotQuotes from "../hubspotQuotes.js";
import type * as hubspotQuotesInstallation from "../hubspotQuotesInstallation.js";
import type * as hubspotRecipients from "../hubspotRecipients.js";
import type * as hubspotRecords from "../hubspotRecords.js";
import type * as hubspotSender from "../hubspotSender.js";
import type * as hubspotUninstall from "../hubspotUninstall.js";
import type * as hubspotValidators from "../hubspotValidators.js";
import type * as invitationDeliverySummary from "../invitationDeliverySummary.js";
import type * as invitationEmail from "../invitationEmail.js";
import type * as invitationLinks from "../invitationLinks.js";
import type * as invitationValidators from "../invitationValidators.js";
import type * as loopsEmail from "../loopsEmail.js";
import type * as membershipSetupState from "../membershipSetupState.js";
import type * as membershipUiPreferences from "../membershipUiPreferences.js";
import type * as memberships from "../memberships.js";
import type * as names from "../names.js";
import type * as operationReceiptValidators from "../operationReceiptValidators.js";
import type * as operationReceipts from "../operationReceipts.js";
import type * as operator from "../operator.js";
import type * as permissions from "../permissions.js";
import type * as playbookItemRevisions from "../playbookItemRevisions.js";
import type * as playbookItems from "../playbookItems.js";
import type * as playbookValidators from "../playbookValidators.js";
import type * as profileUiPreferences from "../profileUiPreferences.js";
import type * as profiles from "../profiles.js";
import type * as recovery from "../recovery.js";
import type * as savedContractValidators from "../savedContractValidators.js";
import type * as storageCapacity from "../storageCapacity.js";
import type * as storageOwnership from "../storageOwnership.js";
import type * as templateCapacity from "../templateCapacity.js";
import type * as templateSetup from "../templateSetup.js";
import type * as templateSetupValidators from "../templateSetupValidators.js";
import type * as templateSourceParser from "../templateSourceParser.js";
import type * as templateSourceStorage from "../templateSourceStorage.js";
import type * as templateSourceValidators from "../templateSourceValidators.js";
import type * as templateSources from "../templateSources.js";
import type * as templateValidators from "../templateValidators.js";
import type * as templates from "../templates.js";
import type * as uploadHttp from "../uploadHttp.js";
import type * as wordExport from "../wordExport.js";
import type * as wordExportGeneration from "../wordExportGeneration.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  accountDeletionActions: typeof accountDeletionActions;
  accountViews: typeof accountViews;
  accounts: typeof accounts;
  approvals: typeof approvals;
  auth: typeof auth;
  authorPresentation: typeof authorPresentation;
  authoringValidation: typeof authoringValidation;
  avatars: typeof avatars;
  buyerActivity: typeof buyerActivity;
  buyerActivityQuota: typeof buyerActivityQuota;
  buyerActivityValidators: typeof buyerActivityValidators;
  buyerLinks: typeof buyerLinks;
  buyerValidators: typeof buyerValidators;
  chunks: typeof chunks;
  cleanup: typeof cleanup;
  clerk: typeof clerk;
  companies: typeof companies;
  companyDeletion: typeof companyDeletion;
  companyInvitations: typeof companyInvitations;
  companySetupState: typeof companySetupState;
  contractBuyer: typeof contractBuyer;
  contractCleanup: typeof contractCleanup;
  contractCleanupValidators: typeof contractCleanupValidators;
  contractDirectory: typeof contractDirectory;
  contractEmail: typeof contractEmail;
  contractExports: typeof contractExports;
  contractPolicy: typeof contractPolicy;
  contractSaving: typeof contractSaving;
  contractState: typeof contractState;
  contractValidators: typeof contractValidators;
  contracts: typeof contracts;
  crons: typeof crons;
  csmAttemptState: typeof csmAttemptState;
  csmBookingValidators: typeof csmBookingValidators;
  csmBookings: typeof csmBookings;
  csmCal: typeof csmCal;
  csmErasureGuardValidators: typeof csmErasureGuardValidators;
  csmErasureGuards: typeof csmErasureGuards;
  csmEvidence: typeof csmEvidence;
  csmEvidenceValidators: typeof csmEvidenceValidators;
  csmHistoricalAppointments: typeof csmHistoricalAppointments;
  csmHistory: typeof csmHistory;
  csmIdentity: typeof csmIdentity;
  csmMaintenance: typeof csmMaintenance;
  csmMeetingPreparation: typeof csmMeetingPreparation;
  csmMeetingValidators: typeof csmMeetingValidators;
  csmProviderFailures: typeof csmProviderFailures;
  csmRecoveryPolicy: typeof csmRecoveryPolicy;
  csmReplacements: typeof csmReplacements;
  csmSetupAppointments: typeof csmSetupAppointments;
  csmSetupChain: typeof csmSetupChain;
  csmSetupLifecycle: typeof csmSetupLifecycle;
  csmSetupReview: typeof csmSetupReview;
  csmSetupState: typeof csmSetupState;
  csmSetupValidators: typeof csmSetupValidators;
  deletionPolicy: typeof deletionPolicy;
  deletionValidators: typeof deletionValidators;
  discussionCapacity: typeof discussionCapacity;
  discussionCommands: typeof discussionCommands;
  discussionContext: typeof discussionContext;
  discussionInvalidation: typeof discussionInvalidation;
  discussionService: typeof discussionService;
  discussionValidators: typeof discussionValidators;
  discussions: typeof discussions;
  emailDeliveries: typeof emailDeliveries;
  emailNotifications: typeof emailNotifications;
  emailSender: typeof emailSender;
  emailValidators: typeof emailValidators;
  exportValidators: typeof exportValidators;
  http: typeof http;
  hubspotApi: typeof hubspotApi;
  hubspotCleanup: typeof hubspotCleanup;
  hubspotConnections: typeof hubspotConnections;
  hubspotCredentials: typeof hubspotCredentials;
  hubspotDeals: typeof hubspotDeals;
  hubspotDelivery: typeof hubspotDelivery;
  hubspotDeliveryPolicy: typeof hubspotDeliveryPolicy;
  hubspotExportDeliveries: typeof hubspotExportDeliveries;
  hubspotExportDeliveryValidators: typeof hubspotExportDeliveryValidators;
  hubspotInstallation: typeof hubspotInstallation;
  hubspotJournal: typeof hubspotJournal;
  hubspotOAuth: typeof hubspotOAuth;
  hubspotOperations: typeof hubspotOperations;
  hubspotQuoteActions: typeof hubspotQuoteActions;
  hubspotQuoteProvider: typeof hubspotQuoteProvider;
  hubspotQuoteRecovery: typeof hubspotQuoteRecovery;
  hubspotQuoteValidators: typeof hubspotQuoteValidators;
  hubspotQuotes: typeof hubspotQuotes;
  hubspotQuotesInstallation: typeof hubspotQuotesInstallation;
  hubspotRecipients: typeof hubspotRecipients;
  hubspotRecords: typeof hubspotRecords;
  hubspotSender: typeof hubspotSender;
  hubspotUninstall: typeof hubspotUninstall;
  hubspotValidators: typeof hubspotValidators;
  invitationDeliverySummary: typeof invitationDeliverySummary;
  invitationEmail: typeof invitationEmail;
  invitationLinks: typeof invitationLinks;
  invitationValidators: typeof invitationValidators;
  loopsEmail: typeof loopsEmail;
  membershipSetupState: typeof membershipSetupState;
  membershipUiPreferences: typeof membershipUiPreferences;
  memberships: typeof memberships;
  names: typeof names;
  operationReceiptValidators: typeof operationReceiptValidators;
  operationReceipts: typeof operationReceipts;
  operator: typeof operator;
  permissions: typeof permissions;
  playbookItemRevisions: typeof playbookItemRevisions;
  playbookItems: typeof playbookItems;
  playbookValidators: typeof playbookValidators;
  profileUiPreferences: typeof profileUiPreferences;
  profiles: typeof profiles;
  recovery: typeof recovery;
  savedContractValidators: typeof savedContractValidators;
  storageCapacity: typeof storageCapacity;
  storageOwnership: typeof storageOwnership;
  templateCapacity: typeof templateCapacity;
  templateSetup: typeof templateSetup;
  templateSetupValidators: typeof templateSetupValidators;
  templateSourceParser: typeof templateSourceParser;
  templateSourceStorage: typeof templateSourceStorage;
  templateSourceValidators: typeof templateSourceValidators;
  templateSources: typeof templateSources;
  templateValidators: typeof templateValidators;
  templates: typeof templates;
  uploadHttp: typeof uploadHttp;
  wordExport: typeof wordExport;
  wordExportGeneration: typeof wordExportGeneration;
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
