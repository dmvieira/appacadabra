// JavaScript code injected into WebView to provide native API bridges
// Matches the Android GeminiJsInterface, CalendarJsInterface, NotificationJsInterface
import { buildInjectedJSFromCapabilities } from '../capabilities/index';

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

export interface ExpandedStorageItem {
  key: string;
  value: string;
  blobDataUri?: string;
  blobCallbackName?: string;
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
  // Edit mode flag - prevents localStorage persistence (mutable so it can be updated without WebView reload)
  window.__IS_EDIT_MODE__ = ${isEditMode ? 'true' : 'false'};
  
  // Store pending callbacks
  const pendingCallbacks = {};
  let callbackId = 0;
  // Queue for messages before bridge is ready
  const messageQueue = [];
  let isBridgeReady = false;

  // Cache for large media blobs being delivered in chunks
  const mediaBlobs = {};

  // Global cache for large media blobs (persists until WebView reload)
  window.__APPACADABRA_BLOB_CACHE__ = window.__APPACADABRA_BLOB_CACHE__ || {};

  // Receives a single chunk of media data
  window.receiveMediaChunk = function(marker, chunk, index, total) {
      if (!mediaBlobs[marker]) {
          mediaBlobs[marker] = new Array(total);
      }
      mediaBlobs[marker][index] = chunk;
      if (index === 0 || index === total - 1 || index % 5 === 0) {
          console.log("[BridgeBlob] Progress: " + (index+1) + "/" + total + " for " + marker.substring(0, 30) + "...");
      }
      
      // Check if complete
      var complete = true;
      for (var i = 0; i < total; i++) {
          if (mediaBlobs[marker][i] === undefined) {
              complete = false;
              break;
          }
      }
      
      if (complete) {
          console.log("[BridgeBlob] Media delivery complete for " + marker);
          var fullBase64 = mediaBlobs[marker].join('');
          var mime = marker.split('|')[0].replace('__appblob__:', '');
          // Auto-detect actual image format from magic bytes (fixes JPEG-labeled PNG images)
          if (mime.indexOf('image/') === 0) {
              if (fullBase64.substring(0, 8) === 'iVBORw0K') mime = 'image/png';
              else if (fullBase64.substring(0, 4) === '/9j/') mime = 'image/jpeg';
              else if (fullBase64.substring(0, 6) === 'R0lGOD') mime = 'image/gif';
          }
          var dataUri = "data:" + mime + ";base64," + fullBase64;
          
          // Store in global cache for late-arriving callbacks and guardrails
          window.__APPACADABRA_BLOB_CACHE__[marker] = dataUri;
          var cbPart = marker.split('|')[1];
          if (cbPart) {
              window.__APPACADABRA_BLOB_CACHE__[cbPart] = dataUri;
              window.__APPACADABRA_MARKER_CACHE__ = window.__APPACADABRA_MARKER_CACHE__ || {};
              window.__APPACADABRA_MARKER_CACHE__[cbPart] = marker;
          }
          
          // AUTO-UPDATE DOM: find any elements waiting for this marker
          try {
              var elements = document.querySelectorAll('[src="' + marker + '"], [href="' + marker + '"]');
              for (var i = 0; i < elements.length; i++) {
                  console.log("[BridgeBlob] Auto-updating pending element: " + elements[i].tagName);
                  elements[i].src = dataUri; // This triggers the setter guardrail which handles it
              }
          } catch(e) {}

          window.dispatchEvent(new CustomEvent('appacadabra:media:ready', {
              detail: { marker: marker, dataUri: dataUri }
          }));
          
          delete mediaBlobs[marker];
      }
  };

  // Helper: invoke a callback by name, supporting both window properties and const/let globals
  function __invokeCallback(name, success, data) {
      if (typeof window[name] === 'function') {
          window[name](success, data);
      } else {
          // Fallback: try eval for const/let declared globals (not on window object)
          try { eval(name + '(success, data)'); } catch(e) {}
      }
  }

