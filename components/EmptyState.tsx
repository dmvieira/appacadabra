import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';

export function EmptyState() {
    return (
        <View style={styles.container}>
            <Text style={styles.emoji}>🪄</Text>
            <Text style={styles.title}>Crie apps com magia!</Text>
            <Text style={styles.subtitle}>
                Descreva o app perfeito para você e a IA cria algo 100% personalizado às suas necessidades.
            </Text>

            <View style={styles.howItWorks}>
                <Text style={styles.howTitle}>Como funciona:</Text>

                <Step number="1" title="Descreva" description="Diga exatamente o que você precisa" />
                <Step number="2" title="Personalize" description="A IA cria sob medida para você" />
                <Step number="3" title="Use agora" description="Seu app funciona instantaneamente" />
                <Step number="4" title="Evolua" description="Peça mudanças e melhorias" />
            </View>
        </View>
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
    emoji: {
        fontSize: 72,
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.primary,
        textAlign: 'center',
        marginBottom: spacing.md,
    },
    subtitle: {
        fontSize: 16,
        color: colors.onSurface,
        textAlign: 'center',
        marginBottom: spacing.xl,
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
        marginLeft: spacing.sm,
    },
    stepTitle: {
        color: colors.onSurface,
        fontWeight: '600',
    },
    stepDescription: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
});
