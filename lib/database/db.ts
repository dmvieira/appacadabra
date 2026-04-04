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
      consoleLogs TEXT NOT NULL DEFAULT '',
      totalManaCost REAL NOT NULL DEFAULT 0,
      shortDescription TEXT
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

    CREATE TABLE IF NOT EXISTS mana_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      amount REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dismissed_uris (
      uri_key TEXT PRIMARY KEY NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mana_events_appId_ts ON mana_events(appId, timestamp);

    CREATE TABLE IF NOT EXISTS webview_ai_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appId INTEGER NOT NULL,
      callbackName TEXT NOT NULL,
      action TEXT NOT NULL,
      requestData TEXT,
      result TEXT NOT NULL,
      mediaLocalPath TEXT,
      creditsUsed REAL NOT NULL DEFAULT 0,
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
      deletedAt INTEGER NOT NULL
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
  `);

    // Helper to safely add column if missing
    const addColumn = async (table: string, column: string, definition: string) => {
        try {
            const columns = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
            if (!columns.some(c => c.name === column)) {
                await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                console.log(`[DB] Added column ${table}.${column}`);
            }
        } catch (e) {
            console.log(`[DB] Migration error (${table}.${column}):`, e);
        }
    };

    await addColumn('generated_apps', 'totalManaCost', 'REAL NOT NULL DEFAULT 0');
    await addColumn('generated_apps', 'jobId', 'TEXT');
    await addColumn('generated_apps', 'requiresBiometric', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('generated_apps', 'shortDescription', 'TEXT');
    await addColumn('generated_apps', 'createdAt', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('generated_apps', 'sortOrder', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('app_versions', 'jobId', 'TEXT');

    // webview_ai_cache: new columns for job tracking and recovery
    await addColumn('webview_ai_cache', 'jobId', 'TEXT');
    await addColumn('webview_ai_cache', 'resultMediaMime', 'TEXT');

    // Dedup + add unique index on (appId, callbackName) for INSERT OR REPLACE behavior
    try {
        await database.execAsync(`
            DELETE FROM webview_ai_cache
            WHERE id NOT IN (
                SELECT MAX(id) FROM webview_ai_cache GROUP BY appId, callbackName
            );
        `);
        await database.execAsync(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_wac_appId_callbackName ON webview_ai_cache(appId, callbackName);`
        );
    } catch (e) {
        console.log('[DB] Migration error (webview_ai_cache unique index):', e);
    }

    await database.execAsync(`
    CREATE TABLE IF NOT EXISTS processed_jobs (
      jobId TEXT PRIMARY KEY NOT NULL,
      action TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

    // Migration: Backfill processed_jobs
    try {
        await database.execAsync(`
      INSERT OR IGNORE INTO processed_jobs (jobId, action, timestamp)
      SELECT jobId, 'create', lastUpdated FROM generated_apps WHERE jobId IS NOT NULL;
      INSERT OR IGNORE INTO processed_jobs (jobId, action, timestamp)
      SELECT jobId, 'edit', createdAt FROM app_versions WHERE jobId IS NOT NULL;

      -- Backfill shortDescription for existing apps from their first version instruction
      UPDATE generated_apps 
      SET shortDescription = (
        SELECT instruction 
        FROM app_versions 
        WHERE appId = generated_apps.id 
        ORDER BY version ASC 
        LIMIT 1
      ) 
      WHERE shortDescription IS NULL;

      -- Backfill createdAt from the earliest version; fall back to lastUpdated
      UPDATE generated_apps
      SET createdAt = COALESCE(
        (SELECT MIN(createdAt) FROM app_versions WHERE appId = generated_apps.id),
        lastUpdated
      )
      WHERE createdAt = 0;

      -- Backfill sortOrder for apps that still have default 0
      -- Assign sequential order based on lastUpdated DESC (preserves current visual order)

      -- Backfill mana_events for existing spells that have totalManaCost but no events yet.
      -- Uses createdAt as timestamp so the windowed query picks it up correctly.
      INSERT OR IGNORE INTO mana_events (appId, amount, timestamp)
      SELECT id, totalManaCost, COALESCE(createdAt, lastUpdated)
      FROM generated_apps
      WHERE totalManaCost > 0
        AND id NOT IN (SELECT DISTINCT appId FROM mana_events);
    `);
    } catch (e) {
        // Ignore backfill errors
    }

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
    // Compute recentManaCost: sum of mana_events in the window [max(createdAt, now-30d), now]
    // This respects the spell's age — new spells show since creation, old ones show last 30 days.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return database.getAllAsync<GeneratedApp>(
        `SELECT g.*,
           COALESCE((
             SELECT SUM(me.amount)
             FROM mana_events me
             WHERE me.appId = g.id
               AND me.timestamp >= MAX(g.createdAt, ?)
           ), 0) AS recentManaCost
         FROM generated_apps g
         ORDER BY CASE WHEN g.sortOrder = 0 THEN 0 ELSE 1 END, g.sortOrder ASC, g.lastUpdated DESC`,
        [thirtyDaysAgo]
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

    const now = Date.now();
    const bindings = [
        String(app.name ?? 'Untitled'),
        String(app.code ?? ''),
        Number(app.currentVersion ?? 1),
        app.iconPath ? String(app.iconPath) : "", // Empty string instead of null
        Number(app.lastUpdated ?? now),
        Number(app.createdAt ?? now),
        String(app.consoleLogs ?? ''),
        Number(app.totalManaCost ?? 0),
        app.jobId ? String(app.jobId) : "", // Empty string instead of null to test NPE fix
        app.requiresBiometric ? 1 : 0,
        String(app.shortDescription ?? ''),
        Number(app.sortOrder ?? 0)
    ];

    console.log('[DB] Inserting App. Bindings:', JSON.stringify(bindings));

    try {
        const result = await database.runAsync(
            `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, createdAt, consoleLogs, totalManaCost, jobId, requiresBiometric, shortDescription, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            bindings as any[]
        );
        return result.lastInsertRowId;
    } catch (e) {
        console.error('[DB] Insert App Failed (Primary). Attempting Fallback...', e);

        // Fallback: Try inserting without jobId (in case migration failed)
        try {
            const fallbackBindings = [
                String(app.name ?? 'Untitled'),
                String(app.code ?? ''),
                Number(app.currentVersion ?? 1),
                app.iconPath ? String(app.iconPath) : "",
                Number(app.lastUpdated ?? now),
                Number(app.createdAt ?? now),
                String(app.consoleLogs ?? ''),
                Number(app.totalManaCost ?? 0),
                app.requiresBiometric ? 1 : 0,
                String(app.shortDescription ?? '')
            ];

            const result = await database.runAsync(
                `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, createdAt, consoleLogs, totalManaCost, requiresBiometric, shortDescription)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                fallbackBindings as any[]
            );
            console.log('[DB] Fallback Insert Success!');
            return result.lastInsertRowId;
        } catch (fallbackError) {
            console.error('[DB] Fallback Insert Also Failed:', fallbackError);
            throw e; // Throw original error
        }
    }
}

export async function updateApp(app: GeneratedApp): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        `UPDATE generated_apps SET name = ?, code = ?, currentVersion = ?, iconPath = ?, lastUpdated = ?, consoleLogs = ?, totalManaCost = ?, jobId = ?, requiresBiometric = ?, shortDescription = ?, sortOrder = ?
     WHERE id = ?`,
        [
            app.name ?? 'Untitled',
            app.code ?? '',
            app.currentVersion ?? 1,
            app.iconPath ?? "",
            app.lastUpdated ?? Date.now(),
            app.consoleLogs ?? '',
            app.totalManaCost ?? 0,
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

export async function updateBiometricLock(appId: number, enabled: boolean): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'UPDATE generated_apps SET requiresBiometric = ? WHERE id = ?',
        [enabled ? 1 : 0, appId]
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

export async function incrementManaCost(appId: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    const database = await getDatabase();
    const now = Date.now();
    await database.runAsync(
        'UPDATE generated_apps SET totalManaCost = totalManaCost + ? WHERE id = ?',
        [amount, appId]
    );
    // Log the event so we can sum mana within any time window
    await database.runAsync(
        'INSERT INTO mana_events (appId, amount, timestamp) VALUES (?, ?, ?)',
        [appId, amount, now]
    );
}

/** Bulk-insert mana events preserving their original timestamps (used by backup restore). */
export async function insertManaEvents(events: { appId: number; amount: number; timestamp: number }[]): Promise<void> {
    if (events.length === 0) return;
    const database = await getDatabase();
    for (const ev of events) {
        await database.runAsync(
            'INSERT INTO mana_events (appId, amount, timestamp) VALUES (?, ?, ?)',
            [ev.appId, ev.amount, ev.timestamp]
        );
    }
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
    creditsUsed: number; success: number;
}): Promise<number> {
    const database = await getDatabase();
    const r = await database.runAsync(
        `INSERT OR REPLACE INTO webview_ai_cache
         (appId, callbackName, action, requestData, result, mediaLocalPath, creditsUsed, success, delivered, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [entry.appId, entry.callbackName, entry.action,
         entry.requestData ?? null, entry.result,
         entry.mediaLocalPath ?? null, entry.creditsUsed,
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
        `INSERT OR REPLACE INTO webview_ai_cache
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
    result: string; mediaLocalPath: string | null; creditsUsed: number;
    success: number; delivered: number; createdAt: number;
}>> {
    const database = await getDatabase();
    return await database.getAllAsync(
        `SELECT id, callbackName, action, requestData, result, mediaLocalPath, creditsUsed, success, delivered, createdAt
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

export async function addDeletedAppName(name: string, deletedAt: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'INSERT OR REPLACE INTO deleted_app_names (name, deletedAt) VALUES (?, ?)',
        [name, deletedAt]
    );
}

export async function deleteDeletedAppName(name: string): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
        'DELETE FROM deleted_app_names WHERE name = ?',
        [name]
    );
}

export async function getDeletedAppNames(): Promise<{ name: string; deletedAt: number }[]> {
    const database = await getDatabase();
    return database.getAllAsync<{ name: string; deletedAt: number }>(
        'SELECT name, deletedAt FROM deleted_app_names'
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
    `);
    // Note: app_versions, app_storage, and mana_events are deleted via CASCADE from generated_apps
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
