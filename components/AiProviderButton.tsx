import React, { useEffect, useState } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { hasOpenRouterKey } from '../lib/api/keyStorage';
import { useAppStore } from '../lib/store';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

export function AiProviderButton() {
    const router = useRouter();
    const aiKeyVersion = useAppStore(s => s.aiKeyVersion);
    const [hasKey, setHasKey] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        hasOpenRouterKey()
            .then(v => { if (!cancelled) setHasKey(v); })
            .catch(() => { if (!cancelled) setHasKey(false); });
        return () => { cancelled = true; };
    }, [aiKeyVersion]);

    const onPress = () => router.push('/settings/openrouter');

    if (hasKey === null) return null;

    if (!hasKey) {
        return (
            <TouchableOpacity
                onPress={onPress}
                style={styles.chip}
                accessibilityRole="button"
                accessibilityLabel={t('obKeySetupCta')}
            >
                <Text style={styles.chipBolt}>⚡</Text>
                <Text style={styles.chipText}>{t('obKeySetupCta')}</Text>
            </TouchableOpacity>
        );
    }

    return (
        <TouchableOpacity
            onPress={onPress}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={t('openrouterScreenTitle')}
        >
            <Text style={styles.iconBolt}>⚡</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(245, 158, 11, 0.18)',
        borderWidth: 1,
        borderColor: '#f59e0b',
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: borderRadius.full,
        marginStart: spacing.sm,
    },
    chipBolt: {
        color: '#f59e0b',
        fontSize: 14,
        marginEnd: 4,
    },
    chipText: {
        color: '#f59e0b',
        fontSize: 13,
        fontWeight: '600',
    },
    iconBtn: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        marginStart: spacing.sm,
    },
    iconBolt: {
        color: '#f59e0b',
        fontSize: 22,
    },
});
