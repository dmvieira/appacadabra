import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { learnStoreSpell } from '../lib/storeLearn';
import type { StoreSearchItem } from '../lib/storeSearch';

interface StoreSpellCardProps {
    spell: StoreSearchItem;
}

export function StoreSpellCard({ spell }: StoreSpellCardProps) {
    const [state, setState] = useState<'idle' | 'learning' | 'learned' | 'error'>('idle');

    const handleLearn = async () => {
        if (state === 'learning' || state === 'learned') return;
        setState('learning');
        try {
            await learnStoreSpell(spell.spellId);
            setState('learned');
        } catch {
            setState('error');
        }
    };

    const ctaLabel =
        state === 'learning' ? t('obDiscoverLearning')
        : state === 'learned' ? t('obDiscoverLearned')
        : state === 'error' ? t('learnSpellFailed')
        : t('obDiscoverLearn');

    return (
        <View style={s.row}>
            {spell.iconUrl ? (
                <Image source={{ uri: spell.iconUrl }} style={s.icon} />
            ) : (
                <View style={[s.icon, s.iconFallback]}>
                    <Text style={s.iconFallbackText}>✦</Text>
                </View>
            )}
            <View style={s.body}>
                <Text style={s.name} numberOfLines={1}>{spell.name}</Text>
                {spell.description ? (
                    <Text style={s.desc} numberOfLines={2}>{spell.description}</Text>
                ) : null}
                <View style={s.metaRow}>
                    {spell.authorName ? (
                        <Text style={s.meta} numberOfLines={1}>{spell.authorName}</Text>
                    ) : null}
                    {spell.learnCount > 0 ? (
                        <Text style={s.meta}> · {spell.learnCount} ✨</Text>
                    ) : null}
                </View>
            </View>
            <TouchableOpacity
                style={[s.cta, (state === 'learning' || state === 'learned') && s.ctaMuted]}
                onPress={handleLearn}
                disabled={state === 'learning' || state === 'learned'}
                accessibilityRole="button"
                accessibilityLabel={ctaLabel}
            >
                {state === 'learning' ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                    <Text style={s.ctaText}>{ctaLabel}</Text>
                )}
            </TouchableOpacity>
        </View>
    );
}

const s = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#12121f',
        borderWidth: 1,
        borderColor: 'rgba(124,58,237,0.18)',
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm,
        gap: spacing.md,
    },
    icon: {
        width: 44,
        height: 44,
        borderRadius: borderRadius.md,
    },
    iconFallback: {
        backgroundColor: '#1e1e32',
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconFallbackText: {
        fontSize: 20,
        color: colors.primary,
    },
    body: {
        flex: 1,
        minWidth: 0,
    },
    name: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.onSurface,
    },
    desc: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginTop: 2,
    },
    metaRow: {
        flexDirection: 'row',
        marginTop: 4,
    },
    meta: {
        fontSize: 11,
        color: '#8b8aad',
    },
    cta: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: borderRadius.full,
        minWidth: 84,
        alignItems: 'center',
        justifyContent: 'center',
    },
    ctaMuted: {
        backgroundColor: '#1e1e32',
    },
    ctaText: {
        color: colors.onPrimary,
        fontSize: 12,
        fontWeight: '700',
    },
});
