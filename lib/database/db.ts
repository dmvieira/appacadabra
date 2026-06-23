import * as SQLite from 'expo-sqlite';
import { GeneratedApp, AppVersion, AppStorage, NewGeneratedApp, NewAppVersion } from './types';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (dbInstance) return dbInstance;

    if (!dbPromise) {
        dbPromise = (async () => {
            const db = await SQLite.openDatabaseAsync('appacadabra.db');
            await initDatabase(db);
            dbInstance = db;
            return db;
        })();
    }

    return dbPromise;
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
      createdAt INTEGER NOT NULL DEFAULT 0,
      consoleLogs TEXT NOT NULL DEFAULT '',
      totalSpendUsd REAL NOT NULL DEFAULT 0,
      jobId TEXT,
      requiresBiometric INTEGER NOT NULL DEFAULT 0,
      shortDescription TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      storeSpellId TEXT,
      storeSpellSlug TEXT,
      forkOfStoreSpellId TEXT,
      storeVisibility TEXT
    );

    CREATE TABLE IF NOT EXISTS app_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      version INTEGER NOT NULL,
      code TEXT NOT NULL,
      instruction TEXT,
      selectedContext TEXT,
      createdAt INTEGER NOT NULL,
      jobId TEXT,
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

    CREATE TABLE IF NOT EXISTS dismissed_uris (
      uri_key TEXT PRIMARY KEY NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webview_ai_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      jobId TEXT,
      callbackName TEXT NOT NULL,
      action TEXT NOT NULL,
      requestData TEXT,
      result TEXT NOT NULL,
      mediaLocalPath TEXT,
      resultMediaMime TEXT,
      costUsd REAL NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      delivered INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wac_appId_delivered ON webview_ai_cache(appId, delivered);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deleted_app_names (
      name TEXT PRIMARY KEY NOT NULL,
      deletedAt INTEGER NOT NULL,
      snapshot_json TEXT
    );

    CREATE TABLE IF NOT EXISTS app_alarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      alarmId TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      timeMs INTEGER NOT NULL,
      UNIQUE(appId, alarmId),
      FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_app_alarms_appId ON app_alarms(appId);

    CREATE TABLE IF NOT EXISTS deleted_store_spell_tombstones (
      storeSpellId TEXT PRIMARY KEY NOT NULL,
      deletedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_jobs (
      jobId TEXT PRIMARY KEY NOT NULL,
      action TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

    // Clean up tombstones older than 90 days
    try {
        await database.execAsync(
            `DELETE FROM deleted_app_names WHERE deletedAt < (strftime('%s','now') * 1000 - 7776000000);`
        );
    } catch (e) {
        console.log('[DB] Tombstone cleanup error:', e);
    }
}

// ============= App CRUD Operations =============

export async function getAllApps(): Promise<GeneratedApp[]> {
    const database = await getDatabase();
    return database.getAllAsync<GeneratedApp>(
        `SELECT * FROM generated_apps
         ORDER BY CASE WHEN sortOrder = 0 THEN 0 ELSE 1 END, sortOrder ASC, lastUpdated DESC`
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

export async function getAppByStoreSpellId(storeSpellId: string): Promise<GeneratedApp | null> {
    const database = await getDatabase();
    return database.getFirstAsync<GeneratedApp>(
        'SELECT * FROM generated_apps WHERE storeSpellId = ?',
        [storeSpellId]
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

    const now = Date.now();
    const bindings = [
        String(app.name ?? 'Untitled'),
        String(app.code ?? ''),
        Number(app.currentVersion ?? 1),
        app.iconPath ? String(app.iconPath) : "", // Empty string instead of null
        Number(app.lastUpdated ?? now),
        Number(app.createdAt ?? now),
        String(app.consoleLogs ?? ''),
        Number(app.totalSpendUsd ?? 0),
        app.jobId ? String(app.jobId) : "", // Empty string instead of null to test NPE fix
        app.requiresBiometric ? 1 : 0,
        String(app.shortDescription ?? ''),
        Number(app.sortOrder ?? 0),
        app.source ?? 'local',
        app.storeSpellId ?? null,
        app.storeSpellSlug ?? null,
        app.forkOfStoreSpellId ?? null,
        app.storeVisibility ?? null,
    ];

    const result = await database.runAsync(
        `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, createdAt, consoleLogs, totalSpendUsd, jobId, requiresBiometric, shortDescription, sortOrder, source, storeSpellId, storeSpellSlug, forkOfStoreSpellId, storeVisibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bindings as any[]
    );
    return result.lastInsertRowId;
}

export async function updateApp(app: GeneratedApp): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE generated_apps SET name = ?, code = ?, currentVersion = ?, iconPath = ?, lastUpdated = ?, consoleLogs = ?, totalSpendUsd = ?, jobId = ?, requiresBiometric = ?, shortDescription = ?, sortOrder = ?
     WHERE id = ?`,
        [
            app.name ?? 'Untitled',
            app.code ?? '',
            app.currentVersion ?? 1,
            app.iconPath ?? "",
            app.lastUpdated ?? Date.now(),
            app.consoleLogs ?? '',
            app.totalSpendUsd ?? 0,
            app.jobId ?? "",
            app.requiresBiometric ? 1 : 0,
            app.shortDescription ?? '',
            app.sortOrder ?? 0,
            app.id
        ]
    );
    // Note: createdAt is intentionally never updated — it is set once at insert time.
}

export async function deleteApp(id: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM generated_apps WHERE id = ?', [id]);
}

export async function updateAppContent(
    id: number,
    code: string,
    currentVersion: number,
    totalSpendUsd: number,
    jobId: string
): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE generated_apps
         SET code = ?, currentVersion = ?, lastUpdated = ?, totalSpendUsd = ?, jobId = ?
         WHERE id = ?`,
        [code, currentVersion, Date.now(), totalSpendUsd, jobId, id]
    );
}

export async function updateBiometricLock(appId: number, enabled: boolean): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET requiresBiometric = ? WHERE id = ?',
        [enabled ? 1 : 0, appId]
    );
}

export async function updateAppStoreLink(
    appId: number,
    storeSpellId: string | null,
    storeSpellSlug: string | null,
    storeVisibility: 'public' | 'unlisted' | null = null
): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET storeSpellId = ?, storeSpellSlug = ?, storeVisibility = ? WHERE id = ?',
        [storeSpellId, storeSpellSlug, storeVisibility, appId]
    );
}

export async function updateAppSource(
    appId: number,
    source: 'local' | 'store',
    forkOfStoreSpellId: string | null
): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET source = ?, forkOfStoreSpellId = ? WHERE id = ?',
        [source, forkOfStoreSpellId, appId]
    );
}

export async function getAppsWithStoreSpellId(): Promise<GeneratedApp[]> {
    const database = await getDatabase();
    return database.getAllAsync<GeneratedApp>(
        'SELECT * FROM generated_apps WHERE storeSpellId IS NOT NULL'
    );
}

export async function updateSortOrders(updates: { id: number; sortOrder: number }[]): Promise<void> {
    if (updates.length === 0) return;
    const database = await getDatabase();
    for (const u of updates) {
        await database.runAsync(
            'UPDATE generated_apps SET sortOrder = ? WHERE id = ?',
            [u.sortOrder, u.id]
        );
    }
}

export async function incrementSpendUsd(appId: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET totalSpendUsd = totalSpendUsd + ? WHERE id = ?',
        [amount, appId]
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
        [
            version.appId,
            version.version ?? 1,
            version.code ?? '',
            version.instruction ?? "",
            version.selectedContext ?? "",
            version.createdAt ?? Date.now(),
            version.jobId ?? ""
        ]
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

// ============= WebView AI Cache =============

export interface WebviewAiCacheEntry {
    id: number;
    appId: number;
    jobId: string | null;
    callbackName: string;
    action: string;
    result: string;             // '' = pending; text or file:// path when complete
    mediaLocalPath: string | null;
    resultMediaMime: string | null;
    delivered: number;
    success: number;
    createdAt: number;
}

/** Save a completed AI result (used by backup restore & RunnerApp legacy path). Returns the new row id. */
export async function saveWebviewAiCache(entry: {
    appId: number; callbackName: string; action: string;
    requestData?: string; result: string; mediaLocalPath?: string;
    costUsd: number; success: number;
}): Promise<number> {
    const database = await getDatabase();
    const r = await database.runAsync(
        `INSERT INTO webview_ai_cache
         (appId, callbackName, action, requestData, result, mediaLocalPath, costUsd, success, delivered, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [entry.appId, entry.callbackName, entry.action,
         entry.requestData ?? null, entry.result,
         entry.mediaLocalPath ?? null, entry.costUsd,
         entry.success, Date.now()]
    );
    return r.lastInsertRowId;
}

/** Save a pending entry BEFORE the AI job starts. Returns the new row id. */
export async function saveWebviewAiCachePending(
    appId: number,
    callbackName: string,
    action: string
): Promise<number> {
    const database = await getDatabase();
    const r = await database.runAsync(
        `INSERT INTO webview_ai_cache
         (appId, callbackName, action, result, delivered, success, createdAt)
         VALUES (?, ?, ?, '', 0, 0, ?)`,
        [appId, callbackName, action, Date.now()]
    );
    return r.lastInsertRowId;
}

/** Store the Firestore jobId once the job document has been created. */
export async function updateWebviewAiCacheJobId(id: number, jobId: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE webview_ai_cache SET jobId = ? WHERE id = ?`,
        [jobId, id]
    );
}

/** Update the cache entry with the final result once the job completes. */
export async function updateWebviewAiCacheResult(
    id: number,
    result: string,
    mediaLocalPath: string | null,
    resultMediaMime: string | null,
    success: boolean
): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE webview_ai_cache SET result = ?, mediaLocalPath = ?, resultMediaMime = ?, success = ? WHERE id = ?`,
        [result, mediaLocalPath, resultMediaMime, success ? 1 : 0, id]
    );
}

export async function getUndeliveredWebviewAiCache(appId: number): Promise<WebviewAiCacheEntry[]> {
    const database = await getDatabase();
    return await database.getAllAsync(
        `SELECT id, appId, jobId, callbackName, action, result, mediaLocalPath, resultMediaMime, success, delivered, createdAt
         FROM webview_ai_cache WHERE appId = ? AND delivered = 0 ORDER BY createdAt ASC`,
        [appId]
    ) as any[];
}

export async function markWebviewAiCacheDelivered(id: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(`UPDATE webview_ai_cache SET delivered = 1 WHERE id = ?`, [id]);
}

export async function getWebviewAiMediaPaths(appId: number): Promise<string[]> {
    const database = await getDatabase();
    const rows = await database.getAllAsync<{ mediaLocalPath: string }>(
        `SELECT mediaLocalPath FROM webview_ai_cache WHERE appId = ? AND mediaLocalPath IS NOT NULL`,
        [appId]
    );
    return rows.map(r => r.mediaLocalPath);
}

export async function getAllWebviewAiCacheForApp(appId: number): Promise<Array<{
    id: number; callbackName: string; action: string; requestData: string | null;
    result: string; mediaLocalPath: string | null; costUsd: number;
    success: number; delivered: number; createdAt: number;
}>> {
    const database = await getDatabase();
    return await database.getAllAsync(
        `SELECT id, callbackName, action, requestData, result, mediaLocalPath, costUsd, success, delivered, createdAt
         FROM webview_ai_cache WHERE appId = ? ORDER BY createdAt DESC`,
        [appId]
    ) as any[];
}

export async function deleteWebviewAiCacheEntry(id: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM webview_ai_cache WHERE id = ?', [id]);
}

export async function clearAllWebviewAiCacheForApp(appId: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM webview_ai_cache WHERE appId = ?', [appId]);
}

// ============= Dismissed URIs (for ShareReceiver) =============

export async function getDismissedUris(): Promise<Record<string, number>> {
    const database = await getDatabase();
    const rows = await database.getAllAsync<{ uri_key: string; timestamp: number }>(
        'SELECT uri_key, timestamp FROM dismissed_uris'
    );
    return rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.uri_key] = row.timestamp;
        return acc;
    }, {});
}

