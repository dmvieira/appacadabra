// JavaScript code injected into WebView to provide native API bridges
// Matches the Android GeminiJsInterface, CalendarJsInterface, NotificationJsInterface

// Translations that will be injected into the WebView
export interface InjectedTranslations {
  sharedTextInserted: string;
  fileAttached: string;
  imageLoaded: string;
  fileReceivedNoUpload: string;
  errorEmptyContent: string;
  errorEmptyFile: string;
  errorProcessingFile: string;
}

export function getInjectedJavaScript(appId: number, translations?: InjectedTranslations, isEditMode?: boolean): string {
  // Default English translations
  const t = translations || {
    sharedTextInserted: 'Shared text inserted!',
    fileAttached: 'File attached successfully!',
    imageLoaded: 'Image loaded!',
    fileReceivedNoUpload: 'File received (no upload field)',
    errorEmptyContent: 'Error: Empty content',
    errorEmptyFile: 'Error: Empty file content',
    errorProcessingFile: 'Error processing file:',
  };

  return `
(function() {
  // Edit mode flag - prevents localStorage persistence
  const __IS_EDIT_MODE__ = ${isEditMode ? 'true' : 'false'};
  
  // Store pending callbacks
  const pendingCallbacks = {};
  let callbackId = 0;
  // Queue for messages before bridge is ready
  const messageQueue = [];
  let isBridgeReady = false;

  function generateCallbackId() {
    return 'cb_' + (callbackId++);
  }

  function flushQueue() {
      if (!window.ReactNativeWebView) return;
      while (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          window.ReactNativeWebView.postMessage(msg);
      }
      isBridgeReady = true;
  }

  // Check for bridge and flush
  function checkBridge() {
      if (window.ReactNativeWebView) {
          flushQueue();
      } else {
          setTimeout(checkBridge, 100);
      }
  }
  checkBridge();

  function sendMessage(type, data, callbackName) {
    const msg = JSON.stringify({
      type: type,
      data: data,
      callbackName: callbackName,
      appId: ${appId}
    });

    if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(msg);
    } else {
        messageQueue.push(msg);
    }
  }

  // Expose fluent/builder AI API
  window.AppacadabraAI = (function() {
    function AIBuilder() {
      this.options = {
        search: false,
        schema: null,
        image: null,
        audio: null
      };
    }
    
    AIBuilder.prototype.withSearch = function() {
      this.options.search = true;
      return this;
    };
    
    AIBuilder.prototype.withSchema = function(schema) {
      this.options.schema = schema;
      return this;
    };
    
    AIBuilder.prototype.fromImage = function(base64) {
      this.options.image = base64;
      return this;
    };
    
    AIBuilder.prototype.fromAudio = function(base64) {
      this.options.audio = base64;
      return this;
    };
    
    AIBuilder.prototype.generate = function(prompt, callbackName) {
      // Build log message
      var logParts = ['[AppacadabraAI.generate]'];
      if (this.options.search) logParts.push('search:true');
      if (this.options.schema) logParts.push('schema:' + JSON.stringify(this.options.schema));
      if (this.options.image) logParts.push('image:' + (this.options.image?.length || 0) + 'chars');
      if (this.options.audio) logParts.push('audio:' + (this.options.audio?.length || 0) + 'chars');
      if (prompt) logParts.push('prompt:' + (prompt?.substring ? prompt.substring(0, 80) : prompt));
      logParts.push('callback:' + callbackName);
      console.log(logParts.join(' '));
      
      sendMessage('AI_GENERATE', {
        prompt: prompt,
        search: this.options.search,
        schema: this.options.schema,
        image: this.options.image,
        audio: this.options.audio
      }, callbackName);
    };
    
    // Factory methods that return new builder instances
    return {
      withSearch: function() { return new AIBuilder().withSearch(); },
      withSchema: function(s) { return new AIBuilder().withSchema(s); },
      fromImage: function(b) { return new AIBuilder().fromImage(b); },
      fromAudio: function(b) { return new AIBuilder().fromAudio(b); },
      generate: function(prompt, cb) { return new AIBuilder().generate(prompt, cb); },
      generateImage: function(prompt, callbackName) {
        console.log('[AppacadabraAI.generateImage] prompt:', prompt?.substring(0, 80), 'callback:', callbackName);
        sendMessage('AI_GENERATE_IMAGE', { prompt: prompt }, callbackName);
      }
    };
  })();

  window.AppacadabraCalendar = {
    createEvent: function(title, description, startTimeMs, endTimeMs, callbackName) {
        console.log('[AppacadabraCalendar.createEvent] title:', title, 'start:', new Date(startTimeMs).toISOString(), 'end:', new Date(endTimeMs).toISOString(), 'callback:', callbackName);
        sendMessage('CALENDAR_CREATE_EVENT', { title, description, startTimeMs, endTimeMs }, callbackName);
    },
    createEventWithReminder: function(title, description, startTimeMs, endTimeMs, reminderMinutes, callbackName) {
        console.log('[AppacadabraCalendar.createEventWithReminder] title:', title, 'reminder:', reminderMinutes, 'min, callback:', callbackName);
        sendMessage('CALENDAR_CREATE_EVENT_REMINDER', { title, description, startTimeMs, endTimeMs, reminderMinutes }, callbackName);
    },
    getEvents: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraCalendar.getEvents] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('CALENDAR_GET_EVENTS', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    deleteEvent: function(eventId, callbackName) {
        console.log('[AppacadabraCalendar.deleteEvent] eventId:', eventId, 'callback:', callbackName);
        sendMessage('CALENDAR_DELETE_EVENT', { eventId }, callbackName);
    }
  };

  window.AppacadabraNotify = {
    showNow: function(title, message, callbackName) {
        console.log('[AppacadabraNotify.showNow] title:', title, 'message:', message, 'callback:', callbackName);
        sendMessage('NOTIFY_SHOW_NOW', { title, message }, callbackName);
    },
    schedule: function(title, message, delayMinutes, callbackName, id) {
        var timeMs = Date.now() + (delayMinutes * 60 * 1000);
        console.log('[AppacadabraNotify.schedule] title:', title, 'delay:', delayMinutes, 'min (converted to:', new Date(timeMs).toISOString(), '), id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id }, callbackName);
    },
    scheduleAt: function(title, message, timeMs, callbackName, id) {
        console.log('[AppacadabraNotify.scheduleAt] title:', title, 'time:', new Date(timeMs).toISOString(), 'id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id }, callbackName);
    },
    getScheduled: function(callbackName) {
        console.log('[AppacadabraNotify.getScheduled] callback:', callbackName);
        sendMessage('NOTIFY_GET_SCHEDULED', {}, callbackName);
    },
    cancel: function(id, callbackName) {
        console.log('[AppacadabraNotify.cancel] id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_CANCEL', { id }, callbackName);
    },
    cancelAll: function(callbackName) {
        console.log('[AppacadabraNotify.cancelAll] callback:', callbackName);
        sendMessage('NOTIFY_CANCEL_ALL', {}, callbackName);
    },
    // Legacy alias
    scheduleNotification: function(title, message, delayMinutes, callbackName) {
        this.schedule(title, message, delayMinutes, callbackName);
    }
  };

  window.AppacadabraLocation = {
    getCurrentPosition: function(callbackName) {
        console.log('[AppacadabraLocation.getCurrentPosition] callback:', callbackName);
        sendMessage('LOCATION_GET_CURRENT_POSITION', {}, callbackName);
    }
  };

  // ============= Share Bridge =============
  window.AppacadabraShare = {
    share: function(text, url, callbackName) {
        console.log('[AppacadabraShare.share] text:', text?.substring(0, 50), 'url:', url, 'callback:', callbackName);
        sendMessage('SHARE_CONTENT', { text, url }, callbackName);
    },
    shareFile: function(base64, mimeType, filename, callbackName) {
        console.log('[AppacadabraShare.shareFile] mimeType:', mimeType, 'filename:', filename, 'callback:', callbackName);
        sendMessage('SHARE_FILE', { base64, mimeType, filename }, callbackName);
    }
  };

  // ============= Health Connect Bridge =============
  window.AppacadabraHealth = {
    initialize: function(callbackName) {
        console.log('[AppacadabraHealth.initialize] callback:', callbackName);
        sendMessage('HEALTH_INITIALIZE', {}, callbackName);
    },
    getSteps: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getSteps] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_STEPS', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getHeartRate: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getHeartRate] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_HEART_RATE', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getExercise: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getExercise] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_EXERCISE', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getSleep: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getSleep] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_SLEEP', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getCalories: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getCalories] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_CALORIES', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    }
  };

  // ============= Contacts Bridge =============
  // Helper to validate and sanitize contact object
  function validateContactObj(contact, isUpdate) {
    if (!contact || typeof contact !== 'object') {
      return { valid: false, error: 'Contact must be an object' };
    }
    if (isUpdate && !contact.id) {
      return { valid: false, error: 'Contact ID is required for update' };
    }
    // Sanitize all fields to strings
    const sanitized = {};
    const stringFields = ['id', 'name', 'firstName', 'lastName', 'middleName', 'company', 'jobTitle', 'department', 'nickname', 'note'];
    stringFields.forEach(function(field) {
      if (contact[field] !== undefined && contact[field] !== null) {
        sanitized[field] = String(contact[field]);
      }
    });

    // Pass through arrays (validation could be stricter here but we trust the inputs roughly)
    const arrayFields = ['phoneNumbers', 'emails', 'addresses', 'urlAddresses'];
    arrayFields.forEach(function(field) {
      if (Array.isArray(contact[field])) {
        // Deep clone or basic map to ensure it's a clean array
        sanitized[field] = contact[field];
      }
    });

    // Handle birthday (object)
    if (contact.birthday && typeof contact.birthday === 'object') {
        sanitized.birthday = {
          year: Number(contact.birthday.year),
          month: Number(contact.birthday.month),
          day: Number(contact.birthday.day)
        };
    }
    // Handle address (string or object)
    if (contact.address) {
      if (typeof contact.address === 'string') {
        sanitized.address = contact.address;
      } else if (typeof contact.address === 'object') {
        sanitized.address = {
          street: String(contact.address.street || ''),
          city: String(contact.address.city || ''),
          region: String(contact.address.region || contact.address.state || ''),
          postalCode: String(contact.address.postalCode || contact.address.zipCode || ''),
          country: String(contact.address.country || ''),
          label: String(contact.address.label || 'home')
        };
      }
    }
    return { valid: true, sanitized: sanitized };
  }

  window.AppacadabraContacts = {
    search: function(query, callbackName) {
        console.log('[AppacadabraContacts.search] query:', query, 'callback:', callbackName);
        sendMessage('CONTACTS_SEARCH', { query }, callbackName);
    },
    add: function(contact, callbackName) {
        console.log('[AppacadabraContacts.add] name:', contact?.name, 'callback:', callbackName);
        var validation = validateContactObj(contact, false);
        if (!validation.valid) {
          console.error('[AppacadabraContacts.add] Validation error:', validation.error);
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](false, validation.error);
          }
          return;
        }
        sendMessage('CONTACTS_ADD', { contact: validation.sanitized }, callbackName);
    },
    update: function(contact, callbackName) {
        console.log('[AppacadabraContacts.update] id:', contact?.id, 'callback:', callbackName);
        var validation = validateContactObj(contact, true);
        if (!validation.valid) {
          console.error('[AppacadabraContacts.update] Validation error:', validation.error);
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](false, validation.error);
          }
          return;
        }
        sendMessage('CONTACTS_UPDATE', { contact: validation.sanitized }, callbackName);
    }
  };




  // ============= Sensors Bridge =============
  window.AppacadabraSensors = {
    startAccelerometer: function(intervalMs, callbackName) {
        console.log('[AppacadabraSensors.startAccelerometer] interval:', intervalMs, 'callback:', callbackName);
        sendMessage('SENSORS_START_ACCELEROMETER', { intervalMs, callbackName }, callbackName);
    },
    startGyroscope: function(intervalMs, callbackName) {
        console.log('[AppacadabraSensors.startGyroscope] interval:', intervalMs, 'callback:', callbackName);
        sendMessage('SENSORS_START_GYROSCOPE', { intervalMs, callbackName }, callbackName);
    },
    startMagnetometer: function(intervalMs, callbackName) {
        console.log('[AppacadabraSensors.startMagnetometer] interval:', intervalMs, 'callback:', callbackName);
        sendMessage('SENSORS_START_MAGNETOMETER', { intervalMs, callbackName }, callbackName);
    },
    stopAccelerometer: function() {
        console.log('[AppacadabraSensors.stopAccelerometer]');
        sendMessage('SENSORS_STOP_ACCELEROMETER', {});
    },
    stopGyroscope: function() {
        console.log('[AppacadabraSensors.stopGyroscope]');
        sendMessage('SENSORS_STOP_GYROSCOPE', {});
    },
    stopMagnetometer: function() {
        console.log('[AppacadabraSensors.stopMagnetometer]');
        sendMessage('SENSORS_STOP_MAGNETOMETER', {});
    },
    stopAll: function() {
        console.log('[AppacadabraSensors.stopAll]');
        sendMessage('SENSORS_STOP_ALL', {});
    }
  };



  // ============= Web API Wrappers (Consistent Namespace) =============
  
  // Clipboard
  window.AppacadabraClipboard = {
    setString: function(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(e => console.error('Clipboard error:', e));
        } else {
            console.warn('Clipboard API not available');
        }
    },
    getString: function(callbackName) {
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText()
                .then(text => sendCallback(callbackName, text))
                .catch(e => sendCallback(callbackName, null, e.message));
        } else {
            sendCallback(callbackName, null, 'Clipboard API not available');
        }
    }
  };

  // Device (Battery, Network, Vibration, Info)
  window.AppacadabraDevice = {
    // Battery
    getBatteryLevel: function(callbackName) {
         sendMessage('DEVICE_GET_BATTERY_LEVEL', {}, callbackName);
    },
    isCharging: function(callbackName) {
         sendMessage('DEVICE_IS_CHARGING', {}, callbackName);
    },
    // Network
    isOnline: function(callbackName) {
        if (callbackName) {
            sendMessage('DEVICE_IS_ONLINE', {}, callbackName);
        } else {
            // Fallback for synchronous calls (deprecated but safe)
            return navigator.onLine;
        }
    },
    getNetworkType: function(callbackName) {
        // Redirect to async bridge if callback provided, else log error
        if (callbackName) {
             sendMessage('DEVICE_GET_NETWORK_INFO', {}, callbackName);
        } else {
             console.error('[AppacadabraDevice.getNetworkType] Missing callback');
        }
    },
    // Vibration
    vibrate: function(pattern) {
        console.log('[AppacadabraDevice.vibrate] pattern:', pattern);
        sendMessage('VIBRATE', { pattern: pattern });
    },
    cancelVibration: function() {
        console.log('[AppacadabraDevice.cancelVibration]');
        sendMessage('VIBRATE', { pattern: 0 }); // Native vibration 0 stops it
    },
    // Info
    language: navigator.language,
    userAgent: navigator.userAgent,
    // Browser
    openBrowser: function(url) {
        window.open(url, '_blank');
    }
  };

  // Override standard navigator.vibrate to use our bridge
  if (navigator) {
      navigator.vibrate = function(pattern) {
          window.AppacadabraDevice.vibrate(pattern);
          return true;
      };
  }

  // UI (Browser, Print) -> Screen
  window.AppacadabraScreen = {
      print: function() {
          // Send message to native for printing via expo-print
          // We pass the current HTML content
          sendMessage('PRINT', { html: document.documentElement.outerHTML });
      },
      capture: function(callbackName) {
          sendMessage('SCREEN_CAPTURE', {}, callbackName);
      },
      screenshot: function(callbackName) {
          sendMessage('SCREEN_CAPTURE', {}, callbackName);
      }
  };

  // ============= Camera (Photo & Scan) =============
  
  // ============= Sensors (Accelerometer, Gyroscope, Magnetometer) =============
  window.AppacadabraSensors = {
      startAccelerometer: function(intervalMs, callbackName) {
          console.log('[AppacadabraSensors.startAccelerometer] interval:', intervalMs, 'callback:', callbackName);
          sendMessage('SENSORS_START_ACCELEROMETER', { intervalMs }, callbackName);
      },
      startGyroscope: function(intervalMs, callbackName) {
          console.log('[AppacadabraSensors.startGyroscope] interval:', intervalMs, 'callback:', callbackName);
          sendMessage('SENSORS_START_GYROSCOPE', { intervalMs }, callbackName);
      },
      startMagnetometer: function(intervalMs, callbackName) {
          console.log('[AppacadabraSensors.startMagnetometer] interval:', intervalMs, 'callback:', callbackName);
          sendMessage('SENSORS_START_MAGNETOMETER', { intervalMs }, callbackName);
      },
      stopAccelerometer: function() {
          sendMessage('SENSORS_STOP_ACCELEROMETER', {});
      },
      stopGyroscope: function() {
          sendMessage('SENSORS_STOP_GYROSCOPE', {});
      },
      stopMagnetometer: function() {
          sendMessage('SENSORS_STOP_MAGNETOMETER', {});
      },
      stopAll: function() {
          sendMessage('SENSORS_STOP_ALL', {});
      }
  };
  window.AppacadabraCamera = {
      takePhoto: function(callbackName) {
          sendMessage('CAMERA_TAKE_PHOTO', {}, callbackName);
      },
      scan: function(callbackName) {
          sendMessage('SCANNER_SCAN', {}, callbackName);
      }
  };

  // ============= Audio (Recording & TTS) =============
  window.AppacadabraAudio = {
      // Recording
      recordStart: function(callbackName) {
          sendMessage('AUDIO_RECORD_START', {}, callbackName);
      },
      recordStop: function(callbackName) {
          sendMessage('AUDIO_RECORD_STOP', {}, callbackName);
      },
      // Text-to-Speech
      speak: function(text, options, callbackName) {
        console.log('[AppacadabraAudio.speak] text:', text?.substring(0, 50), 'callback:', callbackName);
        var opts = options || {};
        sendMessage('TTS_SPEAK', { text: text, language: opts.language, pitch: opts.pitch, rate: opts.rate, volume: opts.volume }, callbackName);
      },
      stopSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.stopSpeaking] callback:', callbackName);
        sendMessage('TTS_STOP', {}, callbackName);
      },
      isSpeaking: function(callbackName) {
        console.log('[AppacadabraAudio.isSpeaking] callback:', callbackName);
        sendMessage('TTS_IS_SPEAKING', {}, callbackName);
      }
  };
  
  // Storage (localStorage wrapper to sync with native DB)
  // We hook into localStorage.setItem to persist data (only in runner mode, not edit mode)
  // Storage (localStorage wrapper to sync with native DB)
  // We hook into localStorage.setItem to persist data (only in runner mode, not edit mode)
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function(key, value) {
      originalSetItem.apply(this, arguments);
      if (!__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_SET', { key, value });
      }
  };

  const originalRemoveItem = localStorage.removeItem;
  localStorage.removeItem = function(key) {
      originalRemoveItem.apply(this, arguments);
      if (!__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_REMOVE', { key });
      }
  };

  const originalClear = localStorage.clear;
  localStorage.clear = function() {
      originalClear.apply(this, arguments);
      if (!__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_CLEAR', {});
      }
  };
  
  // Selection mode for editing
  window.toggleSelectionMode = function(enabled) {
      if (enabled) {
          document.body.classList.add('selection-mode');
          document.addEventListener('click', handleElementClick, true);
      } else {
          document.body.classList.remove('selection-mode');
          document.removeEventListener('click', handleElementClick, true);
      }
  };
  
  function handleElementClick(e) {
      if (!document.body.classList.contains('selection-mode')) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const target = e.target;
      // Get element info
      const outerHTML = target.outerHTML;
      const preview = outerHTML.length > 200 ? outerHTML.substring(0, 200) + '...' : outerHTML;
      
      const info = {
          tagName: target.tagName.toLowerCase(),
          id: target.id,
          className: target.className,
          html: outerHTML,
          preview: preview
      };
      
      // Send to RN
      sendMessage('ELEMENT_SELECTED', info);
  }
  
  // Inject CSS for selection mode
  // Inject CSS for selection mode
  const style = document.createElement('style');
  style.textContent = \`
      .selection-mode * {
          cursor: crosshair !important;
      }
      .selection-mode *:hover {
          outline: 2px solid #00f !important;
          background-color: rgba(0, 0, 255, 0.1) !important;
      }
  \`;
  document.head.appendChild(style);

  // ============= Console Log Interception =============
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info
  };

  function interceptConsole(type) {
    return function(...args) {
      originalConsole[type].apply(console, args);
      try {
        const message = args.map(arg => {
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch { return String(arg); }
          }
          return String(arg);
        }).join(' ');
        sendMessage('CONSOLE_LOG', { type, message });
      } catch (e) {}
    };
  }

  console.log = interceptConsole('log');
  console.warn = interceptConsole('warn');
  console.error = interceptConsole('error');
  console.info = interceptConsole('info');

  // ============= Non-blocking Alert/Confirm/Prompt =============
  // User Request:
  // 1. window.alert -> PROXY to AppacadabraNotify.alert (Custom UI, Async/Non-blocking)
  //    "It doesn't wait for answer" -> acceptable to be non-blocking.
  // 2. window.confirm -> NATIVE (Sync/Blocking)
  // 3. window.prompt -> NATIVE (Sync/Blocking)
  
  (function() {
    var dialogOverlay = null;
    var dialogResolve = null;

    function createOverlay() {
      if (dialogOverlay) return dialogOverlay;
      dialogOverlay = document.createElement('div');
      dialogOverlay.id = '__appacadabra_dialog_overlay__';
      // High z-index to stay on top
      dialogOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999999;backdrop-filter:blur(2px);';
      return dialogOverlay;
    }

    function createDialog() {
      var dialog = document.createElement('div');
      dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:16px;padding:24px;min-width:280px;max-width:85vw;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:-apple-system,system-ui,sans-serif;';
      return dialog;
    }

    function createButton(text, isPrimary) {
        var btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = 'border:none;border-radius:8px;padding:10px 24px;font-size:15px;font-weight:600;cursor:pointer;min-width:80px;' +
          (isPrimary
            ? 'background:#89b4fa;color:#1e1e2e;'
            : 'background:#313244;color:#cdd6f4;');
        btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        return btn;
    }

    function removeDialog() {
      if (dialogOverlay && dialogOverlay.parentNode) {
        dialogOverlay.parentNode.removeChild(dialogOverlay);
      }
      dialogOverlay = null;
      dialogResolve = null;
    }

    // Extend AppacadabraNotify with Custom Dialogs (Async)
    
    // AppacadabraNotify.alert(message)
    window.AppacadabraNotify.alert = function(message) {
      return new Promise(function(resolve) {
        var overlay = createOverlay();
        var dialog = createDialog();

        var msgEl = document.createElement('p');
        msgEl.style.cssText = 'margin:0 0 20px 0;font-size:15px;line-height:1.5;word-wrap:break-word;';
        msgEl.textContent = String(message);
        dialog.appendChild(msgEl);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;';
        var okBtn = createButton('OK', true);
        okBtn.onclick = function() { removeDialog(); resolve(); };
        btnRow.appendChild(okBtn);
        dialog.appendChild(btnRow);

        overlay.innerHTML = '';
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        okBtn.focus();
      });
    };

    // AppacadabraNotify.confirm(message)
    window.AppacadabraNotify.confirm = function(message) {
      return new Promise(function(resolve) {
        var overlay = createOverlay();
        var dialog = createDialog();

        var msgEl = document.createElement('p');
        msgEl.style.cssText = 'margin:0 0 20px 0;font-size:15px;line-height:1.5;word-wrap:break-word;';
        msgEl.textContent = String(message);
        dialog.appendChild(msgEl);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;';
        var cancelBtn = createButton('Cancel', false);
        cancelBtn.onclick = function() { removeDialog(); resolve(false); };
        var okBtn = createButton('OK', true);
        okBtn.onclick = function() { removeDialog(); resolve(true); };
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        dialog.appendChild(btnRow);

        overlay.innerHTML = '';
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        okBtn.focus();
      });
    };

    // AppacadabraNotify.prompt(message, defaultValue)
    window.AppacadabraNotify.prompt = function(message, defaultValue) {
      return new Promise(function(resolve) {
        var overlay = createOverlay();
        var dialog = createDialog();

        var msgEl = document.createElement('p');
        msgEl.style.cssText = 'margin:0 0 12px 0;font-size:15px;line-height:1.5;word-wrap:break-word;';
        msgEl.textContent = String(message);
        dialog.appendChild(msgEl);

        var input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue != null ? String(defaultValue) : '';
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #45475a;border-radius:8px;background:#313244;color:#cdd6f4;font-size:15px;margin-bottom:20px;outline:none;';
        input.addEventListener('focus', function() { this.style.borderColor = '#89b4fa'; });
        input.addEventListener('blur', function() { this.style.borderColor = '#45475a'; });
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { removeDialog(); resolve(input.value); }
          if (e.key === 'Escape') { removeDialog(); resolve(null); }
        });
        dialog.appendChild(input);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;';
        var cancelBtn = createButton('Cancel', false);
        cancelBtn.onclick = function() { removeDialog(); resolve(null); };
        var okBtn = createButton('OK', true);
        okBtn.onclick = function() { removeDialog(); resolve(input.value); };
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        dialog.appendChild(btnRow);

        overlay.innerHTML = '';
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        input.focus();
      });
    };

    // Global Overrides
    // alert IS overridden (proxy to AppacadabraNotify.alert)
    window.alert = window.AppacadabraNotify.alert;
    
    // confirm and prompt are NOT overridden (remain native/sync)
  })();

  // ============= Network Request Interception =============
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method || 'GET';
    const startTime = Date.now();
    
    return originalFetch.apply(this, arguments)
      .then(response => {
        // Clone response to read body without consuming it
        const clonedResponse = response.clone();
        clonedResponse.text().then(body => {
          const truncatedBody = body.length > 500 ? body.substring(0, 500) + '...' : body;
          sendMessage('NETWORK_LOG', {
            url,
            method,
            status: response.status,
            statusText: response.statusText,
            duration: Date.now() - startTime,
            responseBody: truncatedBody
          });
        }).catch(() => {
          sendMessage('NETWORK_LOG', {
            url,
            method,
            status: response.status,
            statusText: response.statusText,
            duration: Date.now() - startTime,
            responseBody: '[Unable to read body]'
          });
        });
        return response;
      })
      .catch(error => {
        sendMessage('NETWORK_LOG', {
          url,
          method,
          status: 0,
          statusText: 'Error',
          duration: Date.now() - startTime,
          error: error.message
        });
        throw error;
      });
  };

  // Also intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url) {
    this._networkInfo = { method, url, startTime: Date.now() };
    return originalXHROpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function(body) {
    const xhr = this;
    const info = this._networkInfo || { method: 'GET', url: 'unknown', startTime: Date.now() };
    
    this.addEventListener('load', function() {
      const truncatedBody = xhr.responseText?.length > 500 
        ? xhr.responseText.substring(0, 500) + '...' 
        : xhr.responseText;
      sendMessage('NETWORK_LOG', {
        url: info.url,
        method: info.method,
        status: xhr.status,
        statusText: xhr.statusText,
        duration: Date.now() - info.startTime,
        responseBody: truncatedBody
      });
    });
    
    this.addEventListener('error', function() {
      sendMessage('NETWORK_LOG', {
        url: info.url,
        method: info.method,
        status: 0,
        statusText: 'Error',
        duration: Date.now() - info.startTime,
        error: 'Network Error'
      });
    });
    
    return originalXHRSend.apply(this, arguments);
  };

})();
  `;
}

