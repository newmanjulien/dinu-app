import type { TemplateAudience } from './model';

/** Complete messages keep audience terminology and grammar consistent across the shared editor. */
const copy = {
	rep: {
		editingTitle: 'Edit the instructions reps see',
		editingHelpLabel: 'About rep instructions',
		editingHelp: 'These are the instructions your reps use when they negotiate a contract',
		addAction: 'Add instructions',
		editorLabel: 'Instructions editor',
		optionsLabel: 'Instructions options',
		deleteAction: 'Delete instructions',
		deleteConfirm:
			'Permanently delete these instructions? Any unsaved local edits will also be discarded.',
		discardRetainedConfirm: 'Discard the retained instruction draft?',
		discardPreviousConfirm: 'Discard your previous unsaved instruction changes?',
		loadFailureTitle: 'Couldn’t load instructions',
		loadFailureHint: 'Try again to load the instructions for this clause.',
		loading: 'Loading instructions',
		loadingSelected: 'Loading these instructions…',
		refreshing: 'Refreshing instructions…',
		waitingSource: 'Waiting for instructions to match the uploaded template…',
		unavailable: 'Instruction editing is temporarily unavailable.',
		missingSelected:
			'These instructions are no longer available. Cancel and select the clause again.',
		conflict: 'These instructions changed elsewhere. Your local edits are retained.',
		deleted: 'These instructions were deleted elsewhere. Cancel to dismiss your local draft.',
		leaveConfirm: 'Abandon your unsaved instruction changes and leave?',
		startBlocked: 'Finish or cancel the current authoring task before adding instructions.',
		startUnsaved: 'Save or cancel your changes before adding more instructions.',
		saving: 'Saving instructions…',
		saved: 'Instructions saved',
		savedRefresh: 'Instructions saved; refresh needed',
		confirmationNeeded: 'Instruction save needs confirmation',
		draftNeedsAttention: 'Instruction draft needs attention',
		submittedConflict:
			'These instructions changed elsewhere. Your submitted draft is retained. Open the rep template to restore it against the current version.',
		submittedDeleted: 'These instructions were deleted. Your submitted draft is retained.',
		refreshFailed: 'Unable to refresh instructions. Your submitted work is retained.',
		loadFailed: 'Unable to load these instructions. Retry the refresh or select the clause again.',
		selectionOverlap: "You can't highlight text that already has instructions attached"
	},
	buyer: {
		editingTitle: 'Edit the explanations buyers see',
		editingHelpLabel: 'About buyer explanations',
		editingHelp: 'When your reps send a link to buyers, these explanations will be included',
		addAction: 'Add explanation',
		editorLabel: 'Explanation editor',
		optionsLabel: 'Explanation options',
		deleteAction: 'Delete explanation',
		deleteConfirm:
			'Permanently delete this explanation? Any unsaved local edits will also be discarded.',
		discardRetainedConfirm: 'Discard the retained explanation draft?',
		discardPreviousConfirm: 'Discard your previous unsaved explanation changes?',
		loadFailureTitle: 'Couldn’t load explanation',
		loadFailureHint: 'Try again to load the explanation for this clause.',
		loading: 'Loading explanation',
		loadingSelected: 'Loading this explanation…',
		refreshing: 'Refreshing explanations…',
		waitingSource: 'Waiting for explanations to match the uploaded template…',
		unavailable: 'Explanation editing is temporarily unavailable.',
		missingSelected: 'This explanation is no longer available. Cancel and select the clause again.',
		conflict: 'This explanation changed elsewhere. Your local edits are retained.',
		deleted: 'This explanation was deleted elsewhere. Cancel to dismiss your local draft.',
		leaveConfirm: 'Abandon your unsaved explanation changes and leave?',
		startBlocked: 'Finish or cancel the current authoring task before adding an explanation.',
		startUnsaved: 'Save or cancel your changes before adding another explanation.',
		saving: 'Saving explanation…',
		saved: 'Explanation saved',
		savedRefresh: 'Explanation saved; refresh needed',
		confirmationNeeded: 'Explanation save needs confirmation',
		draftNeedsAttention: 'Explanation draft needs attention',
		submittedConflict:
			'This explanation changed elsewhere. Your submitted draft is retained. Open the buyer template to restore it against the current version.',
		submittedDeleted: 'This explanation was deleted. Your submitted draft is retained.',
		refreshFailed: 'Unable to refresh explanations. Your submitted work is retained.',
		loadFailed: 'Unable to load this explanation. Retry the refresh or select the clause again.',
		selectionOverlap: "You can't highlight text that already has an explanation attached"
	}
} as const;

export const templateCopy = (audience: TemplateAudience) => copy[audience];
