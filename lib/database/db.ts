import * as SQLite from 'expo-sqlite';
import { GeneratedApp, AppVersion, AppStorage, NewGeneratedApp, NewAppVersion } from './types';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (db) return db;

    db = await SQLite.openDatabaseAsync('appacadabra.db');
    await initDatabase(db);
    return db;
}

async function initDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
    await database.execAsync(`
    CREATE TABLE IF NOT EXISTS generated_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      currentVersion INTEGER NOT NULL DEFAULT 1,
      iconPath TEXT,
      lastUpdated INTEGER NOT NULL,
      consoleLogs TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS app_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      version INTEGER NOT NULL,
      code TEXT NOT NULL,
      instruction TEXT,
      selectedContext TEXT,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_app_versions_appId ON app_versions(appId);

    CREATE TABLE IF NOT EXISTS app_storage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_storage_appId_key ON app_storage(appId, key);
  `);
}

// ============= App CRUD Operations =============

export async function getAllApps(): Promise<GeneratedApp[]> {
    const database = await getDatabase();
    return database.getAllAsync<GeneratedApp>(
        'SELECT * FROM generated_apps ORDER BY lastUpdated DESC'
    );
}

export async function getAppById(id: number): Promise<GeneratedApp | null> {
    const database = await getDatabase();
    return database.getFirstAsync<GeneratedApp>(
        'SELECT * FROM generated_apps WHERE id = ?',
        [id]
    );
}

export async function insertApp(app: NewGeneratedApp): Promise<number> {
    const database = await getDatabase();
    const result = await database.runAsync(
        `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, consoleLogs)
     VALUES (?, ?, ?, ?, ?, ?)`,
        [app.name, app.code, app.currentVersion, app.iconPath, app.lastUpdated, app.consoleLogs]
    );
    return result.lastInsertRowId;
}

export async function updateApp(app: GeneratedApp): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE generated_apps SET name = ?, code = ?, currentVersion = ?, iconPath = ?, lastUpdated = ?, consoleLogs = ?
     WHERE id = ?`,
        [app.name, app.code, app.currentVersion, app.iconPath, app.lastUpdated, app.consoleLogs, app.id]
    );
}

export async function deleteApp(id: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM generated_apps WHERE id = ?', [id]);
}

// ============= Version Operations =============

export async function getVersionsForApp(appId: number): Promise<AppVersion[]> {
    const database = await getDatabase();
    return database.getAllAsync<AppVersion>(
        'SELECT * FROM app_versions WHERE appId = ? ORDER BY version DESC',
        [appId]
    );
}

export async function insertVersion(version: NewAppVersion): Promise<number> {
    const database = await getDatabase();
    const result = await database.runAsync(
        `INSERT INTO app_versions (appId, version, code, instruction, selectedContext, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
        [version.appId, version.version, version.code, version.instruction, version.selectedContext, version.createdAt]
    );
    return result.lastInsertRowId;
}

export async function deleteVersion(versionId: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM app_versions WHERE id = ?', [versionId]);
}

// ============= Storage Operations =============

export async function getStorageForApp(appId: number): Promise<AppStorage[]> {
    const database = await getDatabase();
    return database.getAllAsync<AppStorage>(
        'SELECT * FROM app_storage WHERE appId = ?',
        [appId]
    );
}

export async function getStorageItem(appId: number, key: string): Promise<string | null> {
    const database = await getDatabase();
    const result = await database.getFirstAsync<{ value: string }>(
        'SELECT value FROM app_storage WHERE appId = ? AND key = ?',
        [appId, key]
    );
    return result?.value ?? null;
}

export async function setStorageItem(appId: number, key: string, value: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `INSERT OR REPLACE INTO app_storage (appId, key, value)
     VALUES (?, ?, ?)`,
        [appId, key, value]
    );
}

export async function removeStorageItem(appId: number, key: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'DELETE FROM app_storage WHERE appId = ? AND key = ?',
        [appId, key]
    );
}

export async function clearStorageForApp(appId: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM app_storage WHERE appId = ?', [appId]);
}
