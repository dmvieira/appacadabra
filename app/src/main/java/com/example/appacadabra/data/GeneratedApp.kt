package com.example.appacadabra.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "generated_apps")
data class GeneratedApp(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val code: String,
    val currentVersion: Int = 1,
    val iconPath: String? = null,
    val lastUpdated: Long = System.currentTimeMillis(),
    val consoleLogs: String = "" // JSON array of log entries from last run
)
