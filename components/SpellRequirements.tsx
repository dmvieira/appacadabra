import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { getCuratedProvider } from '../lib/mcp/curatedCatalog';
import { getAllConnections } from '../lib/mcp/store';
import { connectProvider } from '../lib/mcp/manager';
import type { McpConnection } from '../lib/mcp/types';

const CAPABILITY_EMOJI: Record<string, string> = {
    AI: '🤖',
    UI: '🎨',
    Camera: '📷',
    Audio: '🔊',
    Contacts: '👥',
    Calendar: '📅',
    Clipboard: '📋',
    Device: '📱',
    Docs: '📄',
    Forms: '📝',
    Health: '❤️',
    Notify: '🔔',
    Screen: '🖥️',
    Sensors: '📡',
    Share: '📤',
    Sheets: '📊',
    MCP: '🔌',
};

interface Props {
    capabilities?: string[];
    mcps?: string[];
}

/**
 * Read-only transparency panel: what a spell uses (capabilities + MCP
 * connectors). Connectors expose a one-tap connect when not linked.
 */
export function SpellRequirements({ capabilities = [], mcps = [] }: Props) {
    const [connections, setConnections] = useState<Record<string, McpConnection>>({});
    const [busy, setBusy] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const rows = await getAllConnections();
            const map: Record<string, McpConnection> = {};
            for (const r of rows) map[r.slug] = r;
            setConnections(map);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const handleConnect = async (slug: string) => {
        // Prefer the persisted row: re-materializing the catalog descriptor
        // would reset a strategy the user changed (e.g. oauth → bearer).
        // URL-added servers only exist as rows.
        const curated = getCuratedProvider(slug);
        const conn = connections[slug];
        const target = conn ?? curated;
        if (!target) return;
        setBusy(slug);
        try {
            const res = await connectProvider(target);
            await reload();
            if (!res.success) {
                // Token-based servers (or failed OAuth) are fixed from the
                // Connections screen, which has the access-token field.
                Alert.alert(t('mcpConnectFailed'), res.error || '', [
                    { text: t('cancel'), style: 'cancel' },
                    { text: t('mcpSettingsTitle'), onPress: () => router.push('/settings/mcp') },
                ]);
            }
        } finally {
            setBusy(null);
        }
    };

    if (capabilities.length === 0 && mcps.length === 0) return null;

    return (
        <View style={styles.wrapper}>
            <Text style={styles.sectionLabel}>{t('mcpUsesTitle')}</Text>
            <View style={styles.badges}>
                {capabilities.map(cap => (
                    <View key={`cap-${cap}`} style={styles.badge}>
                        <Text style={styles.badgeEmoji}>{CAPABILITY_EMOJI[cap] ?? '🧩'}</Text>
                        <Text style={styles.badgeText}>{cap}</Text>
                    </View>
                ))}
                {mcps.map(slug => {
                    const curated = getCuratedProvider(slug);
                    const conn = connections[slug];
                    const connected = conn?.status === 'connected';
                    const isBusy = busy === slug;
                    const connectable = !!curated || !!conn;
                    return (
                        <TouchableOpacity
                            key={`mcp-${slug}`}
                            style={[styles.badge, connected && styles.badgeConnected]}
                            disabled={connected || isBusy || !connectable}
                            onPress={() => handleConnect(slug)}
                        >
                            <Text style={styles.badgeEmoji}>🔌</Text>
                            <Text style={styles.badgeText}>{curated?.name ?? conn?.name ?? slug}</Text>
                            {isBusy ? (
                                <ActivityIndicator size="small" color={colors.primary} />
                            ) : connected ? (
                                <Text style={styles.badgeStatus}>●</Text>
                            ) : (
                                <Text style={styles.badgeConnectText}>{t('mcpConnect')}</Text>
                            )}
                        </TouchableOpacity>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrapper: { marginTop: spacing.sm },
    sectionLabel: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: colors.onSurfaceVariant,
        marginBottom: spacing.xs,
    },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: 6,
    },
    badgeConnected: { borderWidth: 1, borderColor: 'rgba(34,197,94,0.35)' },
    badgeEmoji: { fontSize: 14 },
    badgeText: { color: colors.onSurface, fontSize: 13, fontWeight: '600' },
    badgeStatus: { color: '#22c55e', fontSize: 12 },
    badgeConnectText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
});
