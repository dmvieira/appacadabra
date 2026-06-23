import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useBridgeUIStore } from '../lib/bridgeUIStore';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

export function KeyMissingModal() {
    const router = useRouter();
    const request = useBridgeUIStore(s => s.keyMissingRequest);
    const resolveKeyMissing = useBridgeUIStore(s => s.resolveKeyMissing);

    if (!request) return null;

    const { operationType } = request;

    const messageKey =
        operationType === 'create'
            ? 'noKeyConfiguredCreate'
            : operationType === 'edit'
              ? 'noKeyConfiguredEdit'
              : 'noKeyConfiguredFromSpell';

    const handleSetup = () => {
        resolveKeyMissing('openSettings');
        router.push('/settings/openrouter');
    };

    const handleCancel = () => resolveKeyMissing('cancel');

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
                        ⚡  {t('noKeyConfiguredTitle')}
                    </Text>

                    <Text style={styles.message}>{t(messageKey)}</Text>

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
                            <Text style={styles.cancelText}>{t('noKeyConfiguredCancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={handleSetup}>
                            <Text style={styles.confirmText}>{t('noKeyConfiguredSetup')}</Text>
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
