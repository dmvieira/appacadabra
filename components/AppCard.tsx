import React, { useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Image,
    Modal,
    Pressable,
    ActivityIndicator,
} from 'react-native';
import { GeneratedApp } from '../lib/database/types';
import { colors, borderRadius, spacing } from '../lib/theme';
import { getCurrentLanguage, t } from '../lib/i18n';

interface AppCardProps {
    app: GeneratedApp;
    onRun: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRename: () => void;
    onShare?: () => void;
    onIconPress?: () => void;
    onShortcut?: () => void;
    onToggleBiometric?: () => void;
    isPlaceholder?: boolean;
    isLocked?: boolean;
}

export function AppCard({ app, onRun, onEdit, onDelete, onRename, onShare, onIconPress, onShortcut, onToggleBiometric, isPlaceholder, isLocked }: AppCardProps) {
    const [showMenu, setShowMenu] = useState(false);

    // Use device locale for date formatting
    const locale = getCurrentLanguage() || 'en';
    const formattedDate = new Date(app.lastUpdated).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    const isInteractionDisabled = isPlaceholder || isLocked;

    return (
        <View style={[styles.card, isLocked && styles.cardLocked]}>
            <TouchableOpacity
                style={[styles.iconContainer, isLocked && styles.iconLocked]}
                onPress={isInteractionDisabled ? undefined : (onIconPress || onRename)}
                disabled={isInteractionDisabled}
            >
                {isPlaceholder ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                ) : app.iconPath ? (
                    <Image source={{ uri: app.iconPath }} style={styles.icon} />
                ) : (
                    <Text style={styles.iconText}>
                        {app.name.slice(0, 2).toUpperCase()}
                    </Text>
                )}
                {!!app.requiresBiometric && (
                    <View style={styles.lockBadge}>
                        <Text style={styles.lockBadgeIcon}>🔒</Text>
                    </View>
                )}
            </TouchableOpacity>

            <TouchableOpacity
                style={styles.info}
                onPress={isInteractionDisabled ? undefined : onRename}
                disabled={isInteractionDisabled}
            >
                <Text style={styles.name} numberOfLines={1}>
                    {app.name}
                </Text>

                {isPlaceholder ? (
                    <Text style={[styles.meta, { color: colors.primary, fontStyle: 'italic' }]}>
                        {t('generatingApp') || 'Generating App...'}
                    </Text>
                ) : isLocked ? (
                    <Text style={[styles.meta, { color: colors.primary, fontStyle: 'italic' }]}>
                        {t('updatingApp') || 'Updating with AI...'}
                    </Text>
                ) : (
                    <>
                        <Text style={styles.meta}>
                            v{app.currentVersion} • {formattedDate}
                        </Text>
                        <Text style={styles.manaUsage}>
                            {t('manaUsed')}: {(app.totalManaCost || 0).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                        </Text>
                    </>
                )}
            </TouchableOpacity>

            <View style={styles.actions}>
                <TouchableOpacity
                    style={[styles.actionBtn, isInteractionDisabled && styles.actionBtnDisabled]}
                    onPress={onRun}
                    disabled={isInteractionDisabled}
                >
                    <Text style={[styles.actionIcon, isInteractionDisabled && styles.actionIconDisabled]}>▶️</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.actionBtn, isInteractionDisabled && styles.actionBtnDisabled]}
                    onPress={onEdit}
                    disabled={isInteractionDisabled}
                >
                    <Text style={[styles.actionIcon, isInteractionDisabled && styles.actionIconDisabled]}>✏️</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.menuBtn, isInteractionDisabled && styles.disabledOpacity]}
                    onPress={() => setShowMenu(true)}
                    disabled={isInteractionDisabled}
                >
                    <Text style={styles.menuIcon}>⋮</Text>
                </TouchableOpacity>
            </View>

            {/* Context Menu Modal */}
            <Modal
                visible={showMenu}
                transparent
                animationType="fade"
                onRequestClose={() => setShowMenu(false)}
            >
                <Pressable style={styles.menuOverlay} onPress={() => setShowMenu(false)}>
                    <View style={styles.menuContent}>
                        {onShortcut && (
                            <TouchableOpacity
                                style={styles.menuItem}
                                onPress={() => { setShowMenu(false); onShortcut(); }}
                            >
                                <Text style={styles.menuItemIcon}>📌</Text>
                                <Text style={styles.menuItemText}>{t('createShortcut') || 'Shortcut'}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            style={styles.menuItem}
                            onPress={() => { setShowMenu(false); onRename(); }}
                        >
                            <Text style={styles.menuItemIcon}>📝</Text>
                            <Text style={styles.menuItemText}>{t('rename')}</Text>
                        </TouchableOpacity>
                        {onShare && (
                            <TouchableOpacity
                                style={styles.menuItem}
                                onPress={() => { setShowMenu(false); onShare(); }}
                            >
                                <Text style={styles.menuItemIcon}>📤</Text>
                                <Text style={styles.menuItemText}>{t('shareSpell')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            style={styles.menuItem}
                            onPress={() => { setShowMenu(false); if (onIconPress) onIconPress(); }}
                        >
                            <Text style={styles.menuItemIcon}>🖼️</Text>
                            <Text style={styles.menuItemText}>{t('chooseIcon')}</Text>
                        </TouchableOpacity>
                        {onToggleBiometric && (
                            <TouchableOpacity
                                style={styles.menuItem}
                                onPress={() => { setShowMenu(false); onToggleBiometric(); }}
                            >
                                <Text style={styles.menuItemIcon}>{app.requiresBiometric ? '🔓' : '🔒'}</Text>
                                <Text style={styles.menuItemText}>
                                    {app.requiresBiometric ? t('disableBiometric') : t('enableBiometric')}
                                </Text>
                            </TouchableOpacity>
                        )}
                        <View style={styles.menuDivider} />
                        <TouchableOpacity
                            style={styles.menuItem}
                            onPress={() => { setShowMenu(false); onDelete(); }}
                        >
                            <Text style={styles.menuItemIcon}>🗑️</Text>
                            <Text style={[styles.menuItemText, { color: colors.error }]}>{t('delete')}</Text>
                        </TouchableOpacity>
                    </View>
                </Pressable>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },
    cardLocked: {
        opacity: 0.9,
    },
    iconContainer: {
        width: 56,
        height: 56,
        borderRadius: borderRadius.md,
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
    },
    iconLocked: {
        opacity: 0.6,
    },
    icon: {
        width: 56,
        height: 56,
    },
    iconText: {
        color: colors.onPrimaryContainer,
        fontSize: 18,
        fontWeight: '600',
    },
    info: {
        flex: 1,
        marginLeft: spacing.md,
    },
    name: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: 'bold',
    },
    meta: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    manaUsage: {
        color: colors.primary,
        fontSize: 12,
        marginTop: 2,
        fontWeight: '500',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionBtn: {
        padding: spacing.sm,
        backgroundColor: colors.primaryContainer,
        borderRadius: borderRadius.full,
    },
    actionBtnDisabled: {
        backgroundColor: colors.surfaceVariant,
        opacity: 0.5,
    },
    actionIcon: {
        fontSize: 18,
    },
    actionIconDisabled: {
        color: colors.onSurfaceVariant,
    },
    menuBtn: {
        padding: spacing.sm,
    },
    disabledOpacity: {
        opacity: 0.3,
    },
    menuIcon: {
        fontSize: 20,
        color: colors.onSurfaceVariant,
        fontWeight: 'bold',
    },
    // Menu Styles
    menuOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    menuContent: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        minWidth: 200,
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        borderRadius: borderRadius.sm,
    },
    menuItemIcon: {
        fontSize: 18,
        marginRight: spacing.md,
    },
    menuItemText: {
        fontSize: 16,
        color: colors.onSurface,
    },
    menuDivider: {
        height: 1,
        backgroundColor: colors.surfaceVariant,
        marginVertical: spacing.xs,
    },
    lockBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: colors.surface,
        borderRadius: 10,
        padding: 2,
    },
    lockBadgeIcon: {
        fontSize: 12,
    },
});
