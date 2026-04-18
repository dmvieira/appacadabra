import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from 'react-native';
import { useBridgeUIStore } from '../lib/bridgeUIStore';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

export function LargePayloadConfirmModal() {
    const request = useBridgeUIStore(s => s.largePayloadConfirmRequest);
    const resolveLargePayloadConfirmation = useBridgeUIStore(s => s.resolveLargePayloadConfirmation);

    if (!request) return null;

    return (
        <Modal
            visible={true}
            transparent
            animationType="fade"
            onRequestClose={() => resolveLargePayloadConfirmation(false)}
        >
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>
                        ⏳  {t('largePayloadTitle')}
                    </Text>

                    <Text style={styles.message}>
                        {t('largePayloadMessage')}
                    </Text>

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={() => resolveLargePayloadConfirmation(false)}>
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={() => resolveLargePayloadConfirmation(true)}>
                            <Text style={styles.confirmText}>{t('largePayloadProceed')}</Text>
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
    message: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        marginBottom: spacing.lg,
        lineHeight: 20,
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
