import React, { useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppStore } from '../lib/store';
import { buildMcpFixInstruction } from '../lib/mcp/pendingFix';
import { colors, spacing } from '../lib/theme';
import { GeneratedApp } from '../lib/database/types';
import { t } from '../lib/i18n';

export default function McpPendingFixBanner({ app, onFixStarted }: { app: GeneratedApp; onFixStarted?: () => void }) {
    const updatingAppIds = useAppStore(state => state.updatingAppIds);
    const updateAppWithAI = useAppStore(state => state.updateAppWithAI);
    const mcpFixSlugs = useMemo(() => app.mcpPendingFix ?? [], [app.mcpPendingFix]);
    const isMcpFixRunning = updatingAppIds.includes(app.id);

    const handleMcpFix = useCallback(async () => {
        if (mcpFixSlugs.length === 0 || isMcpFixRunning) return;
        const success = await updateAppWithAI(app, buildMcpFixInstruction(mcpFixSlugs));
        if (success) onFixStarted?.();
    }, [app, mcpFixSlugs, isMcpFixRunning, updateAppWithAI, onFixStarted]);

    if (mcpFixSlugs.length === 0) return null;

    return (
        <View style={styles.mcpFixBanner}>
            <View style={styles.mcpFixBannerTextWrap}>
                <Text style={styles.mcpFixBannerTitle}>⚠️ {t('mcpPendingBannerTitle')}</Text>
                <Text style={styles.mcpFixBannerBody}>
                    {t('mcpPendingBannerBody', { slugs: mcpFixSlugs.join(', ') })}
                </Text>
            </View>
            <TouchableOpacity
                style={[styles.mcpFixButton, isMcpFixRunning && styles.mcpFixButtonDisabled]}
                onPress={handleMcpFix}
                disabled={isMcpFixRunning}
                activeOpacity={0.85}
            >
                <Text style={styles.mcpFixButtonText}>
                    {isMcpFixRunning ? t('updatingApp') : t('mcpPendingFixButton')}
                </Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    mcpFixBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceVariant, borderTopWidth: 1, borderBottomWidth: 1, borderBottomColor: colors.surfaceVariant, borderTopColor: colors.tertiary, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, gap: spacing.sm },
    mcpFixBannerTextWrap: { flex: 1 },
    mcpFixBannerTitle: { color: colors.tertiary, fontSize: 13, fontWeight: '700' },
    mcpFixBannerBody: { color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 },
    mcpFixButton: { backgroundColor: colors.tertiary, borderRadius: 16, paddingVertical: 8, paddingHorizontal: 14 },
    mcpFixButtonDisabled: { opacity: 0.6 },
    mcpFixButtonText: { color: colors.onTertiary, fontSize: 13, fontWeight: '700' },
});
