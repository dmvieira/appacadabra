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
            const filtered = all.filter(n =>
                (n.content as any).channelId === `spell-${appId}` ||
                n.content.data?.appId === appId
            );
            setNotifications(filtered.map(n => ({
                identifier: n.identifier,
                title: n.content.title,
                body: n.content.body,
                trigger: n.trigger,
            })));
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

    const formatTrigger = (trigger: any): string => {
        if (!trigger) return t('immediate') || 'Immediate';
        if (trigger.type === 'date' && trigger.timestamp) {
            return new Date(trigger.timestamp).toLocaleString();
        }
        if (trigger.type === 'timeInterval' && trigger.seconds) {
            const mins = Math.round(trigger.seconds / 60);
            return `${mins} min`;
        }
        // Fallback: try to extract date from dateComponents
        if (trigger.dateComponents) {
            const { year, month, day, hour, minute } = trigger.dateComponents;
            if (year && month && day) {
                return new Date(year, month - 1, day, hour || 0, minute || 0).toLocaleString();
            }
        }
        return JSON.stringify(trigger);
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
                                        <Text style={styles.cardTrigger}>⏱ {formatTrigger(n.trigger)}</Text>
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
        marginLeft: spacing.sm,
    },
    cancelIcon: {
        fontSize: 20,
    },
});
