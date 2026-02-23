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
    totalManaCost: number; // All-time mana used by this app
    recentManaCost?: number; // Mana used since createdAt (max 30 days window) – computed by getAllApps query
    jobId?: string; // Link to the async job that created this app
    requiresBiometric: boolean; // If true, requires biometric auth to open
    shortDescription?: string; // Short description of the app (editable)
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