export async function addDismissedUri(uriKey: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR REPLACE INTO dismissed_uris (uri_key, timestamp) VALUES (?, ?)',
        [uriKey, Date.now()]
    );
}

export async function clearOldDismissedUris(olderThanMs: number): Promise<void> {
    const database = await getDatabase();
    const limit = Date.now() - olderThanMs;
    await database.runAsync('DELETE FROM dismissed_uris WHERE timestamp < ?', [limit]);
}

// ============= App Settings (Global) =============

export async function getSetting(key: string): Promise<string | null> {
    const database = await getDatabase();
    const result = await database.getFirstAsync<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = ?',
        [key]
    );
    return result?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        [key, value]
    );
}

export async function deleteSetting(key: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM app_settings WHERE key = ?', [key]);
}

// ============= Deleted App Tombstones =============

export async function addDeletedAppName(name: string, deletedAt: number, snapshotJson?: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR REPLACE INTO deleted_app_names (name, deletedAt, snapshot_json) VALUES (?, ?, ?)',
        [name, deletedAt, snapshotJson ?? null]
    );
}

export async function deleteDeletedAppName(name: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'DELETE FROM deleted_app_names WHERE name = ?',
        [name]
    );
}

export async function getDeletedAppNames(): Promise<{ name: string; deletedAt: number; snapshotJson?: string }[]> {
    const database = await getDatabase();
    return database.getAllAsync<{ name: string; deletedAt: number; snapshotJson?: string }>(
        'SELECT name, deletedAt, snapshot_json as snapshotJson FROM deleted_app_names'
    );
}

