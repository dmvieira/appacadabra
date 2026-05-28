import { Platform, NativeModules } from 'react-native';
import * as Notifications from 'expo-notifications';

export async function scheduleAlarm(id: string, title: string, body: string, timeMs: number): Promise<void> {
    if (Platform.OS === 'android') {
        await NativeModules.AlarmModule.scheduleAlarm(id, title, body, timeMs);
    } else {
        const seconds = Math.max(1, Math.round((timeMs - Date.now()) / 1000));
        await Notifications.scheduleNotificationAsync({
            identifier: `alarm-${id}`,
            content: { title, body },
            trigger: { seconds, repeats: false } as any,
        });
    }
}

export async function cancelAlarm(id: string): Promise<void> {
    if (Platform.OS === 'android') {
        await NativeModules.AlarmModule.cancelAlarm(id);
    } else {
        await Notifications.cancelScheduledNotificationAsync(`alarm-${id}`).catch(() => {});
    }
}
