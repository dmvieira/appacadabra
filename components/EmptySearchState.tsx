import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { t } from '../lib/i18n';
import { colors, borderRadius, spacing } from '../lib/theme';

interface Suggestion { title: string; description: string; }

interface Props {
    query: string;
    suggestions: Suggestion[];
    isLoading: boolean;
    onSuggestionPress: (s: Suggestion) => void;
}

export function EmptySearchState({ query, suggestions, isLoading, onSuggestionPress }: Props) {
    return (
        <View style={styles.container}>
            <View style={styles.iconWrap}>
                <Text style={styles.icon}>🔍</Text>
            </View>
            <Text style={styles.title}>
                {t('emptySearchPrefix')}{'\n'}
                <Text style={styles.queryHighlight}>"{query}"</Text>
            </Text>
            <Text style={styles.subtitle}>{t('emptySearchSubtitle')}</Text>

            {isLoading ? (
                <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: spacing.md }} />
            ) : (
                suggestions.map((s, i) => (
                    <TouchableOpacity key={i} style={styles.card} onPress={() => onSuggestionPress(s)}>
                        <View style={styles.cardIcon}><Text style={{ fontSize: 16 }}>✨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.cardLabel}>{t('createSpellWith')}</Text>
                            <Text style={styles.cardTitle}>{s.title}</Text>
                        </View>
                        <Text style={styles.arrow}>›</Text>
                    </TouchableOpacity>
                ))
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { alignItems: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.xl },
    iconWrap: {
        width: 72, height: 72,
        backgroundColor: 'rgba(124,58,237,0.12)',
        borderWidth: 1.5, borderColor: 'rgba(124,58,237,0.3)',
        borderRadius: 24, alignItems: 'center', justifyContent: 'center',
        marginBottom: spacing.md,
    },
    icon: { fontSize: 30 },
    title: {
        fontSize: 15, fontWeight: '700',
        color: colors.onSurface, textAlign: 'center',
        lineHeight: 22, marginBottom: spacing.xs,
    },
    queryHighlight: { color: colors.primary },
    subtitle: {
        fontSize: 12, color: colors.onSurfaceVariant,
        textAlign: 'center', lineHeight: 18,
        marginBottom: spacing.lg, maxWidth: 240,
    },
    card: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        borderWidth: 1, borderColor: 'rgba(124,58,237,0.25)',
        borderRadius: borderRadius.lg,
        padding: spacing.md, marginBottom: spacing.sm,
        width: '100%', gap: 10,
    },
    cardIcon: {
        width: 36, height: 36,
        backgroundColor: 'rgba(124,58,237,0.2)',
        borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    },
    cardLabel: { fontSize: 10, color: colors.onSurfaceVariant, marginBottom: 2 },
    cardTitle: { fontSize: 12, fontWeight: '600', color: colors.onSurface },
    arrow: { color: colors.primary, fontSize: 18 },
});
