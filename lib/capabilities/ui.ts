import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const uiCapability: CapabilityModule = {
    id: 'ui',
    displayName: 'UI',
    minVersion: '1.0.0',

    docs: `🎨 UI HELPERS (AppacadabraUI)
- \`showLoader(message?, options?)\` - Show a full-screen loading overlay with a spinner. Options: \`{ color?: string, bg?: string }\`. Defaults: color from \`--color-primary\` CSS var or #6366f1; bg: rgba(255,255,255,0.92). **No callback.**
- \`hideLoader()\` - Hide the loading overlay. **No callback.**
- \`toast(message, type?, options?)\` - Show a brief auto-dismissing message (3s). type: \`'success'\`|\`'error'\`|\`'info'\` (default). Options: \`{ color?: string, duration?: number }\`. Color defaults: success=#10b981, error=#ef4444, info=\`--color-primary\`.
- **Customization example (dark-themed app)**:
  \`\`\`js
  AppacadabraUI.showLoader("Loading...", { color: '#38bdf8', bg: 'rgba(15,23,42,0.92)' });
  AppacadabraUI.toast("Error loading data", "error", { color: '#f87171', duration: 5000 });
  \`\`\`
- **Standard pattern**:
  \`\`\`js
  AppacadabraUI.showLoader("Processing with AI...");
  AppacadabraAI.generate(prompt, "onResult");
  window.onResult = function(success, data) {
      AppacadabraUI.hideLoader();
      if (!success) { AppacadabraUI.toast(data, "error"); return; }
      // handle result...
  };
  \`\`\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraUI = (function() {
      var LOADER_ID = '__aa_loader';
      var STYLE_ID  = '__aa_styles';

      function getPrimaryColor() {
          var c = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
          return c || '#6366f1';
      }

      function ensureStyles() {
          if (document.getElementById(STYLE_ID)) return;
          var s = document.createElement('style');
          s.id = STYLE_ID;
          s.textContent =
              '@keyframes __aaSpin{to{transform:rotate(360deg)}}' +
              '@keyframes __aaToastIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}';
          document.head.appendChild(s);
      }

      return {
          showLoader: function(message, options) {
              ensureStyles();
              var opts = options || {};
              var color = opts.color || getPrimaryColor();
              var bg    = opts.bg    || 'rgba(255,255,255,0.92)';
              var el = document.getElementById(LOADER_ID);
              if (!el) {
                  el = document.createElement('div');
                  el.id = LOADER_ID;
                  document.body.appendChild(el);
              }
              el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9998;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);background:' + bg;
              el.innerHTML =
                  '<div style="width:48px;height:48px;border:4px solid rgba(128,128,128,0.2);border-top-color:' + color + ';border-radius:50%;animation:__aaSpin 0.8s linear infinite"></div>' +
                  '<p style="margin:16px 0 0;font-weight:600;color:' + color + ';font-family:system-ui,sans-serif;font-size:15px;text-align:center;padding:0 24px">' + (message || '') + '</p>';
          },

          hideLoader: function() {
              var el = document.getElementById(LOADER_ID);
              if (el) el.style.display = 'none';
          },

          toast: function(message, type, options) {
              ensureStyles();
              var opts = options || {};
              var typeColors = { success: '#10b981', error: '#ef4444' };
              var bg = opts.color || typeColors[type] || getPrimaryColor();
              var duration = opts.duration != null ? opts.duration : 3000;
              var el = document.createElement('div');
              el.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:' + bg + ';color:#fff;padding:12px 20px;border-radius:14px;font-family:system-ui,sans-serif;font-size:15px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.18);animation:__aaToastIn 0.3s ease-out;max-width:88%;text-align:center;pointer-events:none';
              el.textContent = message;
              document.body.appendChild(el);
              setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, duration);
          }
      };
  })();
`,

    handleMessage: async (_type: string, _data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        // UI capability is pure WebView JS — no native messages
        return null;
    },
};
