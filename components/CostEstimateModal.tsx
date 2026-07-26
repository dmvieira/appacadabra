/**
 * BYOK cost confirmation modal — replaces ManaConfirmModal when
 * `useByokAi` is on. Shows USD instead of mana and identifies the model
 * that will handle the call.
 *
 * Phase 2 ships in English only; Phase 3 swaps the literals for i18n keys
 * via the `/add-locale-string` workflow (plan §"Strings i18n").
 */

import React, { useState } from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBridgeUIStore, ManaOperationType } from '../lib/bridgeUIStore';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

const OPERATION_ICONS: Record<ManaOperationType, string> = {
    generate: '✨',
    image: '🖼️',
    video: '🎬',
    audio: '🔊',
    music: '🎵',
    similarity: '🔍',
};

const OPERATION_LABEL_KEYS: Record<ManaOperationType, string> = {
    generate: 'costEstimateOpGenerate',
    image: 'costEstimateOpImage',
    video: 'costEstimateOpVideo',
    audio: 'costEstimateOpAudio',
    music: 'costEstimateOpMusic',
    similarity: 'costEstimateOpSimilarity',
};

export function CostEstimateModal() {
    const request = useBridgeUIStore(s => s.costEstimateRequest);
    const resolveCostEstimate = useBridgeUIStore(s => s.resolveCostEstimate);
    const [dontShowAgain, setDontShowAgain] = useState(false);

    React.useEffect(() => {
        if (request) setDontShowAgain(false);
    }, [request]);

    if (!request) return null;

    const { appId, operationType, costUsd, modelId } = request;

    const handleConfirm = async () => {
        if (dontShowAgain && appId !== null) {
            try {
                await AsyncStorage.setItem(
                    `cost_estimate_skip_${appId}_${operationType}`,
                    'true',
                );
            } catch (_) {}
        }
        resolveCostEstimate(true);
    };

    const handleCancel = () => resolveCostEstimate(false);

    const icon = OPERATION_ICONS[operationType] ?? '⚡';
    const operationLabel = t(OPERATION_LABEL_KEYS[operationType] ?? 'costEstimateOpGenerate');
    const title = t('costEstimateTitle').replace('{operation}', operationLabel);

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
                        {icon}  {title}
                    </Text>

                    <View style={styles.costRow}>
                        <Text style={styles.costLabel}>≈</Text>
                        <Text style={styles.costValue}>{costUsd}</Text>
                        <Text style={styles.costUnit}>USD</Text>
                    </View>

                    <Text style={styles.modelText}>{t('costEstimateModelPrefix')} {modelId}</Text>

                    <Text style={styles.disclaimer}>{t('costEstimateDisclaimer')}</Text>

                    {appId !== null && (
                        <TouchableOpacity
                            style={styles.checkboxRow}
                            onPress={() => setDontShowAgain(v => !v)}
                            activeOpacity={0.7}
                        >
                            <View style={[styles.checkbox, dontShowAgain && styles.checkboxChecked]}>
                                {dontShowAgain && <Text style={styles.checkmark}>✓</Text>}
                            </View>
                            <Text style={styles.checkboxLabel}>{t('costEstimateDontShow')}</Text>
                        </TouchableOpacity>
                    )}

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
                            <Text style={styles.cancelText}>{t('costEstimateCancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
                            <Text style={styles.confirmText}>{t('costEstimateConfirm')}</Text>
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
        alignItems: 'baseline',
        gap: 8,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        marginBottom: spacing.xs,
    },
    costLabel: {
        fontSize: 18,
        color: colors.onSurfaceVariant,
    },
    costValue: {
        fontSize: 22,
        fontWeight: 'bold',
        color: colors.primary,
    },
    costUnit: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        fontWeight: '500',
    },
    modelText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        fontFamily: 'monospace',
        marginBottom: spacing.sm,
    },
    disclaimer: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        fontStyle: 'italic',
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
