/**
 * Settings > Connections — MCP servers.
 *
 * Browse the curated catalog + the official MCP Registry, connect servers
 * (OAuth handled natively), inspect tools, disconnect, or add a server by URL.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect } from 'expo-router';
import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import type { McpConnection, McpProvider } from '../../lib/mcp/types';
import { searchProviders, providerFromUrl } from '../../lib/mcp/discovery';
import {
    getAllConnections,
    getCachedTools,
} from '../../lib/mcp/store';
import { connectProvider, disconnectProvider, removeProvider } from '../../lib/mcp/manager';

export default function McpSettings() {
    const [query, setQuery] = useState('');
    const [providers, setProviders] = useState<McpProvider[]>([]);
    const [connections, setConnections] = useState<Record<string, McpConnection>>({});
    const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);
    const [busySlug, setBusySlug] = useState<string | null>(null);
    const [urlInput, setUrlInput] = useState('');
    const [tokenInput, setTokenInput] = useState('');
    const [showAdd, setShowAdd] = useState(false);

    const reloadConnections = useCallback(async () => {
        const rows = await getAllConnections();
        const map: Record<string, McpConnection> = {};
        const counts: Record<string, number> = {};
        for (const row of rows) {
            map[row.slug] = row;
            const tools = await getCachedTools(row.slug);
            counts[row.slug] = tools.length;
        }
        setConnections(map);
        setToolCounts(counts);
    }, []);

    const runSearch = useCallback(async (q: string) => {
        setLoading(true);
        try {
            const results = await searchProviders(q, 20);
            setProviders(results);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void runSearch('');
    }, [runSearch]);

    useFocusEffect(
        useCallback(() => {
            void reloadConnections();
        }, [reloadConnections]),
    );

    const handleSearch = () => { void runSearch(query); };

    const handleConnect = async (provider: McpProvider) => {
        setBusySlug(provider.slug);
        try {
            const res = await connectProvider(provider, {
                bearerToken: provider.authStrategy === 'bearer' ? tokenInput || undefined : undefined,
            });
            await reloadConnections();
            if (!res.success) {
                Alert.alert(t('mcpConnectFailed'), res.error || '');
            }
        } finally {
            setBusySlug(null);
        }
    };

    const handleDisconnect = async (slug: string) => {
        setBusySlug(slug);
        try {
            await disconnectProvider(slug);
            await reloadConnections();
        } finally {
            setBusySlug(null);
        }
    };

    const handleRemove = async (slug: string) => {
        setBusySlug(slug);
        try {
            await removeProvider(slug);
            await reloadConnections();
        } finally {
            setBusySlug(null);
        }
    };

    const handleAddByUrl = async () => {
        const url = urlInput.trim();
        if (!url) return;
        const provider = providerFromUrl(url);
        if (tokenInput.trim()) provider.authStrategy = 'bearer';
        setShowAdd(false);
        setUrlInput('');
        await handleConnect(provider);
        setTokenInput('');
    };

    const renderProvider = (p: McpProvider) => {
        const conn = connections[p.slug];
        const connected = conn?.status === 'connected';
        const busy = busySlug === p.slug;
        const isCurated = p.source === 'curated';
        return (
            <View key={p.mcpUrl} style={styles.card}>
                <View style={styles.cardHeader}>
                    <View style={styles.cardIcon}>
                        <Text style={styles.cardIconText}>{isCurated ? '🔌' : '🌐'}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>{p.name}</Text>
                        {!!p.description && <Text style={styles.cardDesc} numberOfLines={2}>{p.description}</Text>}
                        {connected && (toolCounts[p.slug] > 0) && (
                            <Text style={styles.cardMeta}>{t('mcpToolsCount', { count: toolCounts[p.slug] })}</Text>
                        )}
                    </View>
                </View>
                <View style={styles.cardActions}>
                    {connected ? (
                        <>
                            <View style={styles.statusPill}>
                                <Text style={styles.statusPillText}>● {t('mcpConnected')}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.secondaryBtn}
                                disabled={busy}
                                onPress={() => handleDisconnect(p.slug)}
                            >
                                <Text style={styles.secondaryBtnText}>{t('mcpDisconnect')}</Text>
                            </TouchableOpacity>
                        </>
                    ) : (
                        <TouchableOpacity
                            style={styles.primaryBtn}
                            disabled={busy}
                            onPress={() => handleConnect(p)}
                        >
                            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{t('mcpConnect')}</Text>}
                        </TouchableOpacity>
                    )}
                    {conn && !isCurated && (
                        <TouchableOpacity style={styles.linkBtn} disabled={busy} onPress={() => handleRemove(p.slug)}>
                            <Text style={styles.linkBtnText}>{t('mcpRemove')}</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <Stack.Screen options={{ title: t('mcpSettingsTitle') }} />
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <Text style={styles.subtitle}>{t('mcpSettingsSubtitle')}</Text>

                <View style={styles.searchRow}>
                    <TextInput
                        style={styles.input}
                        placeholder={t('mcpSearchPlaceholder')}
                        placeholderTextColor="#8b8aad"
                        value={query}
                        onChangeText={setQuery}
                        onSubmitEditing={handleSearch}
                        returnKeyType="search"
                        autoCapitalize="none"
                    />
                    <TouchableOpacity style={styles.searchBtn} onPress={handleSearch}>
                        <Text style={styles.searchBtnText}>🔍</Text>
                    </TouchableOpacity>
                </View>

                <TouchableOpacity style={styles.addToggle} onPress={() => setShowAdd(v => !v)}>
                    <Text style={styles.addToggleText}>＋ {t('mcpAddByUrl')}</Text>
                </TouchableOpacity>
                {showAdd && (
                    <View style={styles.addBox}>
                        <TextInput
                            style={styles.input}
                            placeholder={t('mcpUrlPlaceholder')}
                            placeholderTextColor="#8b8aad"
                            value={urlInput}
                            onChangeText={setUrlInput}
                            autoCapitalize="none"
                            keyboardType="url"
                        />
                        <TextInput
                            style={[styles.input, { marginTop: spacing.xs }]}
                            placeholder="Token (opcional)"
                            placeholderTextColor="#8b8aad"
                            value={tokenInput}
                            onChangeText={setTokenInput}
                            autoCapitalize="none"
                            secureTextEntry={false}
                        />
                        <TouchableOpacity style={styles.primaryBtn} onPress={handleAddByUrl}>
                            <Text style={styles.primaryBtnText}>{t('mcpAdd')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {loading ? (
                    <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
                ) : providers.length === 0 ? (
                    <Text style={styles.empty}>{t('mcpNoProviders')}</Text>
                ) : (
                    providers.map(renderProvider)
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
    subtitle: { color: colors.onSurfaceVariant, fontSize: 14, marginBottom: spacing.md },
    searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    input: {
        flex: 1,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        color: colors.onSurface,
        fontSize: 15,
    },
    searchBtn: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    searchBtnText: { fontSize: 16 },
    addToggle: { marginTop: spacing.md, marginBottom: spacing.sm },
    addToggleText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    addBox: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
        gap: spacing.xs,
    },
    empty: { color: colors.onSurfaceVariant, textAlign: 'center', marginTop: spacing.xl },
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginTop: spacing.md,
    },
    cardHeader: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    cardIcon: {
        width: 40,
        height: 40,
        borderRadius: borderRadius.md,
        backgroundColor: 'rgba(124,58,237,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardIconText: { fontSize: 20 },
    cardTitle: { color: colors.onSurface, fontSize: 16, fontWeight: '700' },
    cardDesc: { color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2, lineHeight: 18 },
    cardMeta: { color: colors.primary, fontSize: 12, marginTop: 4 },
    cardActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
    statusPill: {
        backgroundColor: 'rgba(34,197,94,0.12)',
        borderRadius: borderRadius.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
    },
    statusPillText: { color: '#22c55e', fontSize: 12, fontWeight: '600' },
    primaryBtn: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minWidth: 96,
        alignItems: 'center',
    },
    primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    secondaryBtn: {
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    secondaryBtnText: { color: colors.onSurfaceVariant, fontSize: 13 },
    linkBtn: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
    linkBtnText: { color: '#ef4444', fontSize: 13 },
});
