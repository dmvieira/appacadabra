import * as Notifications from 'expo-notifications';
import { NativeModules } from 'react-native';
import * as db from '../database/db';
import { markBackupDirty } from '../backupSync';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// ============= Alarm Registry (module-level state) =============
interface AlarmEntry { id: string; title: string; body: string; timeMs: number; isAlarm: boolean; }
const alarmRegistry = new Map<number, Map<string, AlarmEntry>>();
const alarmRegistryLoaded = new Set<number>();

// Per-app serialization lock for write operations (prevents TOCTOU on notification limit)
const notifyLocks = new Map<number, Promise<void>>();

function withNotifyLock<T>(appId: number | null, fn: () => Promise<T>): Promise<T> {
    const key = appId ?? 0;
    const prev = notifyLocks.get(key) ?? Promise.resolve();
    const task = prev.then(() => fn(), () => fn());
    notifyLocks.set(key, task.then(() => undefined, () => undefined));
    return task;
}

async function getAlarmRegistry(appId: number): Promise<Map<string, AlarmEntry>> {
    if (!alarmRegistry.has(appId)) alarmRegistry.set(appId, new Map());
    const reg = alarmRegistry.get(appId)!;
    if (!alarmRegistryLoaded.has(appId)) {
        alarmRegistryLoaded.add(appId);
        try {
            const rows = await db.getAlarmsForApp(appId);
            for (const row of rows) {
                if (!reg.has(row.alarmId)) {
                    reg.set(row.alarmId, { id: row.alarmId, title: row.title, body: row.body, timeMs: row.timeMs, isAlarm: true });
                }
            }
        } catch { }
    }
    return reg;
}

const MAX_NOTIFICATIONS_PER_SPELL = 20;

async function getSpellNotifications(appId: number | null) {
    if (!appId) return [];
    try {
        const all = await Notifications.getAllScheduledNotificationsAsync();
        return all.filter(n => {
            const content = n.content as any;
            if (content.channelId === `spell-${appId}`) return true;
            if (content.data?.appId == appId) return true;
            if (content.data?.appId && content.data.appId.toString() === appId.toString()) return true;
            if (content.data?.payload) {
                try {
                    const p = typeof content.data.payload === 'string' ? JSON.parse(content.data.payload) : content.data.payload;
                    if (p.appId && Number(p.appId) === Number(appId)) return true;
                } catch { }
            }
            if (typeof content.badge === 'number' && content.badge === Number(appId)) return true;
            return false;
        });
    } catch (e) {
        console.error('Error fetching notifications:', e);
        return [];
    }
}

async function cancelDuplicateNotification(appId: number | null, title: string, body: string) {
    console.log(`[Bridge] cancelDuplicateNotification: appId=${appId}, title=${title}`);
    const existing = await getSpellNotifications(appId);
    for (const n of existing) {
        if (n.content.title === title && n.content.body === body) {
            console.log(`[Bridge] Cancelling duplicate notification: ${n.identifier}`);
            await Notifications.cancelScheduledNotificationAsync(n.identifier);
        }
    }
    if (appId) {
        const reg = await getAlarmRegistry(appId);
        for (const [alarmId, entry] of reg.entries()) {
            if (entry.title === title && entry.body === body) {
                console.log(`[Bridge] Cancelling duplicate alarm: ${alarmId}`);
                await NativeModules.AlarmModule.cancelAlarm(alarmId).catch(() => { });
                reg.delete(alarmId);
                await db.deleteAlarm(appId, alarmId).catch(() => { });
            }
        }
    }
}

async function isAtNotificationLimit(appId: number | null): Promise<boolean> {
    const existing = await getSpellNotifications(appId);
    const alarmCount = appId ? (await getAlarmRegistry(appId)).size : 0;
    return (existing.length + alarmCount) >= MAX_NOTIFICATIONS_PER_SPELL;
}

