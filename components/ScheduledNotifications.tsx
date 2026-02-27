import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    Pressable,
    StyleSheet,
    Modal,
    ScrollView,
    ActivityIndicator,
    Alert,
    Platform,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../lib/i18n';

interface ScheduledNotification {
    identifier: string;
    title: string | null;
    body: string | null;
    trigger: any;
    fireDate?: number; // Absolute ms timestamp computed at load time
}

interface ScheduledNotificationsProps {
    visible: boolean;
    appId: number | null;
    appName: string;
    onClose: () => void;
}

export function ScheduledNotifications({ visible, appId, appName, onClose }: ScheduledNotificationsProps) {
    const insets = useSafeAreaInsets();
    const [notifications, setNotifications] = useState<ScheduledNotification[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (visible && appId) {
            loadNotifications();
        }
    }, [visible, appId]);

    const loadNotifications = async () => {
        setLoading(true);
        try {
            const all = await Notifications.getAllScheduledNotificationsAsync();
            console.log('[ScheduledNotifications] All notifications raw:', JSON.stringify(all, null, 2));

            const filtered = all.filter(n => {
                const content = n.content as any;
                // Channel ID check
                const channelMatch = content.channelId === `spell-${appId}`;

                // Data payload check (handle both direct object and stringified payload workaround)
                let dataAppId = content.data?.appId;

                if (!dataAppId && content.data?.payload) {
                    try {
                        const parsed = typeof content.data.payload === 'string'
                            ? JSON.parse(content.data.payload)
                            : content.data.payload;
                        dataAppId = parsed.appId;
                    } catch (e) {
                        console.warn('Failed to parse notification payload', e);
                    }
                }

                const dataMatch = String(dataAppId) === String(appId);

                // Fallback: Check badge for App ID (primitive number hack)
                const badgeMatch = content.badge === Number(appId);

                return channelMatch || dataMatch || badgeMatch;
            });

            setNotifications(filtered.map(n => {
                const trigger = n.trigger as any;
                const now = Date.now();
                // Compute absolute fire timestamp from whatever the trigger provides
                let fireDate: number | undefined;
                if (trigger?.value && typeof trigger.value === 'number') {
                    fireDate = trigger.value; // Android absolute ms
                } else if (trigger?.timestamp && typeof trigger.timestamp === 'number') {
                    fireDate = trigger.timestamp;
                } else if (trigger?.type === 'date') {
                    fireDate = trigger.timestamp ?? trigger.value ?? trigger.date;
                } else if (trigger?.type === 'timeInterval' && trigger?.seconds) {
                    fireDate = now + trigger.seconds * 1000; // approximate remaining
                } else if (trigger?.dateComponents) {
                    const { year, month, day, hour = 0, minute = 0 } = trigger.dateComponents;
                    if (year && month && day) fireDate = new Date(year, month - 1, day, hour, minute).getTime();
                }
                return {
                    identifier: n.identifier,
                    title: n.content.title,
                    body: n.content.body,
                    trigger: n.trigger,
                    fireDate,
                };
            }));
        } catch (e) {
            console.error('Failed to load notifications:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleCancel = (id: string) => {
        Alert.alert(
            t('cancelNotification'),
            t('cancelNotificationConfirm') || 'Remove this notification?',
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await Notifications.cancelScheduledNotificationAsync(id);
                            setNotifications(prev => prev.filter(n => n.identifier !== id));
                        } catch (e) {
                            console.error('Failed to cancel notification:', e);
                        }
                    },
                },
            ]
        );
    };

    const formatTrigger = (n: ScheduledNotification): string => {
        // Prefer pre-computed absolute fireDate
        if (n.fireDate && n.fireDate > 0) {
            return new Date(n.fireDate).toLocaleString();
        }
        const trigger = n.trigger;
        if (!trigger) return t('immediate') || 'Immediate';
        // Final fallback: show raw trigger summary (should never reach here)
        return JSON.stringify(trigger).substring(0, 50);
    };

    if (!visible) return null;

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={styles.overlay} onPress={onClose}>
                <Pressable style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
                    <View style={styles.handle} />

                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.headerIcon}>
                            <Text style={{ fontSize: 20 }}>🔔</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.headerTitle}>{t('scheduledNotifications')}</Text>
                            <Text style={styles.headerSub}>{appName}</Text>
                        </View>
                        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                            <Text style={styles.closeBtnText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Body */}
                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color="#a78bfa" />
                        </View>
                    ) : notifications.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyIcon}>🔕</Text>
                            <Text style={styles.emptyText}>{t('noScheduledNotifications')}</Text>
                        </View>
                    ) : (
                        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                            {notifications.map((n) => (
                                <View key={n.identifier} style={styles.item}>
                                    <View style={styles.itemIconWrap}>
                                        <Text style={styles.itemEmoji}>🔔</Text>
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.itemTitle} numberOfLines={1}>{n.title || '(No title)'}</Text>
                                        {n.body && <Text style={styles.itemSub} numberOfLines={2}>{n.body}</Text>}
                                        <Text style={styles.itemTrigger}>🗓 {formatTrigger(n)}</Text>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.itemDeleteBtn}
                                        onPress={() => handleCancel(n.identifier)}
                                    >
                                        <Text style={styles.itemDeleteIcon}>🗑️</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}
                        </ScrollView>
                    )}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.55)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: '#111827',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: '70%',
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: 12,
        marginBottom: 20,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#1F2937',
    },
    headerIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    headerTitle: {
        color: '#F9FAFB',
        fontSize: 15,
        fontWeight: '800',
    },
    headerSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 1,
    },
    closeBtn: {
        marginLeft: 'auto',
        width: 32,
        height: 32,
        borderRadius: 99,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeBtnText: {
        color: '#9CA3AF',
        fontSize: 16,
    },
    loadingContainer: {
        paddingVertical: 40,
        alignItems: 'center',
    },
    emptyContainer: {
        paddingVertical: 40,
        alignItems: 'center',
    },
    emptyIcon: {
        fontSize: 48,
        marginBottom: 12,
    },
    emptyText: {
        color: '#6B7280',
        fontSize: 15,
        fontWeight: '600',
    },
    list: {
        maxHeight: 400,
    },
    listContent: {
        paddingHorizontal: 20,
        paddingTop: 16,
        gap: 8,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        backgroundColor: '#0D0D1A',
        borderWidth: 1,
        borderColor: '#1F2937',
        borderRadius: 14,
    },
    itemIconWrap: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    itemEmoji: {
        fontSize: 20,
    },
    itemTitle: {
        color: '#F9FAFB',
        fontSize: 14,
        fontWeight: '800',
    },
    itemSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 2,
    },
    itemTrigger: {
        color: '#a78bfa',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 4,
    },
    itemDeleteBtn: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: '#2a1a1a',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    itemDeleteIcon: {
        fontSize: 16,
    },
});
