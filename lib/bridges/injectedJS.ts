// JavaScript code injected into WebView to provide native API bridges
// Matches the Android GeminiJsInterface, CalendarJsInterface, NotificationJsInterface

export function getInjectedJavaScript(appId: number): string {
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

  // Boot message
  sendMessage('CONSOLE_LOG', { type: 'system', message: 'Bridge initialized (v2)' }, null);

  // ============= AppacadabraAI =============
  window.AppacadabraAI = {
    generateText: function(prompt, callbackName) {
      sendMessage('AI_GENERATE_TEXT', { prompt: prompt }, callbackName);
    },
    
    generateTextWithSearch: function(prompt, callbackName) {
      sendMessage('AI_GENERATE_TEXT_SEARCH', { prompt: prompt }, callbackName);
    },
    
    describeImage: function(base64Image, prompt, callbackName) {
      sendMessage('AI_DESCRIBE_IMAGE', { base64: base64Image, prompt: prompt }, callbackName);
    },
    
    transcribeAudio: function(base64Audio, callbackName) {
      sendMessage('AI_TRANSCRIBE_AUDIO', { base64: base64Audio }, callbackName);
    },
    
    extractStructuredData: function(text, schemaJson, callbackName) {
      sendMessage('AI_EXTRACT_STRUCTURED', { text: text, schema: schemaJson }, callbackName);
    }
  };

  // ============= AppacadabraCalendar =============
  window.AppacadabraCalendar = {
    createEvent: function(title, description, startTimeMs, endTimeMs, callbackName) {
      sendMessage('CALENDAR_CREATE_EVENT', {
        title: title,
        description: description,
        startTimeMs: startTimeMs,
        endTimeMs: endTimeMs
      }, callbackName);
    },
    
    createEventWithReminder: function(title, description, startTimeMs, endTimeMs, reminderMinutes, callbackName) {
      sendMessage('CALENDAR_CREATE_EVENT_REMINDER', {
        title: title,
        description: description,
        startTimeMs: startTimeMs,
        endTimeMs: endTimeMs,
        reminderMinutes: reminderMinutes
      }, callbackName);
    },
    
    hasCalendarPermission: function(callbackName) {
      sendMessage('CALENDAR_HAS_PERMISSION', {}, callbackName);
    },
    
    requestCalendarPermission: function() {
      sendMessage('CALENDAR_REQUEST_PERMISSION', {}, null);
    }
  };

  // ============= AppacadabraNotify =============
  window.AppacadabraNotify = {
    showNow: function(title, message, callbackName) {
      sendMessage('NOTIFY_SHOW_NOW', { title: title, message: message }, callbackName);
    },
    
    scheduleNotification: function(title, message, delayMinutes, callbackName) {
      sendMessage('NOTIFY_SCHEDULE', {
        title: title,
        message: message,
        delayMinutes: delayMinutes
      }, callbackName);
    },
    
    scheduleNotificationAt: function(title, message, timeMs, callbackName) {
      sendMessage('NOTIFY_SCHEDULE_AT', {
        title: title,
        message: message,
        timeMs: timeMs
      }, callbackName);
    },
    
    hasNotificationPermission: function(callbackName) {
      sendMessage('NOTIFY_HAS_PERMISSION', {}, callbackName);
    },
    
    requestNotificationPermission: function() {
      sendMessage('NOTIFY_REQUEST_PERMISSION', {}, null);
    }
  };

  // ============= localStorage bridge =============
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);
  const originalClear = localStorage.clear.bind(localStorage);

  localStorage.setItem = function(key, value) {
    originalSetItem(key, value);
    sendMessage('STORAGE_SET', { key: key, value: value }, null);
  };

  localStorage.removeItem = function(key) {
    originalRemoveItem(key);
    sendMessage('STORAGE_REMOVE', { key: key }, null);
  };

  localStorage.clear = function() {
    originalClear();
    sendMessage('STORAGE_CLEAR', {}, null);
  };

  // ============= Console log capture =============
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  function captureLog(type, args) {
    const message = Array.from(args).map(arg => {
      try {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');
    
    sendMessage('CONSOLE_LOG', { type: type, message: message }, null);
  }

  console.log = function(...args) {
    captureLog('log', args);
    originalLog.apply(console, args);
  };

  console.error = function(...args) {
    captureLog('error', args);
    originalError.apply(console, args);
  };

  console.warn = function(...args) {
    captureLog('warn', args);
    originalWarn.apply(console, args);
  };

  // Capture uncaught errors
  window.onerror = function(message, source, lineno, colno, error) {
    captureLog('error', ['Uncaught error:', message, 'at', source, lineno + ':' + colno]);
  };

  // ============= Network request capture =============
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    const method = (options && options.method) || 'GET';
    const urlStr = typeof url === 'string' ? url : url.url || url.toString();
    
    sendMessage('NETWORK_LOG', { url: urlStr, method: method, status: null }, null);
    
    return originalFetch.apply(this, arguments).then(function(response) {
      sendMessage('NETWORK_LOG', { url: urlStr, method: method, status: response.status }, null);
      return response;
    }).catch(function(error) {
      sendMessage('NETWORK_LOG', { url: urlStr, method: method, status: 0 }, null);
      throw error;
    });
  };

  // Also capture XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url) {
    this._networkMethod = method;
    this._networkUrl = url;
    return originalOpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function() {
    const xhr = this;
    sendMessage('NETWORK_LOG', { url: xhr._networkUrl, method: xhr._networkMethod, status: null }, null);
    
    xhr.addEventListener('load', function() {
      sendMessage('NETWORK_LOG', { url: xhr._networkUrl, method: xhr._networkMethod, status: xhr.status }, null);
    });
    
    xhr.addEventListener('error', function() {
      sendMessage('NETWORK_LOG', { url: xhr._networkUrl, method: xhr._networkMethod, status: 0 }, null);
    });
    
    return originalSend.apply(this, arguments);
  };

  console.log('Appacadabra bridges initialized v3 (Selection Mode Ready)');

  // ============= Selection Monitor =============
  window._lastSelection = "";
  document.addEventListener("selectionchange", function() {
      var sel = window.getSelection().toString();
      window._lastSelection = sel;
  });

  // ============= DOM Selection Mode =============
  window._appacadabraSelectionMode = false;
  window._selectionHandler = function(e) {
      if (!window._appacadabraSelectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      var target = e.target;
      
      // Highlight
      if (window._lastHighlighted) window._lastHighlighted.style.outline = '';
      target.style.outline = '4px solid #FF0055'; // Vibrant color
      window._lastHighlighted = target;

      // Send target info
      // Truncate preview for performance/UI, but generally we want structure
      var preview = target.outerHTML;
      if (preview.length > 500) preview = preview.substring(0, 500) + '...';

      window.ReactNativeWebView.postMessage(JSON.stringify({
         type: 'ELEMENT_SELECTED',
         data: { 
             html: target.outerHTML, 
             tagName: target.tagName,
             preview: preview 
         }
      }));
  };

  window.toggleSelectionMode = function(active) {
      window._appacadabraSelectionMode = active;
      if (active) {
          document.addEventListener('click', window._selectionHandler, true); // Capture phase
          document.body.style.cursor = 'crosshair';
          // Disable selection of text to avoid confusion?
          document.body.style.userSelect = 'none';
          document.body.style.webkitUserSelect = 'none';
      } else {
          document.removeEventListener('click', window._selectionHandler, true);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.body.style.webkitUserSelect = '';
          if (window._lastHighlighted) {
             window._lastHighlighted.style.outline = '';
             window._lastHighlighted = null;
          }
      }
  };
})();
true;
`;
}

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
}

// Generate script to inject shared content into the first compatible form field
export function createSharedContentInjectionScript(content: SharedContent): string {
  const isImage = content.mimeType?.startsWith('image/');
  const isText = content.mimeType?.startsWith('text/') || !content.mimeType;
  const hasUri = !!content.uri;

  // Escape content for injection
  const escapedText = (content.text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const escapedUri = (content.uri || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedMime = (content.mimeType || 'text/plain').replace(/"/g, '\\"');

  return `
    (function() {
      console.log('Injecting shared content:', '${escapedMime}');
      
      const sharedContent = {
        mimeType: "${escapedMime}",
        text: "${escapedText}",
        uri: "${escapedUri}",
        isImage: ${isImage},
        isText: ${isText},
        hasUri: ${hasUri}
      };

      // Make shared content available globally
      window.__sharedContent = sharedContent;

      // Function to show a toast notification
      function showToast(message) {
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:12px 24px;border-radius:8px;z-index:99999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      }

      // Helper function to inject file into input[type=file]
      async function injectFileIntoInput(fileInput, uri, mimeType) {
        try {
          console.log('Attempting to fetch file from URI:', uri);
          const response = await fetch(uri);
          const blob = await response.blob();
          
          // Get filename from URI
          const fileName = uri.split('/').pop() || 'shared_file';
          
          // Create a File from the blob
          const file = new File([blob], fileName, { type: mimeType || blob.type });
          
          // Create a DataTransfer and add the file
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          
          // Set the files property
          fileInput.files = dataTransfer.files;
          
          // Dispatch change event
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          console.log('File injected into input:', fileName);
          return true;
        } catch (error) {
          console.error('Failed to inject file:', error);
          return false;
        }
      }

      // Function to inject into first compatible field
      async function injectIntoFirstField() {
        let injected = false;

        // For text content, inject into text fields
        if (sharedContent.isText && sharedContent.text) {
          const textField = document.querySelector('textarea, input[type="text"], input:not([type])');
          if (textField) {
            textField.value = sharedContent.text;
            textField.dispatchEvent(new Event('input', { bubbles: true }));
            textField.dispatchEvent(new Event('change', { bubbles: true }));
            textField.focus();
            console.log('Shared text injected into:', textField.tagName);
            showToast('Texto compartilhado inserido!');
            injected = true;
          }
        }

        // For files with URI (images, PDFs, etc.)
        if (!injected && sharedContent.hasUri) {
          // First try to find a file input and inject the file
          const fileInput = document.querySelector('input[type="file"]');
          if (fileInput) {
            const success = await injectFileIntoInput(fileInput, sharedContent.uri, sharedContent.mimeType);
            if (success) {
              showToast('Arquivo anexado!');
              injected = true;
            }
          }

          // If no file input or injection failed, try image src
          if (!injected && sharedContent.isImage) {
            const imgField = document.querySelector('img:not([src]), img[src=""]');
            if (imgField) {
              imgField.src = sharedContent.uri;
              console.log('Shared image set to img element');
              showToast('Imagem compartilhada anexada!');
              injected = true;
            }
          }

          // For any file, dispatch sharedFile event
          if (!injected) {
            console.log('Dispatching sharedFile event with URI:', sharedContent.uri);
            window.dispatchEvent(new CustomEvent('sharedFile', { 
              detail: { 
                uri: sharedContent.uri, 
                mimeType: sharedContent.mimeType,
                text: sharedContent.text
              } 
            }));
            showToast('Arquivo recebido: ' + sharedContent.mimeType);
            injected = true;
          }
        }

        // Fallback: always dispatch sharedContent event
        window.dispatchEvent(new CustomEvent('sharedContent', { detail: sharedContent }));
        console.log('sharedContent event dispatched');
        
        return injected;
      }

      // Wait for DOM to be ready
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectIntoFirstField, 100);
      } else {
        document.addEventListener('DOMContentLoaded', () => setTimeout(injectIntoFirstField, 100));
      }
    })();
  `;
}
