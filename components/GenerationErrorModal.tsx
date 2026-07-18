import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAppStore } from '../lib/store';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

type Variant = {
    titleKey: string;
    bodyKey: string;
    primaryKey: string;
    primaryAction: 'retry' | 'openSettings' | 'openCredits';
};

function variantFor(code: string): Variant {
    switch (code) {
        case 'byok.error.noKey':
            return {
                titleKey: 'genErrorNoKeyTitle',
                bodyKey: 'genErrorNoKeyBody',
                primaryKey: 'genErrorNoKeyCta',
                primaryAction: 'openSettings',
            };
        case 'byok.error.invalidKey':
            return {
                titleKey: 'genErrorInvalidKeyTitle',
                bodyKey: 'genErrorInvalidKeyBody',
                primaryKey: 'genErrorInvalidKeyCta',
                primaryAction: 'openSettings',
            };
        case 'byok.error.outOfCredit':
            return {
                titleKey: 'genErrorOutOfCreditTitle',
                bodyKey: 'genErrorOutOfCreditBody',
                primaryKey: 'genErrorOutOfCreditCta',
                primaryAction: 'openCredits',
            };
        case 'byok.error.rateLimited':
            return {
                titleKey: 'genErrorRateLimitedTitle',
                bodyKey: 'genErrorRateLimitedBody',
                primaryKey: 'genErrorRetry',
                primaryAction: 'retry',
            };
        case 'aborted':
            return {
                titleKey: 'genErrorAbortedTitle',
                bodyKey: 'genErrorAbortedBody',
                primaryKey: 'genErrorRetry',
                primaryAction: 'retry',
            };
        default:
            return {
                titleKey: 'genErrorGenericTitle',
                bodyKey: 'genErrorGenericBody',
                primaryKey: 'genErrorRetry',
                primaryAction: 'retry',
            };
    }
}

export function GenerationErrorModal() {
    const router = useRouter();
    const error = useAppStore(s => s.generationError);
    const clearGenerationError = useAppStore(s => s.clearGenerationError);
    const retryGeneration = useAppStore(s => s.retryGeneration);

    if (!error) return null;

    const v = variantFor(error.code);

    const dismiss = () => clearGenerationError();

    const handlePrimary = () => {
        if (v.primaryAction === 'openSettings') {
            clearGenerationError();
            router.push('/settings/openrouter');
            return;
        }
        if (v.primaryAction === 'openCredits') {
            Linking.openURL('https://openrouter.ai/credits').catch(() => {});
            return;
        }
        retryGeneration();
    };

    return (
        <Modal
            visible={true}
            transparent
            animationType="fade"
            onRequestClose={dismiss}
        >
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>⚠️  {t(v.titleKey)}</Text>
                    <Text style={styles.message}>{t(v.bodyKey)}</Text>
                    {error.message ? (
                        <Text style={styles.detail} numberOfLines={3}>
                            {error.message}
                        </Text>
                    ) : null}

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={dismiss}>
                            <Text style={styles.cancelText}>{t('genErrorDismiss')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={handlePrimary}>
                            <Text style={styles.confirmText}>{t(v.primaryKey)}</Text>
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
        marginBottom: spacing.md,
        lineHeight: 20,
    },
    detail: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        fontFamily: 'monospace',
        backgroundColor: colors.background,
        padding: spacing.sm,
        borderRadius: borderRadius.sm,
        marginBottom: spacing.lg,
        opacity: 0.7,
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
