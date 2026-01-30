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
      consoleLogs TEXT NOT NULL DEFAULT '',
      totalManaCost REAL NOT NULL DEFAULT 0
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

    // Migration: Attempt to add totalManaCost column if it doesn't exist
    try {
        await database.execAsync('ALTER TABLE generated_apps ADD COLUMN totalManaCost REAL NOT NULL DEFAULT 0');
    } catch (e) {
        // Ignore error if column already exists
        console.log('[DB] Migration error (totalManaCost):', e);
    }

    // Migration: Attempt to add jobId columns
    try {
        await database.execAsync('ALTER TABLE generated_apps ADD COLUMN jobId TEXT');
    } catch (e) {
        console.log('[DB] Migration error (generated_apps.jobId):', e);
    }

    try {
        await database.execAsync('ALTER TABLE app_versions ADD COLUMN jobId TEXT');
    } catch (e) { }

    await database.execAsync(`
    CREATE TABLE IF NOT EXISTS processed_jobs (
      jobId TEXT PRIMARY KEY NOT NULL,
      action TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

    // Migration: Backfill processed_jobs from existing apps/versions to prevent processing old jobs
    try {
        await database.execAsync(`
      INSERT OR IGNORE INTO processed_jobs (jobId, action, timestamp)
      SELECT jobId, 'create', lastUpdated FROM generated_apps WHERE jobId IS NOT NULL;

      INSERT OR IGNORE INTO processed_jobs (jobId, action, timestamp)
      SELECT jobId, 'edit', createdAt FROM app_versions WHERE jobId IS NOT NULL;
    `);
    } catch (e) {
        console.log('[DB] Migration error (backfill processed_jobs):', e);
    }

    // Migration: Add requiresBiometric column
    try {
        await database.execAsync('ALTER TABLE generated_apps ADD COLUMN requiresBiometric INTEGER NOT NULL DEFAULT 0');
    } catch (e) {
        console.log('[DB] Migration error (requiresBiometric):', e);
    }
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

export async function getAppByJobId(jobId: string): Promise<GeneratedApp | null> {
    const database = await getDatabase();
    return database.getFirstAsync<GeneratedApp>(
        'SELECT * FROM generated_apps WHERE jobId = ?',
        [jobId]
    );
}

export async function insertApp(app: NewGeneratedApp): Promise<number> {
    const database = await getDatabase();
    // Check if app with this jobId already exists to prevent duplicates (idempotency)
    if (app.jobId) {
        const existing = await database.getFirstAsync<{ id: number }>('SELECT id FROM generated_apps WHERE jobId = ?', [app.jobId]);
        if (existing) {
            console.log(`[DB] App with jobId ${app.jobId} already exists. Returning ID: ${existing.id}`);
            return existing.id;
        }
    }

    const result = await database.runAsync(
        `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, consoleLogs, totalManaCost, jobId, requiresBiometric)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [app.name, app.code, app.currentVersion, app.iconPath, app.lastUpdated, app.consoleLogs, app.totalManaCost || 0, app.jobId || null, app.requiresBiometric ? 1 : 0]
    );
    return result.lastInsertRowId;
}

export async function updateApp(app: GeneratedApp): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE generated_apps SET name = ?, code = ?, currentVersion = ?, iconPath = ?, lastUpdated = ?, consoleLogs = ?, totalManaCost = ?, jobId = ?, requiresBiometric = ?
     WHERE id = ?`,
        [app.name, app.code, app.currentVersion, app.iconPath, app.lastUpdated, app.consoleLogs, app.totalManaCost, app.jobId || null, app.requiresBiometric ? 1 : 0, app.id]
    );
}

export async function deleteApp(id: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM generated_apps WHERE id = ?', [id]);
}

export async function updateBiometricLock(appId: number, enabled: boolean): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET requiresBiometric = ? WHERE id = ?',
        [enabled ? 1 : 0, appId]
    );
}

// ============= Version Operations =============

export async function getVersionsForApp(appId: number): Promise<AppVersion[]> {
    const database = await getDatabase();
    return database.getAllAsync<AppVersion>(
        'SELECT * FROM app_versions WHERE appId = ? ORDER BY version DESC',
        [appId]
    );
}

export async function getVersionByJobId(jobId: string): Promise<AppVersion | null> {
    const database = await getDatabase();
    return database.getFirstAsync<AppVersion>(
        'SELECT * FROM app_versions WHERE jobId = ?',
        [jobId]
    );
}

export async function hasJobBeenProcessed(jobId: string): Promise<boolean> {
    const database = await getDatabase();
    const result = await database.getFirstAsync<{ jobId: string }>(
        'SELECT jobId FROM processed_jobs WHERE jobId = ?',
        [jobId]
    );
    return !!result;
}

export async function markJobAsProcessed(jobId: string, action: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR IGNORE INTO processed_jobs (jobId, action, timestamp) VALUES (?, ?, ?)',
        [jobId, action, Date.now()]
    );
}



export async function insertVersion(version: NewAppVersion): Promise<number> {
    const database = await getDatabase();
    // Idempotency check for versions
    if (version.jobId) {
        const existing = await database.getFirstAsync<{ id: number }>('SELECT id FROM app_versions WHERE jobId = ?', [version.jobId]);
        if (existing) {
            console.log(`[DB] Version with jobId ${version.jobId} already exists. Returning ID: ${existing.id}`);
            return existing.id;
        }
    }

    const result = await database.runAsync(
        `INSERT INTO app_versions (appId, version, code, instruction, selectedContext, createdAt, jobId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [version.appId, version.version, version.code, version.instruction, version.selectedContext, version.createdAt, version.jobId || null]
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