// Helper to generate callback script for native-to-JS calls
export function createCallbackScript(callbackName: string, success: boolean, data: string): string {
  const escapedData = data
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  return `
    (function() {
      // Log the return from Native Bridge so it appears in debug console
      if ("${callbackName}" && "${callbackName}" !== "undefined") {
          var dataPreview = "${escapedData}".length > 100 ? "${escapedData}".substring(0, 100) + "..." : "${escapedData}";
          console.log("[BridgeReturn] ${callbackName} | Success: ${success} | Data: " + dataPreview);

          if (typeof ${callbackName} === 'function') {
            ${callbackName}(${success}, "${escapedData}");
          }
      } else {
          var dataPreview = "${escapedData}".length > 100 ? "${escapedData}".substring(0, 100) + "..." : "${escapedData}";
          console.log("[BridgeReturn] No callback name provided, but operation succeeded. Data: " + dataPreview);
      }
    })();
  `;
}

// Generate script to restore localStorage from saved database items
export function createStorageRestoreScript(items: { key: string; value: string }[]): string {
  // if (items.length === 0) return ''; // Removed to ensure clearing happens even if empty

  const restoreStatements = items.map(item => {
    const escapedKey = item.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedValue = item.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `
            try {
                localStorage.setItem("${escapedKey}", "${escapedValue}");
                console.log('[Storage] Restored key: ${escapedKey}');
            } catch (e) {
                console.error('[Storage] Failed to restore key: ${escapedKey}', e);
            }`;
  }).join('\n        ');

  return `
    (function() {
        console.log('[Storage] Starting restoration of ${items.length} items...');
        window.__APPACADABRA_RESTORING__ = true;
        try {
            console.log('[Storage] Clearing localStorage...');
            localStorage.clear();
            console.log('[Storage] localStorage cleared, now restoring items...');
            ${restoreStatements}
            if (${items.length} === 0) {
                console.log('[Storage] No items to restore.');
            } else {
                console.log('[Storage] Restoration complete! Total items: ${items.length}');
                // Verify
                console.log('[Storage] Verify key count:', localStorage.length);
            }
        } catch (err) {
            console.error('[Storage] Restoration error:', err);
        } finally {
            window.__APPACADABRA_RESTORING__ = false;
        }
    })();
    `;
}


