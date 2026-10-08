import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
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
        const curated = getCuratedProvider(slug);
        if (!curated) return;
        setBusy(slug);
        try {
            await connectProvider(curated);
            await reload();
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
                    const connected = connections[slug]?.status === 'connected';
                    const isBusy = busy === slug;
                    return (
                        <TouchableOpacity
                            key={`mcp-${slug}`}
                            style={[styles.badge, connected && styles.badgeConnected]}
                            disabled={connected || isBusy || !curated}
                            onPress={() => handleConnect(slug)}
                        >
                            <Text style={styles.badgeEmoji}>🔌</Text>
                            <Text style={styles.badgeText}>{curated?.name ?? slug}</Text>
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
