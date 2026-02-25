import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { useAppStore } from '../lib/store';

export function EmptyState() {
    return (
        <View style={styles.container}>
            <View style={styles.howItWorks}>
                <Text style={styles.howTitle}>{t('howItWorks')}</Text>

                <Step number="1" title={t('step1Title')} description={t('step1Desc')} />
                <Step number="2" title={t('step2Title')} description={t('step2Desc')} />
                <Step number="3" title={t('step3Title')} description={t('step3Desc')} />
                <Step number="4" title={t('step4Title')} description={t('step4Desc')} />

                <DemoImportButton />
            </View>
        </View>
    );
}

function DemoImportButton() {
    const importDemoSpell = useAppStore(state => state.importDemoSpell);
    const isImporting = useAppStore(state => state.isImporting);

    return (
        <TouchableOpacity
            style={styles.demoButton}
            onPress={importDemoSpell}
            disabled={isImporting}
            accessibilityLabel={t('importDemoBtn')}
            accessibilityRole="button"
        >
            {isImporting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={colors.primary} style={{ marginEnd: 8 }} />
                    <Text style={styles.demoButtonText}>{t('importingDemo')}</Text>
                </View>
            ) : (
                <Text style={styles.demoButtonText}>{t('importDemoBtn')}</Text>
            )}
        </TouchableOpacity>
    );
}

function Step({ number, title, description }: { number: string; title: string; description: string }) {
    return (
        <View style={styles.step}>
            <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{number}</Text>
            </View>
            <View style={styles.stepContent}>
                <Text style={styles.stepTitle}>{title}</Text>
                <Text style={styles.stepDescription}>{description}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.xl,
    },
    howItWorks: {
        width: '100%',
        backgroundColor: colors.surfaceVariant + 'B3', // 70% opacity
        borderRadius: borderRadius.lg,
        padding: spacing.lg,
    },
    howTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'center',
        marginVertical: spacing.xs,
    },
    stepNumber: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    stepNumberText: {
        color: colors.onPrimary,
        fontWeight: 'bold',
        fontSize: 14,
    },
    stepContent: {
        marginStart: spacing.sm,
    },
    stepTitle: {
        color: colors.onSurface,
        fontWeight: '600',
    },
    stepDescription: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
    demoButton: {
        marginTop: spacing.lg,
        alignSelf: 'center',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
    },
    demoButtonText: {
        color: colors.primary,
        fontWeight: 'bold',
        fontSize: 14,
        textAlign: 'center',
    },
});
