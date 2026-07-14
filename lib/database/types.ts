// Database types matching the original Android Room entities

export interface GeneratedApp {
    id: number;
    name: string;
    code: string;
    currentVersion: number;
    iconPath: string | null;
    lastUpdated: number;
    createdAt: number; // Timestamp when the spell was first created
    consoleLogs: string;
    totalSpendUsd: number; // All-time USD spent on AI calls for this spell
    jobId?: string; // Link to the async job that created this app
    requiresBiometric: boolean; // If true, requires biometric auth to open
    shortDescription?: string; // Short description of the app (editable)
    sortOrder: number; // Custom sort order (lower = higher in list)
    storeSpellId?: string | null; // ID of the published spell in Firestore store_spells (if published)
    storeSpellSlug?: string | null; // Slug for the public Store URL
    storeAuthorUid?: string | null; // Firebase UID of the publisher; null = unknown owner (legacy rows pre-fix)
    storeVisibility?: 'public' | 'unlisted' | null; // Visibility mode used when publishing
    source?: 'local' | 'store'; // Whether this spell was created locally or learned from the Store
    forkOfStoreSpellId?: string | null; // store_spells ID this spell was learned from (for variant publishing)
}

export interface AppVersion {
    id: number;
    appId: number;
    version: number;
    code: string;
    instruction: string | null;
    selectedContext: string | null;
    createdAt: number;
    jobId?: string; // Link to the async job that created this version
}

export interface AppStorage {
    id: number;
    appId: number;
    key: string;
    value: string;
}

// For creating new apps (without id)
export type NewGeneratedApp = Omit<GeneratedApp, 'id'>;
export type NewAppVersion = Omit<AppVersion, 'id'>;
export type NewAppStorage = Omit<AppStorage, 'id'>;

// Drafts and in-flight AI generation jobs (create/edit). Persisted so a draft
// survives an app kill and an interrupted generation can be reconciled at boot.
// The `currentStage`/`stageAttempt`/`outerAttempt`/`planJson`/`currentHtml`/
// `usageJson` fields carry state-machine state for the background executor so
// a killed process can resume from the last completed stage instead of retrying
// from scratch.
export interface PendingJob {
    jobId: string;
    type: 'create' | 'edit' | 'draft';
    appId: number | null;
    promptText: string;
    selectedContext: string | null;
    status: 'draft' | 'processing' | 'failed';
    startedAt: number;
    updatedAt: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    currentStage?: 'planner' | 'coder' | 'patch' | 'validate' | 'fix' | 'complete' | null;
    stageAttempt?: number | null;
    outerAttempt?: number | null;
    planJson?: string | null;
    currentHtml?: string | null;
    usageJson?: string | null;
}
