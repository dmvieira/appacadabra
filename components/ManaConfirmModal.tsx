import React, { useState } from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBridgeUIStore, ManaOperationType } from '../lib/bridgeUIStore';
import { useManaStore } from '../lib/manaStore';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

const OPERATION_ICONS: Record<ManaOperationType, string> = {
    generate: '✨',
    image: '🖼️',
    video: '🎬',
    audio: '🔊',
    similarity: '🔍',
};

const DONT_SHOW_KEYS: Record<ManaOperationType, string> = {
    generate: 'manaConfirmDontShowGenerate',
    image: 'manaConfirmDontShowImage',
    video: 'manaConfirmDontShowVideo',
    audio: 'manaConfirmDontShowAudio',
    similarity: 'manaConfirmDontShowSimilarity',
};

export function ManaConfirmModal() {
    const request = useBridgeUIStore(s => s.manaConfirmRequest);
    const resolveManaConfirmation = useBridgeUIStore(s => s.resolveManaConfirmation);
    const balance = useManaStore(s => s.balance);
    const [dontShowAgain, setDontShowAgain] = useState(false);

    // Reset checkbox when a new request arrives
    React.useEffect(() => {
        if (request) setDontShowAgain(false);
    }, [request]);

    if (!request) return null;

    const { appId, operationType, costEstimate } = request;

    const handleConfirm = async () => {
        if (dontShowAgain && appId !== null) {
            try {
                await AsyncStorage.setItem(`mana_confirm_skip_${appId}_${operationType}`, 'true');
            } catch (_) {}
        }
        resolveManaConfirmation(true);
    };

    const handleCancel = () => {
        resolveManaConfirmation(false);
    };

    const icon = OPERATION_ICONS[operationType] ?? '⚡';
    const dontShowLabel = t(DONT_SHOW_KEYS[operationType]);

    return (
        <Modal
            visible={true}
            transparent
            animationType="fade"
            onRequestClose={handleCancel}
        >
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>
                        {icon}  {t('manaConfirmTitle')}
                    </Text>

                    <View style={styles.costRow}>
                        <Text style={styles.costLabel}>⚡</Text>
                        <Text style={styles.costValue}>{costEstimate}</Text>
                    </View>

                    <Text style={styles.balanceText}>
                        {t('manaConfirmBalance', { balance: balance.toFixed(1) })}
                    </Text>

                    {appId !== null && (
                        <TouchableOpacity
                            style={styles.checkboxRow}
                            onPress={() => setDontShowAgain(v => !v)}
                            activeOpacity={0.7}
                        >
                            <View style={[styles.checkbox, dontShowAgain && styles.checkboxChecked]}>
                                {dontShowAgain && <Text style={styles.checkmark}>✓</Text>}
                            </View>
                            <Text style={styles.checkboxLabel}>{dontShowLabel}</Text>
                        </TouchableOpacity>
                    )}

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
                            <Text style={styles.cancelText}>{t('manaConfirmCancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
                            <Text style={styles.confirmText}>{t('manaConfirmProceed')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
    },
    dialog: {
        width: '100%',
        maxWidth: 400,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.lg,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    costRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        marginBottom: spacing.sm,
    },
    costLabel: {
        fontSize: 20,
    },
    costValue: {
        fontSize: 22,
        fontWeight: 'bold',
        color: colors.primary,
    },
    balanceText: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
        marginBottom: spacing.md,
    },
    checkboxRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginBottom: spacing.md,
    },
    checkbox: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: colors.onSurfaceVariant,
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkboxChecked: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    checkmark: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
        lineHeight: 16,
    },
    checkboxLabel: {
        flex: 1,
        fontSize: 13,
        color: colors.onSurfaceVariant,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
        marginTop: spacing.sm,
    },
    cancelBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 15,
    },
    confirmBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
    },
    confirmText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '600',
    },
});
