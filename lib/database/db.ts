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

    CREATE INDEX IF NOT EXISTS idx_mana_events_appId_ts ON mana_events(appId, timestamp);
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
    await addColumn('app_versions', 'jobId', 'TEXT');

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
         ORDER BY g.lastUpdated DESC`,
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
        String(app.shortDescription ?? '')
    ];

    console.log('[DB] Inserting App. Bindings:', JSON.stringify(bindings));

    try {
        const result = await database.runAsync(
            `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, createdAt, consoleLogs, totalManaCost, jobId, requiresBiometric, shortDescription)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `UPDATE generated_apps SET name = ?, code = ?, currentVersion = ?, iconPath = ?, lastUpdated = ?, consoleLogs = ?, totalManaCost = ?, jobId = ?, requiresBiometric = ?, shortDescription = ?
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
