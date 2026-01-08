// Database types matching the original Android Room entities

export interface GeneratedApp {
    id: number;
    name: string;
    code: string;
    currentVersion: number;
    iconPath: string | null;
    lastUpdated: number;
    consoleLogs: string;
}

export interface AppVersion {
    id: number;
    appId: number;
    version: number;
    code: string;
    instruction: string | null;
    selectedContext: string | null;
    createdAt: number;
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
