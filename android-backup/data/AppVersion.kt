package com.example.appacadabra.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "app_versions",
    foreignKeys = [
        ForeignKey(
            entity = GeneratedApp::class,
            parentColumns = ["id"],
            childColumns = ["appId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index(value = ["appId"])]
)
data class AppVersion(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val appId: Long,
    val version: Int,
    val code: String,
    val instruction: String? = null,      // What the user asked to change
    val selectedContext: String? = null,   // The HTML element/text selected for editing
    val createdAt: Long = System.currentTimeMillis()
)