  // Helper to wrap a callback to wait for media markers (Chunked Delivery)
  window.__handleChunkedMediaCallback = function(originalCallbackName, success, result) {
      if (success && typeof result === 'string' && result.indexOf('__appblob__') !== -1) {
          var marker = result;

          // Check if already in cache (race condition fix)
          if (window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[marker]) {
              console.log("[BridgeBlob] FOUND IN CACHE: " + marker.substring(0, 30) + "...");
              __invokeCallback(originalCallbackName, true, window.__APPACADABRA_BLOB_CACHE__[marker]);
              return;
          }

          console.log("[BridgeBlob] ATTACHING LISTENER for marker: " + marker.substring(0, 30) + "...");
          var resolved = false;
          var onMediaReady = function(e) {
              if (e.detail.marker === marker) {
                  resolved = true;
                  console.log("[BridgeBlob] Delivering late-arriving media to " + originalCallbackName);
                  __invokeCallback(originalCallbackName, true, e.detail.dataUri);
                  window.removeEventListener('appacadabra:media:ready', onMediaReady);
              }
          };
          window.addEventListener('appacadabra:media:ready', onMediaReady);

          // Double-check: chunks may have completed between the first cache check and listener registration
          if (!resolved && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[marker]) {
              console.log("[BridgeBlob] DOUBLE-CHECK HIT for marker: " + marker.substring(0, 30) + "...");
              window.removeEventListener('appacadabra:media:ready', onMediaReady);
              __invokeCallback(originalCallbackName, true, window.__APPACADABRA_BLOB_CACHE__[marker]);
          }
      } else {
          __invokeCallback(originalCallbackName, success, result);
      }
  };

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
          console.log('[Bridge] Native bridge detected, flushing queue (size: ' + messageQueue.length + ')');
          flushQueue();
      } else {
          setTimeout(checkBridge, 100);
      }
  }
  checkBridge();
  
  // Helper to send data back to a callback
  function sendCallback(callbackName, result, error) {
      if (!callbackName) return;
      var success = error ? false : true;
      var data = error || result;
      if (typeof window[callbackName] === 'function') {
          window[callbackName](success, data);
      } else {
          console.warn('[Bridge] Callback not found:', callbackName);
      }
  }

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


  // Helper: resolve __appblob__: markers to data URIs or clean data URIs
  function _resolveMediaValue(val) {
      if (typeof val !== 'string') return val;
      
      // Handle markers
      if (val.indexOf('__appblob__:') === 0) {
          if (window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[val]) {
              return window.__APPACADABRA_BLOB_CACHE__[val];
          }
          // Fallback: check if it matches a marker in storage cache
          if (window.__APPACADABRA_MARKER_CACHE__ && window.__APPACADABRA_MARKER_CACHE__[val]) {
              return window.__APPACADABRA_MARKER_CACHE__[val];
          }
      }
      
      // Fix duplicate data URI prefixes
      if (val.indexOf('data:') === 0 && val.indexOf('data:', 5) !== -1) {
          return val.replace(/^(data:[^;]+;base64,)+(?=data:)/i, '');
      }
      
      return val;
  }

  // Guardrail: HTMLImageElement.src
  var _imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (_imgSrc && _imgSrc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
          get: function() { return _imgSrc.get.call(this); },
          set: function(val) { _imgSrc.set.call(this, _resolveMediaValue(val)); }
      });
  }

  // Guardrail: HTMLVideoElement.src
  var _vidSrc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
  if (_vidSrc && _vidSrc.set) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
          get: function() { return _vidSrc.get.call(this); },
          set: function(val) { _vidSrc.set.call(this, _resolveMediaValue(val)); }
      });
  }

  // Guardrail: HTMLAudioElement.src
  var _AudSrc = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, 'src');
  if (_AudSrc && _AudSrc.set) {
      Object.defineProperty(HTMLAudioElement.prototype, 'src', {
          get: function() { return _AudSrc.get.call(this); },
          set: function(val) { _AudSrc.set.call(this, _resolveMediaValue(val)); }
      });
  }

  // Guardrail: setAttribute
  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
      if (name === 'src' || name === 'href') value = _resolveMediaValue(value);
      return _setAttribute.call(this, name, value);
  };

  // Guardrail: Element.prototype.innerHTML — fix double data URI prefix and __appblob__: markers
  var _setInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (_setInnerHTML && _setInnerHTML.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
          get: function() { return _setInnerHTML.get.call(this); },
          set: function(html) {
              if (typeof html === 'string' && html.length > 20 &&
                  (html.indexOf('data:') !== -1 || html.indexOf('__appblob__:') !== -1)) {
                  html = html.replace(/(src|href)="([^"]*)"/gi, function(match, attr, val) {
                      var fixed = _resolveMediaValue(val);
                      return fixed === val ? match : (attr + '="' + fixed + '"');
                  });
                  html = html.replace(/(src|href)='([^']*)'/gi, function(match, attr, val) {
                      var fixed = _resolveMediaValue(val);
                      return fixed === val ? match : (attr + "='" + fixed + "'");
                  });
              }
              _setInnerHTML.set.call(this, html);
          }
      });
  }

  // Guardrail: Element.prototype.insertAdjacentHTML — same fix
  var _insertAdjHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(position, html) {
      if (typeof html === 'string' && html.length > 20 &&
          (html.indexOf('data:') !== -1 || html.indexOf('__appblob__:') !== -1)) {
          html = html.replace(/(src|href)="([^"]*)"/gi, function(match, attr, val) {
              var fixed = _resolveMediaValue(val);
              return fixed === val ? match : (attr + '="' + fixed + '"');
          });
          html = html.replace(/(src|href)='([^']*)'/gi, function(match, attr, val) {
              var fixed = _resolveMediaValue(val);
              return fixed === val ? match : (attr + "='" + fixed + "'");
          });
      }
      _insertAdjHTML.call(this, position, html);
  };

  // Helper: wrap a callback to resolve __appblob__: markers to data URIs (Legacy/Non-chunked)
  function __setupLegacyBlobInterceptor(callbackName, interceptName) {
    window[interceptName] = function(success, result) {
      var actual = result;
      if (success && result && typeof result === 'string' && result.indexOf('__appblob__:') === 0) {
        // First check our global chunk-delivery cache
        if (window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[result]) {
          actual = window.__APPACADABRA_BLOB_CACHE__[result];
        } else {
             // Fallback for older marker format
            var parts = result.split('|');
            var cn = parts.length >= 3 ? parts[1] : '';
            if (cn && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[cn]) {
                actual = window.__APPACADABRA_BLOB_CACHE__[cn];
            }
        }
        
        // If still not found, we might need to wait for chunks
        if (actual === result) {
            console.log("[BridgeBlob] Legacy interceptor waiting for chunks for " + result);
            var onReady = function(e) {
                if (e.detail.marker === result) {
                    if (window[callbackName]) window[callbackName](true, e.detail.dataUri);
                    window.removeEventListener('appacadabra:media:ready', onReady);
                }
            };
            window.addEventListener('appacadabra:media:ready', onReady);
            delete window[interceptName];
            return;
        }
      }
      if (window[callbackName]) window[callbackName](success, actual);
      delete window[interceptName];
    };
  }



  // Storage (localStorage wrapper to sync with native DB)
  // We hook into localStorage.setItem to persist data (only in runner mode, not edit mode)
  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
      var storedValue = value;
      // If value is a data URI from our blob cache, replace with the compact marker
      if (value && typeof value === 'string' && value.indexOf('data:') === 0 && value.length > 500
          && window.__APPACADABRA_MARKER_CACHE__) {
          var prefix = value.slice(0, 100);
          for (var cn in window.__APPACADABRA_MARKER_CACHE__) {
              var cached = window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[cn];
              if (cached && cached.slice(0, 100) === prefix) {
                  storedValue = window.__APPACADABRA_MARKER_CACHE__[cn];
                  break;
              }
          }
      }
      originalSetItem.call(this, key, storedValue);
      if (!window.__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_SET', { key, value: storedValue });
      }
  };

  const originalRemoveItem = localStorage.removeItem;
  localStorage.removeItem = function(key) {
      originalRemoveItem.apply(this, arguments);
      if (!window.__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_REMOVE', { key });
      }
  };

  const originalClear = localStorage.clear;
  localStorage.clear = function() {
      originalClear.apply(this, arguments);
      if (!window.__IS_EDIT_MODE__ && !window.__APPACADABRA_RESTORING__) {
          sendMessage('STORAGE_CLEAR', {});
      }
  };

  // Override getItem to resolve __appblob__: markers to data URIs via blob cache
  const originalGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = function(key) {
      var value = originalGetItem(key);
      if (value && typeof value === 'string' && value.indexOf('__appblob__:') === 0) {
          var parts = value.split('|');
          var cbName = parts.length >= 3 ? parts[1] : '';
          var lookupKey = cbName || key;   // fallback para o próprio key do localStorage
          if (lookupKey && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[lookupKey]) {
              return window.__APPACADABRA_BLOB_CACHE__[lookupKey];
          }
          // Old format (2 parts) or cache miss: return as-is (restore script expanded it or file was deleted)
      }
      return value;
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
  
  // Inject CSS for selection mode (deferred to avoid crash when document.head is null)
  function injectSelectionStyle() {
      const style = document.createElement('style');
      style.textContent = \`
          .selection-mode * { cursor: crosshair !important; }
          .selection-mode *:hover {
              outline: 2px solid #00f !important;
              background-color: rgba(0, 0, 255, 0.1) !important;
          }
      \`;
      (document.head || document.documentElement).appendChild(style);
  }
  if (document.head) {
      injectSelectionStyle();
  } else {
      document.addEventListener('DOMContentLoaded', injectSelectionStyle);
  }

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
    const method = (init && init.method) || 'GET';
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
      const truncatedBody = (xhr.responseText && xhr.responseText.length > 500) 
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

  document.addEventListener('appacadabra:ai:recovered', function(e) {
    var pending = (e && e.detail) ? e.detail : (window.__appacadabra_ai_pending || []);
    window.__appacadabra_ai_cache = window.__appacadabra_ai_cache || {};
    pending.forEach(function(entry) {
      if (entry.callbackName && typeof window[entry.callbackName] === 'function') {
        window[entry.callbackName](entry.success, entry.result);
      }
      window.__appacadabra_ai_cache[entry.callbackName] = {
        action: entry.action,
        result: entry.result,
        success: entry.success
      };
    });
  });

  // Capability modules (Phase 2+: each registered module contributes JS here)
  ${buildInjectedJSFromCapabilities(appId, isEditMode ?? false)}
})();
  `;
}

// Helper to generate callback script for native-to-JS calls
export function createCallbackScript(callbackName: string, success: boolean, data: any): string {
  // Hardening: if data is already an object, stringify it
  const dataString = typeof data === 'string' ? data : JSON.stringify(data);

  const escapedData = dataString
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

  return `
    (function() {
      var __d = "${escapedData}";
      if (__d && (__d[0] === '{' || __d[0] === '[')) { try { __d = JSON.parse(__d); } catch(e) {} }
      var dataPreview = typeof __d === 'string' ? (__d.length > 100 ? __d.substring(0, 100) + "..." : __d) : JSON.stringify(__d).substring(0, 100);
      if ("${callbackName}" && "${callbackName}" !== "undefined") {
          console.log("[BridgeReturn] ${callbackName} | Success: ${success} | Data: " + dataPreview);
          if (typeof window["${callbackName}"] === 'function') {
            window["${callbackName}"](${success}, __d);
          } else if (typeof ${callbackName} === 'function') {
            ${callbackName}(${success}, __d);
          }
      } else {
          console.log("[BridgeReturn] No callback | Data: " + dataPreview);
      }
    })();
  `;
}

// Generate script to detect scroll position for pull-to-refresh control
// Checks both document-level scroll AND nested scrollable containers (e.g. fixed header + scrollable content)
export function getScrollDetectionScript(): string {
  return `
    (function() {
        var lastTop = true;
        function checkScroll() {
            if (window.scrollY > 5) return false;
            var elems = document.querySelectorAll('*');
            for (var i = 0; i < elems.length; i++) {
                var el = elems[i];
                if (el.scrollTop > 5 && el.scrollHeight > el.clientHeight + 10) {
                    return false;
                }
            }
            return true;
        }
        function handler() {
            var top = checkScroll();
            if (top !== lastTop) {
                lastTop = top;
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SCROLL_STATUS', data: { isAtTop: top } }));
            }
        }
        window.addEventListener('scroll', handler, { passive: true, capture: true });
        window.addEventListener('touchmove', function() { setTimeout(handler, 50); }, { passive: true, capture: true });
        window.addEventListener('touchend', function() { setTimeout(handler, 100); }, { passive: true, capture: true });
    })();
  `;
}

// Generate script to restore localStorage from saved database items
export function createStorageRestoreScript(items: ExpandedStorageItem[]): string {
  if (!items || items.length === 0) {
    // If we have 0 items, it means the database for this app is empty.
    // We MUST clear the WebView's native localStorage so the user's 'Clear Data' action works.
    return `(function() {
      window.__APPACADABRA_BLOB_CACHE__ = window.__APPACADABRA_BLOB_CACHE__ || {};
      window.__APPACADABRA_MARKER_CACHE__ = window.__APPACADABRA_MARKER_CACHE__ || {};
      window.__APPACADABRA_RESTORING__ = true;
      try { 
          localStorage.clear(); 
          console.log('[Storage] Local storage cleared to match empty DB state'); 
      } catch(e) {}
      window.__APPACADABRA_RESTORING__ = false;
    })();`;
  }

  // Inject blob data URIs into __APPACADABRA_BLOB_CACHE__ for marker resolution
  const cacheEntries = items
    .filter(i => i.blobDataUri && i.blobCallbackName)
    .map(i => {
      const k = JSON.stringify(i.blobCallbackName!);
      const v = JSON.stringify(i.blobDataUri!);
      const fullMarker = JSON.stringify(i.value);
      // Escape backticks and ${ since this will be injected into a backtick template
      const entry = `try { window.__APPACADABRA_BLOB_CACHE__[${k}] = ${v}; window.__APPACADABRA_BLOB_CACHE__[${fullMarker}] = ${v}; window.__APPACADABRA_MARKER_CACHE__ = window.__APPACADABRA_MARKER_CACHE__ || {}; window.__APPACADABRA_MARKER_CACHE__[${k}] = ${fullMarker}; } catch(e) {}`;
      return entry.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }).join('\n        ');

  const restoreStatements = items.map(item => {
    const k = JSON.stringify(item.key);
    const v = JSON.stringify(item.value); // marker for new blobs, dataUri for old blobs, plain string otherwise
    // Escape backticks and ${ since this will be injected into a backtick template
    const stmt = `try { localStorage.setItem(${k}, ${v}); console.log('[Storage] Restored: ' + ${k}); } catch(e) { console.error('[Storage] Failed: ' + ${k}, e); }`;
    return stmt.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }).join('\n        ');

  return `
    (function() {
        console.log('[Storage] Starting restoration of ${items.length} items...');
        window.__APPACADABRA_BLOB_CACHE__ = window.__APPACADABRA_BLOB_CACHE__ || {};
        ${cacheEntries}
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
        try {
            var allBlobKeys = Object.keys(window.__APPACADABRA_BLOB_CACHE__ || {});
            for (var ki = 0; ki < allBlobKeys.length; ki++) {
                var mk = allBlobKeys[ki];
                if (mk.indexOf('__appblob__:') !== 0) continue;
                var uri = window.__APPACADABRA_BLOB_CACHE__[mk];
                var pendingEls = document.querySelectorAll('[src="' + mk + '"], [href="' + mk + '"]');
                for (var ei = 0; ei < pendingEls.length; ei++) {
                    pendingEls[ei].src = uri;
                }
            }
        } catch(e) {}
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
             imgField.src = 'data:' + sharedContent.mimeType + ';base64,' + sharedContent.base64.replace(/\s/g, '');
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

/**
 * Creates a script that wraps a dataURI callback to handle chunked delivery.
 * This is used for large media like photos or videos.
 */
export function createMediaCallbackScript(callbackName: string, success: boolean, marker: string): string {
  return `
    (function() {
      console.log("[BridgeReturn] Media callback prepared for: ${marker}");
      // Invalidate stale cache entries — prevents off-by-one when same callbackName
      // is reused across multiple recordings (all save to the same marker/file path)
      if (window.__APPACADABRA_BLOB_CACHE__) {
          delete window.__APPACADABRA_BLOB_CACHE__["${marker}"];
          delete window.__APPACADABRA_BLOB_CACHE__["${callbackName}"];
      }
      if (window.__APPACADABRA_MARKER_CACHE__) {
          delete window.__APPACADABRA_MARKER_CACHE__["${callbackName}"];
      }
      if (window.__handleChunkedMediaCallback) {
          window.__handleChunkedMediaCallback("${callbackName}", ${success}, "${marker}");
      } else {
          console.error("__handleChunkedMediaCallback not found in WebView!");
          if (typeof window["${callbackName}"] === 'function') {
              window["${callbackName}"](${success}, "${marker}");
          }
      }
    })();
  `;
}

/**
 * Creates a script that delivers a single chunk of media data to the WebView.
 */
export function createMediaChunkScript(marker: string, chunk: string, index: number, total: number): string {
  const escapedChunk = chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
    if (window.receiveMediaChunk) {
      window.receiveMediaChunk("${marker}", "${escapedChunk}", ${index}, ${total});
    } else {
      console.error("receiveMediaChunk not found in WebView!");
    }
  `;
}
