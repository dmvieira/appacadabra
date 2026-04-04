import * as Battery from 'expo-battery';
import * as Network from 'expo-network';
import * as Haptics from 'expo-haptics';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const deviceCapability: CapabilityModule = {
    id: 'device',
    displayName: 'Device',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.VIBRATE',
    ],

    docs: `📱 DEVICE (AppacadabraDevice)
- \`vibrate(pattern)\` - Vibrate device (number or array of numbers). **No callback**.
- \`cancelVibration()\` - Stop vibration. **No callback**.
- \`getBatteryLevel(callback)\` - Get battery level.
    - **Callback Data**: Battery level (number 0.0 - 1.0)
- \`isCharging(callback)\` - Check if charging.
    - **Callback Data**: Charging status (boolean)
- \`isOnline(callback)\` - Check if online.
    - **Callback Data**: \`true\` or \`false\` (boolean)
- \`getNetworkType(callback)\` - Get connection info.
    - **Callback Data**: Connection type string ('wifi', 'cellular', 'none', 'unknown')
- \`language\` - **Property** (string). Device language (e.g. "en-US")
- \`userAgent\` - **Property** (string). User agent string
- \`openBrowser(url)\` - Open URL in system browser`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraDevice = {
    getBatteryLevel: function(callbackName) {
         sendMessage('DEVICE_GET_BATTERY_LEVEL', {}, callbackName);
    },
    isCharging: function(callbackName) {
         sendMessage('DEVICE_IS_CHARGING', {}, callbackName);
    },
    isOnline: function(callbackName) {
        if (callbackName) {
            sendMessage('DEVICE_IS_ONLINE', {}, callbackName);
        } else {
            return navigator.onLine;
        }
    },
    getNetworkType: function(callbackName) {
        if (callbackName) {
             sendMessage('DEVICE_GET_NETWORK_INFO', {}, callbackName);
        } else {
             console.error('[AppacadabraDevice.getNetworkType] Missing callback');
        }
    },
    vibrate: function(pattern) {
        console.log('[AppacadabraDevice.vibrate] pattern:', pattern);
        sendMessage('VIBRATE', { pattern: pattern });
    },
    cancelVibration: function() {
        console.log('[AppacadabraDevice.cancelVibration]');
        sendMessage('VIBRATE', { pattern: 0 });
    },
    language: navigator.language,
    userAgent: navigator.userAgent,
    openBrowser: function(url) {
        window.open(url, '_blank');
    }
  };

  if (navigator) {
      navigator.vibrate = function(pattern) {
          window.AppacadabraDevice.vibrate(pattern);
          return true;
      };
  }
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'DEVICE_GET_BATTERY_LEVEL':
                try {
                    const level = await Battery.getBatteryLevelAsync();
                    return { success: true, result: String(level) };
                } catch (e) {
                    console.error('Battery level error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }

            case 'DEVICE_IS_CHARGING':
                try {
                    const status = await Battery.getBatteryStateAsync();
                    const isCharging = status === Battery.BatteryState.CHARGING || status === Battery.BatteryState.FULL;
                    return { success: true, result: String(isCharging) };
                } catch (e) {
                    console.error('Battery charging error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }

            case 'DEVICE_GET_NETWORK_INFO':
                try {
                    const state = await Network.getNetworkStateAsync();
                    let networkResult: string;
                    if (state.type === Network.NetworkStateType.WIFI) networkResult = t('network_wifi');
                    else if (state.type === Network.NetworkStateType.CELLULAR) networkResult = t('network_cellular');
                    else if (state.type === Network.NetworkStateType.NONE) networkResult = t('network_none');
                    else networkResult = t('network_unknown');
                    console.log(`[Bridge] Network result: ${networkResult}`);
                    return { success: true, result: networkResult };
                } catch (e) {
                    console.error('Network info error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }

            case 'DEVICE_IS_ONLINE':
                try {
                    const state = await Network.getNetworkStateAsync();
                    return { success: true, result: String(state.isInternetReachable !== false) };
                } catch (e) {
                    console.error('Network online check error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }

            case 'VIBRATE': {
                let pattern = data.pattern;
                console.log(`[Native Bridge] VIBRATE command received. Raw type: ${typeof pattern}, Value: ${JSON.stringify(pattern)}`);
                try {
                    const { Vibration } = require('react-native');
                    Vibration.cancel();

                    if (typeof pattern === 'string') {
                        try {
                            const parsed = JSON.parse(pattern);
                            if (Array.isArray(parsed) || typeof parsed === 'number') {
                                pattern = parsed;
                            }
                        } catch {
                            console.warn('[Native Bridge] VIBRATE: Could not parse string pattern');
                        }
                    }

                    if (Array.isArray(pattern)) {
                        const validPattern = pattern.map(p => Number(p)).filter(n => !isNaN(n));
                        if (validPattern.length === 0) {
                            console.warn('[Native Bridge] VIBRATE: Empty pattern array');
                            return { success: true, result: 'Empty pattern' };
                        }
                        const { Platform } = require('react-native');
                        if (Platform.OS === 'android') {
                            Vibration.vibrate([0, ...validPattern]);
                            return { success: true, result: 'Vibrated (Android Pattern)' };
                        } else {
                            let currentTime = 0;
                            for (let i = 0; i < validPattern.length; i++) {
                                const duration = validPattern[i];
                                if (i % 2 === 0 && duration > 0) {
                                    setTimeout(() => {
                                        Vibration.vibrate();
                                        if (duration < 100) {
                                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                                        }
                                    }, currentTime);
                                }
                                currentTime += duration;
                            }
                            return { success: true, result: 'Vibrated (Manual Pattern)' };
                        }
                    } else {
                        const duration = Number(pattern);
                        if (!isNaN(duration) && duration > 0) {
                            Vibration.vibrate(duration);
                            if (duration <= 100) {
                                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                            }
                            return { success: true, result: `Vibrated ${duration}ms` };
                        } else if (duration === 0) {
                            // Already cancelled above
                            return { success: true, result: 'Vibration cancelled' };
                        } else {
                            console.warn(`[Native Bridge] VIBRATE: Invalid pattern format: ${pattern}`);
                            return { success: false, result: 'Invalid pattern' };
                        }
                    }
                } catch (e) {
                    console.error('[Native Bridge] Vibration FATAL error:', e);
                    return { success: false, result: e instanceof Error ? e.message : String(e) };
                }
            }

            default:
                return null;
        }
    },
};
