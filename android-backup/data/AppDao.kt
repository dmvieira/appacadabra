package com.example.appacadabra.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface AppDao {
    @Query("SELECT * FROM generated_apps ORDER BY lastUpdated DESC")
    fun getAllApps(): Flow<List<GeneratedApp>>

    @Query("SELECT * FROM generated_apps WHERE id = :id")
    suspend fun getAppById(id: Long): GeneratedApp?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertApp(app: GeneratedApp): Long

    @Update
    suspend fun updateApp(app: GeneratedApp)

    @Delete
    suspend fun deleteApp(app: GeneratedApp)
    
    // Version history
    @Insert
    suspend fun insertVersion(version: AppVersion): Long
    
    @Query("SELECT * FROM app_versions WHERE appId = :appId ORDER BY version DESC")
    suspend fun getVersionsForApp(appId: Long): List<AppVersion>
    
    @Query("SELECT * FROM app_versions WHERE appId = :appId AND version = :version")
    suspend fun getVersion(appId: Long, version: Int): AppVersion?
    
    @Query("DELETE FROM app_versions WHERE appId = :appId")
    suspend fun deleteVersionsForApp(appId: Long)
    
    // LocalStorage persistence
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun setStorageItem(item: AppStorage)
    
    @Query("SELECT * FROM app_storage WHERE appId = :appId")
    suspend fun getStorageForApp(appId: Long): List<AppStorage>
    
    @Query("SELECT value FROM app_storage WHERE appId = :appId AND `key` = :key")
    suspend fun getStorageItem(appId: Long, key: String): String?
    
    @Query("DELETE FROM app_storage WHERE appId = :appId AND `key` = :key")
    suspend fun removeStorageItem(appId: Long, key: String)
    
    @Query("DELETE FROM app_storage WHERE appId = :appId")
    suspend fun clearStorageForApp(appId: Long)
}