// Interface for shared content
interface SharedContent {
  mimeType: string;
  text?: string;
  uri?: string;
  base64?: string;
  hasBase64?: boolean;
}

// Generate script to setup listener for shared content
export function createSharedContentSetupScript(translations?: InjectedTranslations): string {
  // Default English translations
  const t = translations || {
    sharedTextInserted: 'Shared text inserted!',
    fileAttached: 'File attached successfully!',
    imageLoaded: 'Image loaded!',
    fileReceivedNoUpload: 'File received (no upload field)',
    errorEmptyContent: 'Error: Empty content',
    errorEmptyFile: 'Error: Empty file content',
    errorProcessingFile: 'Error processing file:',
  };

  return `
    (function() {
      console.log('Setting up Shared Content Listener');
      
      // Helper function to show a toast notification
      function showToast(message) {
        // Remove existing toast if any
        const existing = document.getElementById('share-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'share-toast';
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:12px 24px;border-radius:8px;z-index:99999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
      }

      // Helper function to convert base64 to Blob
      function base64ToBlob(base64, mimeType) {
        try {
            const byteCharacters = atob(base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            return new Blob([byteArray], { type: mimeType });
        } catch (e) {
            console.error('Base64 conversion failed:', e);
            throw e;
        }
      }

      // Helper function to inject file into input[type=file]
      function injectFileIntoInput(fileInput, base64, mimeType, fileName) {
        try {
          if (!base64) {
            showToast('__ERROR_EMPTY_FILE__');
            return false;
          }
          
          console.log('Creating file from base64, size:', base64.length, 'name:', fileName);
          const blob = base64ToBlob(base64, mimeType);
          
          // Use provided filename or fallback
          const finalFileName = fileName || 'shared_file';
          
          // Create a File from the blob
          const file = new File([blob], finalFileName, { type: mimeType || 'application/octet-stream' });
          
          // Create a DataTransfer and add the file
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          
          // Set the files property
          fileInput.files = dataTransfer.files;
          
          // Dispatch change event
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          console.log('File injected into input:', finalFileName, 'size:', file.size);
          return true;
        } catch (error) {
          console.error('Failed to inject file:', error);
          showToast('__ERROR_PROCESSING_FILE__ ' + error.message);
          return false;
        }
      }

      function handleSharedContent(sharedContent) {
        console.log('Handling shared content:', sharedContent.mimeType);
        window.__sharedContent = sharedContent;
        
        const isImage = sharedContent.mimeType && sharedContent.mimeType.startsWith('image/');
        const isText = sharedContent.mimeType && (sharedContent.mimeType.startsWith('text/') || !sharedContent.mimeType);
        
        // Ensure hasBase64 is accurate
        if (sharedContent.base64 && !sharedContent.hasBase64) {
             sharedContent.hasBase64 = true;
        }
        
        let injected = false;

        // 1. Try Text Injection
        if (isText && sharedContent.text) {
          const textField = document.querySelector('textarea, input[type="text"], input:not([type])');
          if (textField) {
            textField.value = sharedContent.text;
            textField.dispatchEvent(new Event('input', { bubbles: true }));
            textField.dispatchEvent(new Event('change', { bubbles: true }));
            textField.focus();
            showToast('__SHARED_TEXT_INSERTED__');
            injected = true;
          }
        }

        // 2. Try File Injection (Input)
        if (!injected && (sharedContent.hasBase64 || sharedContent.base64)) {
           const fileInput = document.querySelector('input[type="file"]');
           if (fileInput) {
             if (injectFileIntoInput(fileInput, sharedContent.base64, sharedContent.mimeType, sharedContent.fileName)) {
               showToast('__FILE_ATTACHED__');
               injected = true;
             }
           } else {
             console.log('No file input found');
           }
        }

        // 3. Try Image Injection (Img src)
        if (!injected && isImage && sharedContent.base64) {
           const imgField = document.querySelector('img:not([src]), img[src=""]');
           if (imgField) {
             imgField.src = 'data:' + sharedContent.mimeType + ';base64,' + sharedContent.base64;
              showToast('__IMAGE_LOADED__');
             injected = true;
           }
        }
        
        // 4. Dispatch Event
        if (!injected) {
            // Check if we failed because of missing input
            const fileInput = document.querySelector('input[type="file"]');
            if (sharedContent.base64 && !fileInput) {
                showToast('__FILE_RECEIVED_NO_UPLOAD__');
            } else if (!sharedContent.base64 && !sharedContent.text) {
                showToast('__ERROR_EMPTY_CONTENT__');
            }
            
            window.dispatchEvent(new CustomEvent('sharedFile', { 
              detail: sharedContent
            }));
            window.dispatchEvent(new CustomEvent('sharedContent', { detail: sharedContent }));
        }
      }

      // Listen for messages from React Native
      const messageHandler = function(event) {
        try {
            if (!event.data) return;
            // Parse data if it's a string (Android sometimes handles this differently)
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            
            if (data && data.type === 'SET_SHARED_CONTENT') {
                console.log('Received SET_SHARED_CONTENT event');
                handleSharedContent(data.payload);
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
      };

      // Remove existing listener if any to avoid duplicates
      document.removeEventListener('message', messageHandler);
      window.removeEventListener('message', messageHandler);

      document.addEventListener('message', messageHandler);
      window.addEventListener('message', messageHandler);
      
      // Notify ready
      console.log('Shared Content Listener Ready');
    })();
  `
    .replace(/__SHARED_TEXT_INSERTED__/g, t.sharedTextInserted)
    .replace(/__FILE_ATTACHED__/g, t.fileAttached)
    .replace(/__IMAGE_LOADED__/g, t.imageLoaded)
    .replace(/__FILE_RECEIVED_NO_UPLOAD__/g, t.fileReceivedNoUpload)
    .replace(/__ERROR_EMPTY_CONTENT__/g, t.errorEmptyContent)
    .replace(/__ERROR_EMPTY_FILE__/g, t.errorEmptyFile)
    .replace(/__ERROR_PROCESSING_FILE__/g, t.errorProcessingFile);
}
