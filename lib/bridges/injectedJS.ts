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

  // Expose bridges matching Gemini system prompt
  window.AppacadabraAI = {
    generateText: function(prompt, callbackName) {
        sendMessage('AI_GENERATE_TEXT', { prompt }, callbackName);
    },
    generateTextWithSearch: function(prompt, callbackName) {
        sendMessage('AI_GENERATE_TEXT_WITH_SEARCH', { prompt }, callbackName);
    },
    describeImage: function(base64, prompt, callbackName) {
        sendMessage('AI_DESCRIBE_IMAGE', { base64, prompt }, callbackName);
    },
    transcribeAudio: function(base64, callbackName) {
        sendMessage('AI_TRANSCRIBE_AUDIO', { base64 }, callbackName);
    },
    extractStructuredData: function(text, schema, callbackName) {
        sendMessage('AI_EXTRACT_STRUCTURED', { text, schema }, callbackName);
    }
  };

  window.AppacadabraCalendar = {
    createEvent: function(title, description, startTimeMs, endTimeMs, callbackName) {
        sendMessage('CALENDAR_CREATE_EVENT', { title, description, startTimeMs, endTimeMs }, callbackName);
    },
    createEventWithReminder: function(title, description, startTimeMs, endTimeMs, reminderMinutes, callbackName) {
        sendMessage('CALENDAR_CREATE_EVENT_REMINDER', { title, description, startTimeMs, endTimeMs, reminderMinutes }, callbackName);
    }
  };

  window.AppacadabraNotify = {
    showNow: function(title, message, callbackName) {
        sendMessage('NOTIFY_SHOW_NOW', { title, message }, callbackName);
    },
    scheduleNotification: function(title, message, delayMinutes, callbackName) {
        sendMessage('NOTIFY_SCHEDULE', { title, message, delayMinutes }, callbackName);
    }
  };

  window.AppacadabraLocation = {
    getCurrentPosition: function(callbackName) {
        sendMessage('LOCATION_GET_CURRENT_POSITION', {}, callbackName);
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
      const info = {
          tagName: target.tagName,
          id: target.id,
          className: target.className,
          innerHTML: target.innerHTML,
          outerHTML: target.outerHTML
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
export function createSharedContentSetupScript(): string {
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
            showToast('Erro: Conteúdo do arquivo vazio');
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
          showToast('Erro ao processar arquivo: ' + error.message);
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
            showToast('Texto compartilhado inserido!');
            injected = true;
          }
        }

        // 2. Try File Injection (Input)
        if (!injected && (sharedContent.hasBase64 || sharedContent.base64)) {
           const fileInput = document.querySelector('input[type="file"]');
           if (fileInput) {
             if (injectFileIntoInput(fileInput, sharedContent.base64, sharedContent.mimeType, sharedContent.fileName)) {
               showToast('Arquivo anexado com sucesso!');
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
             showToast('Imagem carregada!');
             injected = true;
           }
        }
        
        // 4. Dispatch Event
        if (!injected) {
            // Check if we failed because of missing input
            const fileInput = document.querySelector('input[type="file"]');
            if (sharedContent.base64 && !fileInput) {
                showToast('Arquivo recebido (sem campo de upload)');
            } else if (!sharedContent.base64 && !sharedContent.text) {
                showToast('Erro: Conteúdo vazio');
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
  `;
}