export async function touchAppLastUpdated(appId: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET lastUpdated = ? WHERE id = ?',
        [Date.now(), appId]
    );
}

// ============= Deleted Store Spell Tombstones =============
// Records locally-deleted store spells so bulk recovery (recoverAll) does not re-import them.
// Removed automatically when the user re-learns the same spell.

export async function insertDeletedStoreSpellTombstone(storeSpellId: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR REPLACE INTO deleted_store_spell_tombstones (storeSpellId, deletedAt) VALUES (?, ?)',
        [storeSpellId, Date.now()]
    );
}

export async function getDeletedStoreSpellTombstones(): Promise<string[]> {
    const database = await getDatabase();
    const rows = await database.getAllAsync<{ storeSpellId: string }>(
        'SELECT storeSpellId FROM deleted_store_spell_tombstones'
    );
    return rows.map(r => r.storeSpellId);
}

export async function removeDeletedStoreSpellTombstone(storeSpellId: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'DELETE FROM deleted_store_spell_tombstones WHERE storeSpellId = ?',
        [storeSpellId]
    );
}

export async function wipeAllData(): Promise<void> {
    const database = await getDatabase();
    await database.execAsync(`
        DELETE FROM generated_apps;
        DELETE FROM dismissed_uris;
        DELETE FROM processed_jobs;
        DELETE FROM app_settings;
        DELETE FROM deleted_app_names;
        DELETE FROM deleted_store_spell_tombstones;
    `);
    // Note: app_versions and app_storage are deleted via CASCADE from generated_apps
}

