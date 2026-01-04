package com.example.appacadabra.api

import android.webkit.JavascriptInterface
import com.example.appacadabra.data.AppDao
import com.example.appacadabra.data.AppStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * JavaScript interface for persisting localStorage data to native database.
 * This allows localStorage to survive app reinstalls and be included in backups.
 */
class LocalStorageJsInterface(
    private val appId: Long,
    private val dao: AppDao,
    private val scope: CoroutineScope
) {
    
    /**
     * Called from JavaScript when localStorage.setItem is invoked.
     */
    @JavascriptInterface
    fun setItem(key: String, value: String) {
        android.util.Log.d("LocalStorage", "setItem called: appId=$appId, key=$key, value=${value.take(50)}")
        scope.launch(Dispatchers.IO) {
            try {
                dao.setStorageItem(AppStorage(appId = appId, key = key, value = value))
                android.util.Log.d("LocalStorage", "setItem saved successfully")
            } catch (e: Exception) {
                android.util.Log.e("LocalStorage", "setItem error", e)
                e.printStackTrace()
            }
        }
    }
    
    /**
     * Called from JavaScript when localStorage.getItem is invoked.
     */
    @JavascriptInterface
    fun getItem(key: String): String? {
        return runBlocking(Dispatchers.IO) {
            try {
                dao.getStorageItem(appId, key)
            } catch (e: Exception) {
                e.printStackTrace()
                null
            }
        }
    }
    
    /**
     * Called from JavaScript when localStorage.removeItem is invoked.
     */
    @JavascriptInterface
    fun removeItem(key: String) {
        scope.launch(Dispatchers.IO) {
            try {
                dao.removeStorageItem(appId, key)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    /**
     * Called from JavaScript when localStorage.clear is invoked.
     */
    @JavascriptInterface
    fun clear() {
        scope.launch(Dispatchers.IO) {
            try {
                dao.clearStorageForApp(appId)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    /**
     * Returns all storage data as JSON string for restoring localStorage on page load.
     */
    @JavascriptInterface
    fun getAllDataJson(): String {
        return runBlocking(Dispatchers.IO) {
            try {
                val storage = dao.getStorageForApp(appId)
                val json = org.json.JSONObject()
                storage.forEach { item ->
                    json.put(item.key, item.value)
                }
                json.toString()
            } catch (e: Exception) {
                e.printStackTrace()
                "{}"
            }
        }
    }
    
    companion object {
        /**
         * JavaScript code to override localStorage methods and sync with native storage.
         */
        fun getInitScript(): String = """
            (function() {
                // Backup original localStorage
                const originalStorage = window.localStorage;
                
                // Create proxy for localStorage
                const storageProxy = {
                    setItem: function(key, value) {
                        originalStorage.setItem(key, value);
                        if (window.AppStorage) {
                            window.AppStorage.setItem(key, String(value));
                        }
                    },
                    getItem: function(key) {
                        return originalStorage.getItem(key);
                    },
                    removeItem: function(key) {
                        originalStorage.removeItem(key);
                        if (window.AppStorage) {
                            window.AppStorage.removeItem(key);
                        }
                    },
                    clear: function() {
                        originalStorage.clear();
                        if (window.AppStorage) {
                            window.AppStorage.clear();
                        }
                    },
                    key: function(index) {
                        return originalStorage.key(index);
                    },
                    get length() {
                        return originalStorage.length;
                    }
                };
                
                // Restore data from native storage
                if (window.AppStorage) {
                    try {
                        const savedData = window.AppStorage.getAllDataJson();
                        if (savedData && savedData !== '{}') {
                            const data = JSON.parse(savedData);
                            for (let key in data) {
                                originalStorage.setItem(key, data[key]);
                            }
                            console.log('AppStorage: Restored ' + Object.keys(data).length + ' items');
                        }
                    } catch(e) {
                        console.error('AppStorage restore error:', e);
                    }
                }
                
                // Override localStorage
                Object.defineProperty(window, 'localStorage', {
                    value: storageProxy,
                    writable: false,
                    configurable: false
                });
                
                console.log('AppStorage: localStorage bridge initialized');
            })();
        """.trimIndent()
    }
}
