import * as ai from '../api/ai';
import * as FileSystem from 'expo-file-system/legacy';
import { useManaStore } from '../manaStore';
import { useBridgeUIStore } from '../bridgeUIStore';
import { useAppStore } from '../store';
import * as db from '../database/db';
import { buildBlobMarker } from './mediaHelpers';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

async function estimateManaCost(type: string, data: any): Promise<{ display: string; value: number }> {
    const manaLabel = t('mana');
    const result = await ai.estimateManaCost(type, data);
    return { display: `${result.mana} ${manaLabel}`, value: result.value };
}

async function checkAndMarkFirstAiUse(): Promise<boolean> {
    const hasUsed = await db.getSetting('has_used_ai_ever');
    if (!hasUsed) {
        await db.setSetting('has_used_ai_ever', 'true');
        return true;
    }
    return false;
}

export const aiCapability: CapabilityModule = {
    id: 'ai',
    displayName: 'AI',
    minVersion: '1.0.0',

    docs: `🤖 AI (AppacadabraAI)
- **Fluent Builder API**: Chain methods to configure AI generation.
- **Builder Methods** (chainable — call \`generate()\` last):
    - \`generate(prompt, callback)\`: Execute the AI request with the configured options.
    - \`withSearch()\`: Enable Google Search grounding for real-time info.
    - \`withSchema(jsonSchemaObj)\`: Force structured JSON output matching the schema.
    - \`fromImage(input)\`: Attach image(s) for vision analysis or image generation. Accepts a single Base64 string OR an array (up to 14). Typically the base64 comes from \`AppacadabraCamera.takePhoto()\`.
    - \`fromVideo(input)\`: Attach video(s) for analysis/summarization. Accepts a single Base64 string OR an array. Typically the base64 comes from \`AppacadabraCamera.recordVideo()\`.
    - \`fromAudio(input)\`: Attach audio(s) for transcription/analysis. Accepts a single Base64 string (from \`AppacadabraAudio.recordStop\`) OR an array.
    - \`generateVideo(prompt, callback)\`: Generate a video from text (standalone) OR animate up to 3 reference images (chained). Returns base64 MP4. When chained with \`fromImage\`, the first image becomes the starting frame and up to 2 additional images serve as style references. The callback receives \`(success, videoBase64, thumbnailBase64)\` — \`thumbnailBase64\` is always a JPEG base64: the first frame of the video when extraction succeeds, or a static dark placeholder with a play icon when it fails. Ready to use as an \`<img>\` preview while the video loads.
    - \`generateImage(prompt, callback)\`: Generate an image from text (standalone) OR edit/remix up to 14 input images (chained with \`fromImage\`). Returns base64 PNG.
    - **Standalone-only Methods** (NOT chainable — call directly on \`AppacadabraAI\`):
    - \`similarity(itemsArray, callback)\`: Compute semantic similarity between 2+ text strings. Callback receives an already-parsed object \`{ matrix, vectors, count }\`.
    - \`parseJSON(text)\` - **Utility**: safely extract a JSON object/array from a free-text AI response string (strips markdown code fences). Returns the parsed value or \`null\` on failure. **Only needed for \`generate()\` WITHOUT \`withSchema\` — use instead of writing a custom \`extractJSON\` helper.**
        - **Example**: \`const parsed = AppacadabraAI.parseJSON(data); if (!parsed) { AppacadabraUI.toast("Parse error", "error"); return; }\`
- **Examples**:
    - Basic: \`AppacadabraAI.generate("Hello", callback)\`
    - Search: \`AppacadabraAI.withSearch().generate("Who won the game?", callback)\`
    - JSON: \`AppacadabraAI.withSchema({ type: "object", properties: { ... } }).generate("Extract data", callback)\`
    - Single image: \`AppacadabraAI.fromImage(base64).generate("Describe this", callback)\`
    - Multiple images: \`AppacadabraAI.fromImage([img1, img2, img3]).generate("Compare these images", callback)\`
    - Single video: \`AppacadabraAI.fromVideo(videoBase64).generate("Summarize this video", callback)\`
    - Single audio: \`AppacadabraAI.fromAudio(base64).generate("Transcribe this", callback)\`
    - Multiple audios: \`AppacadabraAI.fromAudio([audio1, audio2]).generate("Compare these recordings", callback)\`
    - *Chained*: \`AppacadabraAI.withSearch().withSchema(schema).generate("Find data...", callback)\`
    - Image Gen: \`AppacadabraAI.generateImage("A cute cat wearing a hat", "onImageReady")\`
    - Image edit (from takePhoto): \`AppacadabraAI.fromImage(photoBase64).generateImage("Make the sky purple", "onImageReady")\`
    - Image remix (multiple): \`AppacadabraAI.fromImage([img1, img2]).generateImage("Blend these styles", "onImageReady")\`
    - Video Gen: \`AppacadabraAI.generateVideo("A cinematic drone shot of a beach", "onVideoReady")\`
    - Image-to-video: \`AppacadabraAI.fromImage(photoBase64).generateVideo("Bring this photo to life with gentle movement", "onVideoReady")\`
    - Multi-image-to-video: \`AppacadabraAI.fromImage([img1, img2]).generateVideo("Animate blending these scenes", "onVideoReady")\`
    - Similarity (2 items): \`AppacadabraAI.similarity(["cat", "kitten"], "onResult")\` → \`{ matrix: [[1, 0.87], [0.87, 1]], vectors: [[0.1, ...], [0.12, ...]], count: 2 }\`
    - Similarity (3+ items): \`AppacadabraAI.similarity(["dog", "puppy", "car"], "onResult")\` → \`{ matrix: [[1, 0.91, 0.12], [0.91, 1, 0.10], [0.12, 0.10, 1]], vectors: [...], count: 3 }\`
- **Return (generate)**: Generated text string. If \`withSchema\` is used, \`data\` is already a parsed JS object — use \`data.field\` directly, do NOT call \`JSON.parse(data)\`.
- **Return (generateImage)**: Complete DataURI string (e.g. \`data:image/png;base64,...\`). Use directly as img src (do NOT append prefixes manually).
- **Return (generateVideo)**: Callback receives \`(success, videoDataUri, thumbnailDataUri)\`. Use directly as src. Example: \`function onVideoReady(ok, videoUri, thumbUri) { if (thumbUri) img.src = thumbUri; vid.src = videoUri; }\`
- **Return (similarity)**: Already-parsed object \`{ matrix: number[][], vectors: number[][], count: number }\` — use \`data.matrix\` directly. \`matrix\` = pairwise cosine similarity (symmetric, 1.0 on diagonal, 0.0-1.0). \`vectors\` = raw embedding arrays (optional, for advanced use like caching or custom distance).`,

    validationMock: `    function sampleFromSchema(s) {
        if (!s) return {};
        if (s.type === 'string') return 'test';
        if (s.type === 'number' || s.type === 'integer') return 0;
        if (s.type === 'boolean') return false;
        if (s.type === 'array') return s.items ? [sampleFromSchema(s.items)] : [];
        if (s.type === 'object') {
            var obj = {};
            if (s.properties) Object.keys(s.properties).forEach(function(k) { obj[k] = sampleFromSchema(s.properties[k]); });
            return obj;
        }
        return null;
    }
    function makeAIBuilder(schema) {
        var builder = {
            withSchema: function(s) { return makeAIBuilder(s); },
            withSearch: function() { return this; },
            fromImage: function() { return this; },
            fromVideo: function() { return this; },
            fromAudio: function() { return this; },
            generate: function(prompt, callbackName) {
                if (callbackName && typeof window[callbackName] === 'function') {
                    var sample = schema ? JSON.stringify(sampleFromSchema(schema)) : '{}';
                    window[callbackName](true, sample);
                }
            }
        };
        return builder;
    }
    window.AppacadabraAI = {
        withSchema: function(s) { return makeAIBuilder(s); },
        withSearch: function() { return makeAIBuilder(null); },
        fromImage: function() { return makeAIBuilder(null); },
        fromVideo: function() { return makeAIBuilder(null); },
        fromAudio: function() { return makeAIBuilder(null); },
        generate: function(prompt, cb) {
            if (cb && typeof window[cb] === 'function') window[cb](true, '{}');
        },
        generateImage: noop,
        generateVideo: noop,
        similarity: noop,
    };`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraAI = (function() {
    var LIMITS = {
      images: { maxCount: 10, maxSizeChars: 7000000, label: 'image', sizeMB: '5MB' },
      videos: { maxCount: 2,  maxSizeChars: 27000000, label: 'video', sizeMB: '20MB' },
      audios: { maxCount: 5,  maxSizeChars: 14000000, label: 'audio', sizeMB: '10MB' }
    };

    function validateMedia(items, type) {
      var limit = LIMITS[type];
      if (!items || !items.length) return null;
      if (items.length > limit.maxCount) {
        return 'Too many ' + limit.label + 's: ' + items.length + ' provided, max ' + limit.maxCount;
      }
      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].length > limit.maxSizeChars) {
          var approxMB = Math.round(items[i].length * 3 / 4 / 1048576 * 10) / 10;
          return limit.label + ' #' + (i + 1) + ' is too large (' + approxMB + 'MB). Max ' + limit.sizeMB + ' per ' + limit.label;
        }
      }
      return null;
    }

    function AIBuilder() {
      this.options = {
        search: false,
        schema: null,
        images: null,
        videos: null,
        audios: null
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

    AIBuilder.prototype.fromImage = function(input, options) {
      this.options.images = Array.isArray(input) ? input : [input];
      if (options) this.options.imageOptions = options;
      return this;
    };

    AIBuilder.prototype.fromVideo = function(input, options) {
      this.options.videos = Array.isArray(input) ? input : [input];
      if (options) this.options.videoOptions = options;
      return this;
    };

    AIBuilder.prototype.fromAudio = function(input, options) {
      this.options.audios = Array.isArray(input) ? input : [input];
      if (options) this.options.audioOptions = options;
      return this;
    };

    AIBuilder.prototype.generateVideo = function(prompt, callbackName) {
      console.log('[AppacadabraAI.generateVideo] prompt:', (prompt && prompt.substring ? prompt.substring(0, 80) : prompt), 'callback:', callbackName);
      var interceptName = callbackName + '_intercept_' + Math.floor(Math.random()*10000);

      var options = this.options;

      function makeVideoPlaceholder(w, h) {
        try {
          var c = document.createElement('canvas');
          c.width = w || 320; c.height = h || 180;
          var ctx = c.getContext('2d');
          if (!ctx) throw new Error('No canvas context');
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, c.width, c.height);
          var cx = c.width / 2, cy = c.height / 2, r = Math.min(c.width, c.height) * 0.18;
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.beginPath();
          ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.moveTo(cx - r * 0.4, cy - r * 0.7);
          ctx.lineTo(cx - r * 0.4, cy + r * 0.7);
          ctx.lineTo(cx + r * 0.9, cy);
          ctx.closePath();
          ctx.fill();
          var result = c.toDataURL('image/jpeg', 0.8).split(',')[1];
          return result || '';
        } catch(e) {
          return 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        }
      }

      function deliverWithThumb(videoInput, isUrl) {
        var delivered = false;
        function deliver(thumb) {
          if (delivered) return;
          delivered = true;
          var thumbBase64 = thumb || makeVideoPlaceholder(320, 180);
          if (!thumbBase64) thumbBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
          var thumbDataUri = thumbBase64.indexOf('data:') === 0
              ? thumbBase64
              : (thumbBase64.substring(0, 6) === 'R0lGOD'
                  ? 'data:image/gif;base64,' + thumbBase64
                  : 'data:image/jpeg;base64,' + thumbBase64);
          if (window[callbackName]) window[callbackName](true, videoInput, thumbDataUri);
        }
        try {
          var video  = document.createElement('video');
          var canvas = document.createElement('canvas');
          var timer  = setTimeout(function() { deliver(null); }, 4000);

          video.onloadedmetadata = function() {
            canvas.width  = Math.min(video.videoWidth  || 320, 640);
            canvas.height = Math.min(video.videoHeight || 180, 360);
            video.currentTime = 0;
          };
          video.onseeked = function() {
            try {
              var ctx = canvas.getContext('2d');
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              var dataUrl = canvas.toDataURL('image/jpeg', 0.6);
              var thumb = dataUrl.split(',')[1] || '';
              clearTimeout(timer);
              video.src = '';
              deliver(thumb || null);
            } catch(e) { clearTimeout(timer); deliver(null); }
          };
          video.onerror = function(err) {
            console.error('[BridgeVideo] Thumb error for ' + (isUrl ? 'URL' : 'B64'), err);
            clearTimeout(timer); deliver(null);
          };
          video.src = isUrl ? videoInput : ('data:video/mp4;base64,' + videoInput);
          video.load();
        } catch(e) { deliver(null); }
      }

      window[interceptName] = function(success, result) {
          if (!success) {
              if (window[callbackName]) window[callbackName](false, result);
              delete window[interceptName];
              return;
          }

          if (typeof result === 'string' && (result.indexOf('http') === 0 || result.indexOf('file://') === 0)) {
              deliverWithThumb(result, true);
          } else if (typeof result === 'string' && result.indexOf('__appblob__:') === 0) {
              if (window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[result]) {
                  var dataUri = window.__APPACADABRA_BLOB_CACHE__[result];
                  var base64 = dataUri.replace(/^data:.*?;base64,/i, '').replace(/\\s/g, '');
                  deliverWithThumb(base64, false);
              } else {
                  window.addEventListener('appacadabra:media:ready', function handler(e) {
                      if (e.detail.marker === result) {
                          var b64 = e.detail.dataUri.replace(/^data:.*?;base64,/i, '').replace(/\\s/g, '');
                          deliverWithThumb(b64, false);
                          window.removeEventListener('appacadabra:media:ready', handler);
                      }
                  });
              }
          } else {
              deliverWithThumb(result, false);
          }
          delete window[interceptName];
      };

      sendMessage('AI_GENERATE_VIDEO', { prompt: prompt, images: options.images }, interceptName);
    };

    AIBuilder.prototype.generateImage = function(prompt, callbackName) {
      console.log('[AppacadabraAI.generateImage] prompt:', (prompt && prompt.substring ? prompt.substring(0, 80) : prompt), 'callback:', callbackName);
      var interceptName = callbackName + '_intercept_' + Math.floor(Math.random()*10000);
      window[interceptName] = function(success, result) {
          if (success && typeof result === 'string' && result.indexOf('http') === 0) {
              fetch(result)
                  .then(function(res) { return res.blob(); })
                  .then(function(blob) {
                      var reader = new FileReader();
                      reader.onloadend = function() {
                         var base64 = reader.result.split(',')[1] || reader.result;
                         if (window[callbackName]) window[callbackName](true, base64);
                      };
                      reader.readAsDataURL(blob);
                  })
                  .catch(function(err) {
                      if (window[callbackName]) window[callbackName](false, "Failed to download image from storage: " + err.message);
                  });
          } else if (success && result && typeof result === 'string' && result.indexOf('__appblob__:') === 0) {
              var parts = result.split('|');
              var cn = parts.length >= 3 ? parts[1] : '';
              if (cn && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[cn]) {
                  window.__APPACADABRA_MARKER_CACHE__ = window.__APPACADABRA_MARKER_CACHE__ || {};
                  window.__APPACADABRA_MARKER_CACHE__[cn] = result;
                  if (window[callbackName]) window[callbackName](true, window.__APPACADABRA_BLOB_CACHE__[cn]);
              } else {
                  window.addEventListener('appacadabra:media:ready', function handler(e) {
                      if (e.detail.marker === result || (cn && e.detail.marker.indexOf('|' + cn + '|') !== -1)) {
                          if (window[callbackName]) window[callbackName](true, e.detail.dataUri);
                          window.removeEventListener('appacadabra:media:ready', handler);
                      }
                  });
              }
              delete window[interceptName];
          } else {
              if (window[callbackName]) window[callbackName](success, result);
              delete window[interceptName];
          }
      };
      sendMessage('AI_GENERATE_IMAGE', { prompt: prompt, images: this.options.images }, interceptName);
    };

    AIBuilder.prototype.generate = function(prompt, callbackName) {
      var err = validateMedia(this.options.images, 'images')
             || validateMedia(this.options.videos, 'videos')
             || validateMedia(this.options.audios, 'audios');
      if (err) {
        console.error('[AppacadabraAI] ' + err);
        if (callbackName && window[callbackName]) {
          window[callbackName](false, err);
        }
        return;
      }

      var logParts = ['[AppacadabraAI.generate]'];
      if (this.options.search) logParts.push('search:true');
      if (this.options.schema) logParts.push('schema:' + JSON.stringify(this.options.schema));
      if (this.options.images) logParts.push('images:' + this.options.images.length + ' items');
      if (this.options.videos) logParts.push('videos:' + this.options.videos.length + ' items');
      if (this.options.audios) logParts.push('audios:' + this.options.audios.length + ' items');
      if (prompt) logParts.push('prompt:' + (prompt && prompt.substring ? prompt.substring(0, 80) : prompt));
      logParts.push('callback:' + callbackName);
      console.log(logParts.join(' '));

      sendMessage('AI_GENERATE', {
        prompt: prompt,
        search: this.options.search,
        schema: this.options.schema,
        images: this.options.images,
        videos: this.options.videos,
        audios: this.options.audios
      }, callbackName);
    };

    return {
      withSearch: function() { return new AIBuilder().withSearch(); },
      withSchema: function(s) { return new AIBuilder().withSchema(s); },
      fromImage: function(input, opts) { return new AIBuilder().fromImage(input, opts); },
      fromVideo: function(input, opts) { return new AIBuilder().fromVideo(input, opts); },
      fromAudio: function(input, opts) { return new AIBuilder().fromAudio(input, opts); },
      generate: function(prompt, cb) { return new AIBuilder().generate(prompt, cb); },
      generateImage: function(prompt, callbackName) {
        console.log('[AppacadabraAI.generateImage] prompt:', (prompt && prompt.substring ? prompt.substring(0, 80) : prompt), 'callback:', callbackName);
        var interceptName = callbackName + '_intercept_' + Math.floor(Math.random()*10000);
        window[interceptName] = function(success, result) {
            if (success && typeof result === 'string' && result.indexOf('http') === 0) {
                fetch(result)
                    .then(function(res) { return res.blob(); })
                    .then(function(blob) {
                        var reader = new FileReader();
                        reader.onloadend = function() {
                           var base64 = reader.result.split(',')[1] || reader.result;
                           if (window[callbackName]) window[callbackName](true, base64);
                        };
                        reader.onerror = function() {
                           if (window[callbackName]) window[callbackName](false, "Failed to read image Blob");
                        };
                        reader.readAsDataURL(blob);
                    })
                    .catch(function(err) {
                        if (window[callbackName]) window[callbackName](false, "Failed to download image from storage: " + err.message);
                    });
            } else if (success && result && typeof result === 'string' && result.indexOf('__appblob__:') === 0) {
                var parts = result.split('|');
                var cn = parts.length >= 3 ? parts[1] : '';
                if (cn && window.__APPACADABRA_BLOB_CACHE__ && window.__APPACADABRA_BLOB_CACHE__[cn]) {
                    window.__APPACADABRA_MARKER_CACHE__ = window.__APPACADABRA_MARKER_CACHE__ || {};
                    window.__APPACADABRA_MARKER_CACHE__[cn] = result;
                    if (window[callbackName]) window[callbackName](true, window.__APPACADABRA_BLOB_CACHE__[cn]);
                } else {
                    window.addEventListener('appacadabra:media:ready', function handler(e) {
                        if (e.detail.marker === result || (cn && e.detail.marker.indexOf('|' + cn + '|') !== -1)) {
                            if (window[callbackName]) window[callbackName](true, e.detail.dataUri);
                            window.removeEventListener('appacadabra:media:ready', handler);
                        }
                    });
                }
                delete window[interceptName];
            } else {
                if (window[callbackName]) window[callbackName](success, result);
                delete window[interceptName];
            }
        };
        sendMessage('AI_GENERATE_IMAGE', { prompt: prompt }, interceptName);
      },
      generateVideo: function(prompt, callbackName) {
        return new AIBuilder().generateVideo(prompt, callbackName);
      },
      similarity: function(items, callbackName) {
        console.log('[AppacadabraAI.similarity] items:', items ? items.length : 0, 'callback:', callbackName);
        sendMessage('AI_SIMILARITY', { items: items }, callbackName);
      },
      parseJSON: function(str) {
        if (typeof str === 'object' && str !== null) return str;
        if (!str || typeof str !== 'string') return null;
        try {
            var clean = str.replace(/\`\`\`[a-z]*\\n?/gi, '').replace(/\`\`\`/g, '').trim();
            var fi = clean.indexOf('['), fb = clean.indexOf('{');
            var start = -1, end = -1;
            if (fi !== -1 && (fb === -1 || fi < fb)) {
                start = fi; end = clean.lastIndexOf(']') + 1;
            } else if (fb !== -1) {
                start = fb; end = clean.lastIndexOf('}') + 1;
            }
            return JSON.parse((start !== -1 && end > start) ? clean.slice(start, end) : clean);
        } catch (e) { return null; }
      }
    };
  })();
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'AI_GENERATE': {
                let generateCostDisplay: string;
                let generateCostValue: number;
                try {
                    ({ display: generateCostDisplay, value: generateCostValue } = await estimateManaCost('generate', data));
                } catch (e) {
                    console.warn('[Bridge] Mana estimation failed, blocking operation:', e);
                    useManaStore.getState().openShop();
                    return { success: false, result: t('manaDepletedMessage') };
                }
                if (generateCostValue > useManaStore.getState().balance) {
                    useManaStore.getState().openShop(generateCostValue);
                    return { success: false, result: t('manaDepletedMessage') };
                }
                const manaConfirmedGenerate = await useBridgeUIStore.getState()
                    .requestManaConfirmation(ctx.appId, 'generate', generateCostDisplay);
                if (!manaConfirmedGenerate) { return { success: false, result: t('manaConfirmCancelled') }; }
                console.log(`[Bridge] AI Generate request: ${data.prompt?.substring(0, 50)}...`);
                try {
                    const genResult = await ai.aiGenerate({
                        prompt: data.prompt,
                        search: data.search,
                        schema: data.schema,
                        images: data.images,
                        videos: data.videos,
                        audios: data.audios,
                        onJobCreated: ctx.onJobCreated,
                    });
                    const result = genResult.text;

                    const creditsUsed = genResult.creditsUsed || 0;
                    console.log(`[Bridge] AI generated. Credits used: ${creditsUsed}`);

                    if (ctx.appId && creditsUsed > 0) {
                        try {
                            await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                            console.log(`[Bridge] App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                        } catch (e) {
                            console.warn('Failed to update app mana cost:', e);
                        }
                    }

                    const isFirstAiUse = await checkAndMarkFirstAiUse();
                    return { success: true, result, creditsUsed, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';

                    const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                        errorMsg.toLowerCase().includes('insufficient mana');

                    if (isManaError) {
                        useManaStore.getState().openShop();
                        return { success: false, result: t('manaDepletedMessage') };
                    } else {
                        return { success: false, result: errorMsg };
                    }
                }
            }

            case 'AI_SIMILARITY': {
                let similarityCostDisplay: string;
                let similarityCostValue: number;
                try {
                    ({ display: similarityCostDisplay, value: similarityCostValue } = await estimateManaCost('similarity', data));
                } catch (e) {
                    console.warn('[Bridge] Mana estimation failed, blocking operation:', e);
                    useManaStore.getState().openShop();
                    return { success: false, result: t('manaDepletedMessage') };
                }
                if (similarityCostValue > useManaStore.getState().balance) {
                    useManaStore.getState().openShop(similarityCostValue);
                    return { success: false, result: t('manaDepletedMessage') };
                }
                const manaConfirmedSimilarity = await useBridgeUIStore.getState()
                    .requestManaConfirmation(ctx.appId, 'similarity', similarityCostDisplay);
                if (!manaConfirmedSimilarity) { return { success: false, result: t('manaConfirmCancelled') }; }
                console.log(`[Bridge] AI Similarity request: ${data.items?.length || 0} items`);
                try {
                    const simResult = await ai.aiSimilarity(data.items || [], ctx.onJobCreated);
                    const result = simResult.text;

                    const creditsUsed = simResult.creditsUsed || 0;
                    console.log(`[Bridge] AI similarity. Credits used: ${creditsUsed}`);

                    if (ctx.appId && creditsUsed > 0) {
                        try {
                            await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                        } catch (e) {
                            console.warn('Failed to update app mana cost:', e);
                        }
                    }

                    const isFirstAiUse = await checkAndMarkFirstAiUse();
                    return { success: true, result, creditsUsed, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';
                    const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                        errorMsg.toLowerCase().includes('insufficient mana');
                    if (isManaError) {
                        useManaStore.getState().openShop();
                        return { success: false, result: t('manaDepletedMessage') };
                    } else {
                        return { success: false, result: errorMsg };
                    }
                }
            }

            case 'AI_GENERATE_IMAGE': {
                let imageCostDisplay: string;
                let imageCostValue: number;
                try {
                    ({ display: imageCostDisplay, value: imageCostValue } = await estimateManaCost('image', data));
                } catch (e) {
                    console.warn('[Bridge] Mana estimation failed, blocking operation:', e);
                    useManaStore.getState().openShop();
                    return { success: false, result: t('manaDepletedMessage') };
                }
                if (imageCostValue > useManaStore.getState().balance) {
                    useManaStore.getState().openShop(imageCostValue);
                    return { success: false, result: t('manaDepletedMessage') };
                }
                const manaConfirmedImage = await useBridgeUIStore.getState()
                    .requestManaConfirmation(ctx.appId, 'image', imageCostDisplay);
                if (!manaConfirmedImage) { return { success: false, result: t('manaConfirmCancelled') }; }
                console.log(`[Bridge] AI Image Gen request: ${data.prompt?.substring(0, 50)}...`);
                try {
                    const imgResult = await ai.aiGenerateImage(data.prompt, data.images ?? undefined, ctx.onJobCreated);
                    const result = imgResult.imageBase64;

                    const creditsUsed = imgResult.creditsUsed || 0;
                    console.log(`[Bridge] AI image generated. Credits used: ${creditsUsed}`);

                    if (ctx.appId && creditsUsed > 0) {
                        try {
                            await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                            console.log(`[Bridge] App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                        } catch (e) {
                            console.warn('Failed to update app mana cost:', e);
                        }
                    }

                    const isFirstAiUse = await checkAndMarkFirstAiUse();
                    return { success: true, result, creditsUsed, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';

                    const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                        errorMsg.toLowerCase().includes('insufficient mana');

                    if (isManaError) {
                        useManaStore.getState().openShop();
                        return { success: false, result: t('manaDepletedMessage') };
                    } else {
                        return { success: false, result: errorMsg };
                    }
                }
            }

            case 'AI_GENERATE_VIDEO': {
                let videoCostDisplay: string;
                let videoCostValue: number;
                try {
                    ({ display: videoCostDisplay, value: videoCostValue } = await estimateManaCost('video', data));
                } catch (e) {
                    console.warn('[Bridge] Mana estimation failed, blocking operation:', e);
                    useManaStore.getState().openShop();
                    return { success: false, result: t('manaDepletedMessage') };
                }
                if (videoCostValue > useManaStore.getState().balance) {
                    useManaStore.getState().openShop(videoCostValue);
                    return { success: false, result: t('manaDepletedMessage') };
                }
                const manaConfirmedVideo = await useBridgeUIStore.getState()
                    .requestManaConfirmation(ctx.appId, 'video', videoCostDisplay);
                if (!manaConfirmedVideo) { return { success: false, result: t('manaConfirmCancelled') }; }
                console.log(`[Bridge] AI Video Gen request: ${data.prompt?.substring(0, 50)}...`);
                try {
                    const videoResult = await ai.aiGenerateVideo(data.prompt, data.images ?? undefined, ctx.onJobCreated);
                    let permanentVideoPath: string | undefined;
                    if (ctx.appId && ctx.callbackName) {
                        try {
                            const docDir = (FileSystem.documentDirectory ?? '').replace('file://', '');
                            const dir = `${docDir}appacadabra_media/${ctx.appId}`;
                            await FileSystem.makeDirectoryAsync(`file://${dir}`, { intermediates: true }).catch(() => { });
                            permanentVideoPath = `${dir}/${ctx.callbackName}.mp4`;
                            await FileSystem.writeAsStringAsync(`file://${permanentVideoPath}`, videoResult.videoBase64.replace(/[\r\n]/g, ''), {
                                encoding: FileSystem.EncodingType.Base64,
                            });
                        } catch (saveErr) {
                            console.warn('[AI_GENERATE_VIDEO] Failed to save permanent file:', saveErr);
                        }
                    }
                    const result = permanentVideoPath ?? videoResult.videoBase64;

                    const creditsUsed = videoResult.creditsUsed || 0;
                    console.log(`[Bridge] AI video generated. Credits used: ${creditsUsed}`);

                    if (ctx.appId && creditsUsed > 0) {
                        try {
                            await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                            console.log(`[Bridge] App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                        } catch (e) {
                            console.warn('Failed to update app mana cost:', e);
                        }
                    }

                    const isFirstAiUse = await checkAndMarkFirstAiUse();
                    return { success: true, result, creditsUsed, isFirstAiUse };
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : 'Error';

                    const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                        errorMsg.toLowerCase().includes('insufficient mana');

                    if (isManaError) {
                        useManaStore.getState().openShop();
                        return { success: false, result: t('manaDepletedMessage') };
                    } else {
                        return { success: false, result: errorMsg };
                    }
                }
            }

            default:
                return null;
        }
    },
};
