import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useBridgeUIStore } from '../lib/bridgeUIStore';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

/**
 * Consent dialog shown before a spell triggers an MCP login. The actual OAuth
 * flow runs natively (in-app browser) after the user agrees; this only asks
 * permission so nothing connects silently.
 */
export function McpConnectModal() {
    const request = useBridgeUIStore(s => s.mcpConnectRequest);
    const resolve = useBridgeUIStore(s => s.resolveMcpConnect);

    if (!request) return null;

    return (
        <Modal visible transparent animationType="fade" onRequestClose={() => resolve(false)}>
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>🔌 {t('mcpConnectTitle', { name: request.name })}</Text>
                    <Text style={styles.message}>{t('mcpConnectBody', { name: request.name })}</Text>
                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={() => resolve(false)}>
                            <Text style={styles.cancelText}>{t('mcpConnectCancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.confirmBtn} onPress={() => resolve(true)}>
                            <Text style={styles.confirmText}>{t('mcpConnectCta')}</Text>
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
        marginBottom: spacing.lg,
        lineHeight: 20,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
        marginTop: spacing.sm,
    },
    cancelBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
    cancelText: { color: colors.onSurfaceVariant, fontSize: 15 },
    confirmBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
    },
    confirmText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
