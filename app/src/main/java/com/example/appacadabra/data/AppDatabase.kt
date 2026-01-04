package com.example.appacadabra.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [GeneratedApp::class, AppVersion::class, AppStorage::class], version = 6, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun appDao(): AppDao
    
    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Add currentVersion column to generated_apps
                database.execSQL("ALTER TABLE generated_apps ADD COLUMN currentVersion INTEGER NOT NULL DEFAULT 1")
                
                // Create app_versions table
                database.execSQL("""
                    CREATE TABLE IF NOT EXISTS app_versions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        appId INTEGER NOT NULL,
                        version INTEGER NOT NULL,
                        code TEXT NOT NULL,
                        createdAt INTEGER NOT NULL,
                        FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
                    )
                """)
                database.execSQL("CREATE INDEX IF NOT EXISTS index_app_versions_appId ON app_versions(appId)")
            }
        }
        
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Add iconPath column to generated_apps
                database.execSQL("ALTER TABLE generated_apps ADD COLUMN iconPath TEXT DEFAULT NULL")
            }
        }
        
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Add instruction and selectedContext columns to app_versions
                database.execSQL("ALTER TABLE app_versions ADD COLUMN instruction TEXT DEFAULT NULL")
                database.execSQL("ALTER TABLE app_versions ADD COLUMN selectedContext TEXT DEFAULT NULL")
            }
        }
        
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Create app_storage table for localStorage persistence
                database.execSQL("""
                    CREATE TABLE IF NOT EXISTS app_storage (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        appId INTEGER NOT NULL,
                        key TEXT NOT NULL,
                        value TEXT NOT NULL,
                        FOREIGN KEY(appId) REFERENCES generated_apps(id) ON DELETE CASCADE
                    )
                """)
                database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_app_storage_appId_key ON app_storage(appId, `key`)")
            }
        }
        
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Add consoleLogs column to store debug logs from last app run
                database.execSQL("ALTER TABLE generated_apps ADD COLUMN consoleLogs TEXT NOT NULL DEFAULT ''")
            }
        }
    }
}