export const notifyCapability: CapabilityModule = {
    id: 'notify',
    displayName: 'Notify',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.POST_NOTIFICATIONS',
    ],

    docs: `🔔 NOTIFICATION (AppacadabraNotify) **Native Protection**: Auto-deduplicates identical title+body. Max 20 per app (notifications + alarms combined). Use \`id\` to update existing notification.
- \`showNow(title, msg, callback)\` - Show notification immediately
    - **Return**: Notification ID (string)
- \`schedule(title, msg, delayMinutes, callback, id?)\` - Schedule after delay
    - **Return**: Notification ID (string)
- \`scheduleAt(title, msg, timeMs, callback, id?)\` - Schedule at specific time
    - **Return**: Notification ID (string)
- \`alarm(title, msg, delayMinutes, callback, id?)\` - Schedule alarm after delay (rings even on silent)
    - **Return**: Alarm ID (string)
- \`alarmAt(title, msg, timeMs, callback, id?)\` - Schedule alarm at specific time (rings even on silent)
    - **Return**: Alarm ID (string)
- \`getScheduled(callback)\` - List pending notifications and alarms. Callback: \`callback(success, data)\`
    - **data** is an already-parsed Array (do NOT JSON.parse): \`[{id, title, body, trigger: { type: "timeInterval"|"date", value: number }, isAlarm: boolean}]\` (value is seconds for interval, or timestamp for date)
- \`cancel(id, callback)\` - Cancel notification or alarm by ID
    - **Return**: "Cancelled" (string)
- \`cancelAll(callback)\` - Cancel all notifications and alarms from this app
    - **Return**: "All cancelled" (string)
- \`alert(message)\` - Show custom alert dialog (Promise<void>)
- \`confirm(message)\` - Show custom confirm dialog (Promise<boolean>)
- \`prompt(message, defaultValue)\` - Show custom prompt dialog (Promise<string|null>)`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraNotify = {
    showNow: function(title, message, callbackName) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.showNow] title:', title, 'message:', message, 'callback:', callbackName);
        sendMessage('NOTIFY_SHOW_NOW', { title, message }, callbackName);
    },
    alert: function(message, callbackName) {
        this.showNow("Alert", message, callbackName);
    },
    schedule: function(title, message, delayMinutes, callbackName, id) {
        if (window.__IS_EDIT_MODE__) return;
        var timeMs = Date.now() + (delayMinutes * 60 * 1000);
        console.log('[AppacadabraNotify.schedule] title:', title, 'delay:', delayMinutes, 'min (converted to:', new Date(timeMs).toISOString(), '), id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id: id || null }, callbackName);
    },
    scheduleAt: function(title, message, timeMs, callbackName, id) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.scheduleAt] title:', title, 'time:', new Date(timeMs).toISOString(), 'id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id: id || null }, callbackName);
    },
    alarm: function(title, message, delayMinutes, callbackName, id) {
        if (window.__IS_EDIT_MODE__) return;
        var timeMs = Date.now() + (delayMinutes * 60 * 1000);
        console.log('[AppacadabraNotify.alarm] title:', title, 'delay:', delayMinutes, 'min (converted to:', new Date(timeMs).toISOString(), '), id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id: id || null, isAlarm: true }, callbackName);
    },
    alarmAt: function(title, message, timeMs, callbackName, id) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.alarmAt] title:', title, 'time:', new Date(timeMs).toISOString(), 'id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_SCHEDULE', { title, message, timeMs, id: id || null, isAlarm: true }, callbackName);
    },
    getScheduled: function(callbackName) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.getScheduled] callback:', callbackName);
        sendMessage('NOTIFY_GET_SCHEDULED', {}, callbackName);
    },
    cancel: function(id, callbackName) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.cancel] id:', id, 'callback:', callbackName);
        sendMessage('NOTIFY_CANCEL', { id }, callbackName);
    },
    cancelAll: function(callbackName) {
        if (window.__IS_EDIT_MODE__) return;
        console.log('[AppacadabraNotify.cancelAll] callback:', callbackName);
        sendMessage('NOTIFY_CANCEL_ALL', {}, callbackName);
    },
    // Legacy alias
    scheduleNotification: function(title, message, delayMinutes, callbackName) {
        this.schedule(title, message, delayMinutes, callbackName);
    }
  };

  (function() {
    var dialogOverlay = null;
    var dialogResolve = null;

    function createOverlay() {
      if (dialogOverlay) return dialogOverlay;
      dialogOverlay = document.createElement('div');
      dialogOverlay.id = '__appacadabra_dialog_overlay__';
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

    window.alert = window.AppacadabraNotify.alert;
  })();
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'NOTIFY_SHOW_NOW': {
                console.log(`[Bridge] Notify show now: ${data.title}`);
                try {
                    const showNowPerm = await Notifications.getPermissionsAsync();
                    if (showNowPerm.status !== 'granted') {
                        const { status } = await Notifications.requestPermissionsAsync();
                        if (status !== 'granted') {
                            return { success: false, result: 'Notification permission denied' };
                        }
                    }

                    if (data.id) {
                        try { await Notifications.cancelScheduledNotificationAsync(data.id); } catch { }
                    }

                    const titleStr = typeof data.title === 'string' ? data.title : String(data.title || '');
                    const bodyStr = typeof data.message === 'string' ? data.message : String(data.message || t('appName'));
                    const appIdStr = ctx.appId ? String(ctx.appId) : '0';
                    const channelId = ctx.appId ? `spell-${ctx.appId}` : 'default';

                    await Notifications.scheduleNotificationAsync({
                        identifier: (data.id && String(data.id)) || undefined,
                        content: {
                            title: titleStr,
                            body: bodyStr,
                            data: { appId: appIdStr },
                            channelId: channelId,
                        } as any,
                        trigger: null,
                    });
                    return { success: true, result: data.id || 'Notification sent' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'NOTIFY_SCHEDULE': {
                if (ctx.isEditMode) {
                    return { success: true, result: JSON.stringify({ skipped: true, reason: 'edit_mode' }) };
                }
                return await withNotifyLock(ctx.appId, async () => {
                    const scheduleDate = new Date(data.timeMs || Date.now());
                    console.log(`[Bridge] Notify schedule: ${data.title} at ${scheduleDate.toISOString()}`);

                    try {
                        const schedulePerm = await Notifications.getPermissionsAsync();
                        if (schedulePerm.status !== 'granted') {
                            const { status } = await Notifications.requestPermissionsAsync();
                            if (status !== 'granted') {
                                return { success: false, result: 'Notification permission denied' };
                            }
                        }

                        await Notifications.setNotificationChannelAsync(`spell-${ctx.appId}`, {
                            name: `Spell ${ctx.appId}`,
                            importance: Notifications.AndroidImportance.HIGH,
                            vibrationPattern: [0, 250, 250, 250],
                            lightColor: '#FF9500',
                        });

                        await cancelDuplicateNotification(ctx.appId, data.title, data.message);

                        let isExistingId = false;
                        if (data.id) {
                            if (ctx.appId) {
                                const reg = await getAlarmRegistry(ctx.appId);
                                isExistingId = reg.has(String(data.id));
                            }
                            if (!isExistingId) {
                                const scheduled = await getSpellNotifications(ctx.appId);
                                isExistingId = scheduled.some(n => n.identifier === String(data.id));
                            }
                        }
                        if (!isExistingId && await isAtNotificationLimit(ctx.appId)) {
                            return { success: false, result: `Limit reached (max ${MAX_NOTIFICATIONS_PER_SPELL} notifications per spell)` };
                        }

                        const titleStr = typeof data.title === 'string' ? data.title : String(data.title || '');
                        const bodyStr = typeof data.message === 'string' ? data.message : String(data.message || t('appName'));
                        const appIdStr = ctx.appId ? String(ctx.appId) : '0';

                        if (data.id) {
                            try { await Notifications.cancelScheduledNotificationAsync(data.id); } catch { }
                            if (ctx.appId) {
                                const reg = await getAlarmRegistry(ctx.appId);
                                if (reg.has(String(data.id))) {
                                    await NativeModules.AlarmModule.cancelAlarm(String(data.id));
                                    reg.delete(String(data.id));
                                    await db.deleteAlarm(ctx.appId, String(data.id)).catch(() => { });
                                }
                            }
                        }

                        if (data.isAlarm) {
                            const alarmId = data.id ? String(data.id) : `alarm-${ctx.appId}-${Date.now()}`;
                            await NativeModules.AlarmModule.scheduleAlarm(alarmId, titleStr, bodyStr, scheduleDate.getTime());

                            if (ctx.appId) {
                                const reg = await getAlarmRegistry(ctx.appId);
                                reg.set(alarmId, { id: alarmId, title: titleStr, body: bodyStr, timeMs: scheduleDate.getTime(), isAlarm: true });
                                await db.saveAlarm(ctx.appId, alarmId, titleStr, bodyStr, scheduleDate.getTime()).catch(() => { });
                            }

                            markBackupDirty();
                            return { success: true, result: alarmId };
                        } else {
                            const rawDelay = Math.floor((scheduleDate.getTime() - Date.now()) / 1000);
                            const secondsDelay = Math.max(1, rawDelay);

                            const safeTrigger: any = {
                                type: 'timeInterval',
                                seconds: Number(secondsDelay),
                                repeats: false,
                            };

                            const safeContent: any = {
                                title: String(titleStr),
                                body: String(bodyStr),
                            };

                            if (appIdStr && appIdStr !== '0') {
                                const channelId = 'spell-' + String(appIdStr);

                                await Notifications.setNotificationChannelAsync(channelId, {
                                    name: data.title || `App ${appIdStr}`,
                                    importance: Notifications.AndroidImportance.DEFAULT,
                                });

                                safeContent.channelId = channelId;
                                safeContent.badge = Number(appIdStr);
                            }

                            const request: any = {
                                content: safeContent,
                                trigger: safeTrigger,
                            };

                            if (data.id) {
                                request.identifier = String(data.id);
                            }

                            console.log(`[Bridge] CLEAN OBJECT ATTEMPT: ${JSON.stringify(request)}`);

                            const identifier = await Notifications.scheduleNotificationAsync(request);
                            markBackupDirty();
                            return { success: true, result: identifier };
                        }
                    } catch (e) {
                        console.error('[Bridge] NOTIFY_SCHEDULE Error:', e);
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        return { success: false, result: errorMessage };
                    }
                });
            }

            case 'NOTIFY_HAS_PERMISSION': {
                const notifPerm = await Notifications.getPermissionsAsync();
                return { success: true, result: (notifPerm.status === 'granted').toString() };
            }

            case 'NOTIFY_REQUEST_PERMISSION': {
                await Notifications.requestPermissionsAsync();
                return { success: true, result: '' };
            }

            case 'NOTIFY_GET_SCHEDULED': {
                console.log('[Bridge] Notify get scheduled request');
                try {
                    const spellNotifications = await getSpellNotifications(ctx.appId);
                    const notifItems = spellNotifications.map(n => ({
                        id: n.identifier,
                        title: n.content.title,
                        body: n.content.body,
                        trigger: n.trigger,
                        isAlarm: false,
                    }));
                    const alarmItems = ctx.appId
                        ? Array.from((await getAlarmRegistry(ctx.appId)).values()).map(a => ({
                            id: a.id,
                            title: a.title,
                            body: a.body,
                            trigger: { type: 'date', value: a.timeMs },
                            isAlarm: true,
                        }))
                        : [];
                    const result = JSON.stringify([...notifItems, ...alarmItems]);
                    console.log(`[Bridge] Found ${notifItems.length} notifications + ${alarmItems.length} alarms`);
                    return { success: true, result };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'NOTIFY_CANCEL': {
                if (ctx.isEditMode) return { success: true, result: JSON.stringify({ skipped: true }) };
                console.log(`[Bridge] Notify cancel: ${data.id}`);
                try {
                    const idStr = String(data.id);
                    if (ctx.appId) {
                        const reg = await getAlarmRegistry(ctx.appId);
                        if (reg.has(idStr)) {
                            await NativeModules.AlarmModule.cancelAlarm(idStr);
                            reg.delete(idStr);
                            await db.deleteAlarm(ctx.appId, idStr).catch(() => { });
                            markBackupDirty();
                            return { success: true, result: 'Alarm cancelled' };
                        }
                    }
                    await Notifications.cancelScheduledNotificationAsync(data.id);
                    markBackupDirty();
                    return { success: true, result: 'Notification cancelled' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'NOTIFY_CANCEL_ALL': {
                if (ctx.isEditMode) return { success: true, result: JSON.stringify({ skipped: true }) };
                return await withNotifyLock(ctx.appId, async () => {
                    console.log(`[Bridge] Notify cancel all for spell ${ctx.appId}`);
                    try {
                        const spellToCancel = await getSpellNotifications(ctx.appId);
                        console.log(`[Bridge] Found ${spellToCancel.length} notifications to cancel`);
                        for (const n of spellToCancel) {
                            await Notifications.cancelScheduledNotificationAsync(n.identifier);
                        }
                        let alarmCancelCount = 0;
                        if (ctx.appId) {
                            const reg = await getAlarmRegistry(ctx.appId);
                            for (const alarmId of reg.keys()) {
                                try { await NativeModules.AlarmModule.cancelAlarm(alarmId); } catch { }
                                alarmCancelCount++;
                            }
                            reg.clear();
                            alarmRegistryLoaded.delete(ctx.appId);
                            await db.deleteAllAlarmsForApp(ctx.appId).catch(() => { });
                        }
                        markBackupDirty();
                        return { success: true, result: `Cancelled ${spellToCancel.length} notifications and ${alarmCancelCount} alarms` };
                    } catch (e) {
                        return { success: false, result: e instanceof Error ? e.message : 'Error' };
                    }
                });
            }

            default:
                return null;
        }
    },
};
