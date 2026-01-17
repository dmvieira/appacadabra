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

export function getInjectedJavaScript(appId: number, translations?: InjectedTranslations): string {
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
      generate: function(prompt, cb) { return new AIBuilder().generate(prompt, cb); }
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
    }
  };

  window.AppacadabraNotify = {
    showNow: function(title, message, callbackName) {
        console.log('[AppacadabraNotify.showNow] title:', title, 'message:', message, 'callback:', callbackName);
        sendMessage('NOTIFY_SHOW_NOW', { title, message }, callbackName);
    },
    scheduleNotification: function(title, message, delayMinutes, callbackName) {
        console.log('[AppacadabraNotify.scheduleNotification] title:', title, 'delay:', delayMinutes, 'min, callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, delayMinutes }, callbackName);
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

  // ============= Contacts Bridge =============
  window.AppacadabraContacts = {
    getAll: function(callbackName) {
        console.log('[AppacadabraContacts.getAll] callback:', callbackName);
        sendMessage('CONTACTS_GET_ALL', {}, callbackName);
    },
    search: function(query, callbackName) {
        console.log('[AppacadabraContacts.search] query:', query, 'callback:', callbackName);
        sendMessage('CONTACTS_SEARCH', { query }, callbackName);
    },
    pick: function(callbackName) {
        console.log('[AppacadabraContacts.pick] callback:', callbackName);
        sendMessage('CONTACTS_PICK', {}, callbackName);
    },
    add: function(contact, callbackName) {
        console.log('[AppacadabraContacts.add] name:', contact?.name, 'callback:', callbackName);
        sendMessage('CONTACTS_ADD', { contact }, callbackName);
    },
    update: function(contact, callbackName) {
        console.log('[AppacadabraContacts.update] id:', contact?.id, 'callback:', callbackName);
        sendMessage('CONTACTS_UPDATE', { contact }, callbackName);
    }
  };



  // ============= Auth/SSO Bridge =============
  window.AppacadabraAuth = {
    isAvailable: function(callbackName) {
        console.log('[AppacadabraAuth.isAvailable] callback:', callbackName);
        sendMessage('AUTH_IS_AVAILABLE', {}, callbackName);
    },
    authenticate: function(reason, callbackName) {
        console.log('[AppacadabraAuth.authenticate] reason:', reason, 'callback:', callbackName);
        sendMessage('AUTH_AUTHENTICATE', { reason }, callbackName);
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
  
  // Storage (localStorage wrapper to sync with native DB)
  // We hook into localStorage.setItem to persist data
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function(key, value) {
      originalSetItem.apply(this, arguments);
      sendMessage('STORAGE_SET', { key, value });
  };

  const originalRemoveItem = localStorage.removeItem;
  localStorage.removeItem = function(key) {
      originalRemoveItem.apply(this, arguments);
      sendMessage('STORAGE_REMOVE', { key });
  };

  const originalClear = localStorage.clear;
  localStorage.clear = function() {
      originalClear.apply(this, arguments);
      sendMessage('STORAGE_CLEAR', {});
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
      if (typeof ${callbackName} === 'function') {
        ${callbackName}(${success}, "${escapedData}");
      }
    })();
  `;
}

// Generate script to restore localStorage from saved database items
export function createStorageRestoreScript(items: { key: string; value: string }[]): string {
  if (items.length === 0) return '';

  const restoreStatements = items.map(item => {
    const escapedKey = item.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedValue = item.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `localStorage.setItem("${escapedKey}", "${escapedValue}");`;
  }).join('\n        ');

  return `
    (function() {
        // Restore saved localStorage data
        ${restoreStatements}
        console.log('Restored ${items.length} localStorage items');
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
