package com.example.appacadabra.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "app_storage",
    foreignKeys = [
        ForeignKey(
            entity = GeneratedApp::class,
            parentColumns = ["id"],
            childColumns = ["appId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index(value = ["appId", "key"], unique = true)]
)
data class AppStorage(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val appId: Long,
    val key: String,
    val value: String
)
