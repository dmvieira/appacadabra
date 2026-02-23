import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Modal,
    ScrollView,
    ActivityIndicator,
    Alert,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { colors, spacing, borderRadius } from '../lib/theme';
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
            <View style={styles.overlay}>
                <View style={styles.modal}>
                    <View style={styles.header}>
                        <Text style={styles.title}>🔔 {t('scheduledNotifications')}</Text>
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.close}>✕</Text>
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.subtitle}>{appName}</Text>

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={colors.primary} />
                        </View>
                    ) : notifications.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyIcon}>🔕</Text>
                            <Text style={styles.emptyText}>{t('noScheduledNotifications')}</Text>
                        </View>
                    ) : (
                        <ScrollView style={styles.list}>
                            {notifications.map((n) => (
                                <View key={n.identifier} style={styles.card}>
                                    <View style={styles.cardContent}>
                                        <Text style={styles.cardTitle}>{n.title || '(No title)'}</Text>
                                        {n.body && <Text style={styles.cardBody} numberOfLines={2}>{n.body}</Text>}
                                        <Text style={styles.cardTrigger}>🗓 {formatTrigger(n)}</Text>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.cancelBtn}
                                        onPress={() => handleCancel(n.identifier)}
                                    >
                                        <Text style={styles.cancelIcon}>🗑️</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}
                        </ScrollView>
                    )}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    modal: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        maxHeight: '70%',
        padding: spacing.md,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
    },
    close: {
        fontSize: 24,
        color: colors.onSurfaceVariant,
        padding: 4,
    },
    subtitle: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginBottom: spacing.md,
    },
    loadingContainer: {
        paddingVertical: spacing.xl,
        alignItems: 'center',
    },
    emptyContainer: {
        paddingVertical: spacing.xl,
        alignItems: 'center',
    },
    emptyIcon: {
        fontSize: 48,
        marginBottom: spacing.md,
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
    },
    list: {
        maxHeight: 400,
    },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
    },
    cardContent: {
        flex: 1,
    },
    cardTitle: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '600',
    },
    cardBody: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginTop: 2,
    },
    cardTrigger: {
        color: colors.primary,
        fontSize: 12,
        marginTop: 4,
    },
    cancelBtn: {
        padding: spacing.sm,
        marginStart: spacing.sm,
    },
    cancelIcon: {
        fontSize: 20,
    },
});