// ============= Alarm Operations =============

export interface AlarmRow {
    alarmId: string;
    title: string;
    body: string;
    timeMs: number;
}

export async function saveAlarm(appId: number, alarmId: string, title: string, body: string, timeMs: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `INSERT OR REPLACE INTO app_alarms (appId, alarmId, title, body, timeMs) VALUES (?, ?, ?, ?, ?)`,
        [appId, alarmId, title, body, timeMs]
    );
}

export async function deleteAlarm(appId: number, alarmId: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'DELETE FROM app_alarms WHERE appId = ? AND alarmId = ?',
        [appId, alarmId]
    );
}

export async function deleteAllAlarmsForApp(appId: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM app_alarms WHERE appId = ?', [appId]);
}

export async function getAlarmsForApp(appId: number): Promise<AlarmRow[]> {
    const database = await getDatabase();
    return database.getAllAsync<AlarmRow>(
        'SELECT alarmId, title, body, timeMs FROM app_alarms WHERE appId = ?',
        [appId]
    );
}

export async function getAllFutureAlarms(): Promise<(AlarmRow & { appId: number })[]> {
    const database = await getDatabase();
    return database.getAllAsync<AlarmRow & { appId: number }>(
        'SELECT appId, alarmId, title, body, timeMs FROM app_alarms WHERE timeMs > ?',
        [Date.now()]
    );
}
