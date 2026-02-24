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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic dark-gradient pair from a string */
function nameToGradient(name: string): string {
    const palettes = [
        '#3a1060', '#1a0f2e', '#0d2018', '#0a1520',
        '#1a0a20', '#06101a', '#1a0e04', '#12061a',
        '#0a1a14', '#16041a',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palettes[Math.abs(hash) % palettes.length];
}

function getManaLevel(total: number): 'low' | 'mid' | 'high' {
    if (total > 30) return 'high';
    if (total > 2) return 'mid';
    return 'low';
}

const MANA_COLOR = { low: '#10b981', mid: '#f59e0b', high: '#ef4444' } as const;

// ── Component ─────────────────────────────────────────────────────────────────

interface AppCardProps {
    app: GeneratedApp;
    onRun: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRename: () => void;
    onShare?: () => void;
    onIconPress?: () => void;
    onShortcut?: () => void;
    shortcutNudgeDismissed?: boolean;
    onDismissShortcutNudge?: (andCreateShortcut: boolean) => void;
    onToggleBiometric?: () => void;
    onViewSchedules?: () => void;
    isPlaceholder?: boolean;
    isLocked?: boolean;
}

export function AppCard({
    app, onRun, onEdit, onDelete, onRename,
    onShare, onIconPress, onShortcut, shortcutNudgeDismissed, onDismissShortcutNudge, onToggleBiometric, onViewSchedules,
    isPlaceholder, isLocked,
}: AppCardProps) {
    const [showSheet, setShowSheet] = useState(false);

    const locale = getCurrentLanguage() || 'en';
    const d = new Date(app.lastUpdated);
    const formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

    const isInteractionDisabled = isPlaceholder || isLocked;
    const iconBg = nameToGradient(app.name);
    const recentMana = app.recentManaCost ?? app.totalManaCost ?? 0;
    const manaLevel = getManaLevel(recentMana);
    const manaColor = MANA_COLOR[manaLevel];
    const manaStr = recentMana.toLocaleString(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
    // Period: from spell creation (max 30 days) — using createdAt, not lastUpdated
    const msPerDay = 86_400_000;
    const ageDays = Math.floor((Date.now() - (app.createdAt || app.lastUpdated)) / msPerDay);
    const windowDays = Math.min(ageDays, 30) || 1; // at least 1 day
    const periodLabel = windowDays < 30
        ? t('manaLastDays', { days: windowDays })
        : t('manaLast30Days');

    const dismissNudge = (andCreateShortcut: boolean) => {
        onDismissShortcutNudge?.(andCreateShortcut);
        if (!onDismissShortcutNudge && andCreateShortcut && onShortcut) onShortcut();
    };

    const showNudge = !isInteractionDisabled && !shortcutNudgeDismissed && !!onShortcut;

    return (
        <View style={styles.card}>
            {/* ── Card body ─────────────────────────────────────────── */}
            <TouchableOpacity
                style={styles.cardBody}
                onPress={isInteractionDisabled ? undefined : onRun}
                disabled={isInteractionDisabled}
                activeOpacity={0.75}
                accessibilityLabel={app.name}
                accessibilityRole="button"
            >
                {/* Icon */}
                <View style={[styles.cardIcon, { backgroundColor: iconBg }]}>
                    {isPlaceholder ? (
                        <ActivityIndicator size="small" color="#fff" />
                    ) : app.iconPath ? (
                        <Image source={{ uri: app.iconPath }} style={styles.iconImage} />
                    ) : (
                        <Text style={styles.iconInitials} numberOfLines={1}>
                            {app.name.slice(0, 2).toUpperCase()}
                        </Text>
                    )}
                    {!!app.requiresBiometric && (
                        <View style={styles.lockBadge}>
                            <Text style={styles.lockBadgeIcon}>🔒</Text>
                        </View>
                    )}
                </View>

                {/* Info */}
                <View style={styles.cardInfo}>
                    <Text style={styles.cardName} numberOfLines={1}>{app.name}</Text>

                    {isPlaceholder ? (
                        <Text style={[styles.cardMeta, { color: colors.primary, fontStyle: 'italic' }]}>
                            {t('generatingApp')}
                        </Text>
                    ) : isLocked ? (
                        <Text style={[styles.cardMeta, { color: colors.primary, fontStyle: 'italic' }]}>
                            {t('updatingApp')}
                        </Text>
                    ) : (
                        <>
                            <Text style={styles.cardMeta}>v{app.currentVersion} • {formattedDate}</Text>
                            {!!app.shortDescription && (
                                <Text style={styles.cardDesc} numberOfLines={1}>{app.shortDescription}</Text>
                            )}
                            <View style={styles.manaRow}>
                                <View style={[styles.manaDot, { backgroundColor: manaColor }]} />
                                <Text style={[styles.manaText, { color: manaColor }]}>
                                    ⚡ {manaStr} {periodLabel}
                                </Text>
                            </View>
                        </>
                    )}
                </View>

                {/* Corner buttons */}
                {!isInteractionDisabled && (
                    <View style={styles.cardCorner}>
                        <TouchableOpacity
                            style={styles.cornerBtn}
                            onPress={() => onEdit()}
                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                            accessibilityLabel={t('editWithAI')}
                            accessibilityRole="button"
                        >
                            <Text style={styles.cornerBtnIcon}>✏️</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.cornerBtn}
                            onPress={() => setShowSheet(true)}
                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                            accessibilityLabel={t('options')}
                            accessibilityRole="button"
                        >
                            <Text style={styles.cornerBtnMenuIcon}>⋮</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </TouchableOpacity>

            {/* ── Shortcut nudge strip ───────────────────────────────── */}
            {showNudge && (
                <View style={styles.nudgeStrip}>
                    <TouchableOpacity
                        style={styles.nudgeMain}
                        onPress={() => dismissNudge(true)}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.nudgeText}>🏠 {t('shortcutNudgeText')}</Text>
                        <Text style={styles.nudgeBtn}>{t('createShortcut')} →</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.nudgeDismiss}
                        onPress={() => dismissNudge(false)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        activeOpacity={0.6}
                    >
                        <Text style={styles.nudgeDismissIcon}>✕</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* ── Action Sheet ──────────────────────────────────────── */}
            <Modal
                visible={showSheet}
                transparent
                animationType="slide"
                onRequestClose={() => setShowSheet(false)}
            >
                <Pressable style={styles.sheetOverlay} onPress={() => setShowSheet(false)}>
                    <Pressable style={styles.sheet}>
                        <View style={styles.sheetHandle} />
                        <Text style={styles.sheetTitle} numberOfLines={1}>{app.name}</Text>

                        {/* Add to home */}
                        {onShortcut && (
                            <>
                                <TouchableOpacity
                                    style={[styles.sheetItem, styles.sheetItemHighlight]}
                                    onPress={() => { setShowSheet(false); onShortcut(); }}
                                >
                                    <Text style={styles.sheetItemIcon}>🏠</Text>
                                    <View style={styles.sheetItemBody}>
                                        <Text style={styles.sheetItemLabel}>{t('createShortcut')}</Text>
                                        <Text style={styles.sheetItemSub}>{t('shortcutSubtitle')}</Text>
                                    </View>
                                </TouchableOpacity>
                                <View style={styles.sheetSep} />
                            </>
                        )}

                        <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onEdit(); }}>
                            <Text style={styles.sheetItemIcon}>✏️</Text>
                            <View style={styles.sheetItemBody}>
                                <Text style={styles.sheetItemLabel}>{t('editWithAI')}</Text>
                                <Text style={styles.sheetItemSub}>{t('editCostHint')}</Text>
                            </View>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onRename(); }}>
                            <Text style={styles.sheetItemIcon}>📝</Text>
                            <Text style={styles.sheetItemLabel}>{t('editAppDetails')}</Text>
                        </TouchableOpacity>

                        {onIconPress && (
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onIconPress(); }}>
                                <Text style={styles.sheetItemIcon}>🖼️</Text>
                                <View style={styles.sheetItemBody}>
                                    <Text style={styles.sheetItemLabel}>{t('chooseIcon')}</Text>
                                    <Text style={styles.sheetItemSub}>{t('iconCostHint')}</Text>
                                </View>
                            </TouchableOpacity>
                        )}

                        <View style={styles.sheetSep} />

                        {onViewSchedules && (
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onViewSchedules(); }}>
                                <Text style={styles.sheetItemIcon}>🔔</Text>
                                <Text style={styles.sheetItemLabel}>{t('scheduledNotifications')}</Text>
                            </TouchableOpacity>
                        )}

                        {onToggleBiometric && (
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onToggleBiometric(); }}>
                                <Text style={styles.sheetItemIcon}>{app.requiresBiometric ? '🔓' : '🔒'}</Text>
                                <Text style={styles.sheetItemLabel}>
                                    {app.requiresBiometric ? t('disableBiometric') : t('enableBiometric')}
                                </Text>
                            </TouchableOpacity>
                        )}

                        {onShare && (
                            <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onShare(); }}>
                                <Text style={styles.sheetItemIcon}>📤</Text>
                                <Text style={styles.sheetItemLabel}>{t('shareSpell')}</Text>
                            </TouchableOpacity>
                        )}

                        <View style={styles.sheetSep} />

                        <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowSheet(false); onDelete(); }}>
                            <Text style={styles.sheetItemIcon}>🗑️</Text>
                            <Text style={[styles.sheetItemLabel, { color: colors.error }]}>{t('delete')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    // Card shell
    card: {
        backgroundColor: '#12121f',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#1e1e32',
        marginBottom: 8,
        overflow: 'hidden',
    },
    cardBody: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 12,
    },

    // Icon
    cardIcon: {
        width: 50,
        height: 50,
        borderRadius: 13,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        overflow: 'hidden',
    },
    iconImage: {
        width: 50,
        height: 50,
    },
    iconInitials: {
        color: '#fff',
        fontSize: 18,
        fontWeight: '800',
        letterSpacing: -1,
    },
    lockBadge: {
        position: 'absolute',
        bottom: 1,
        right: 1,
    },
    lockBadgeIcon: {
        fontSize: 10,
    },

    // Info
    cardInfo: {
        flex: 1,
        minWidth: 0,
    },
    cardName: {
        color: '#f1f0ff',
        fontSize: 14,
        fontWeight: '700',
        marginBottom: 2,
    },
    cardMeta: {
        color: '#c0bed8',
        fontSize: 12,
        marginBottom: 2,
    },
    cardDesc: {
        color: '#8b8aad',
        fontSize: 11,
    },
    manaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 4,
    },
    manaDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        flexShrink: 0,
    },
    manaText: {
        fontSize: 10,
    },

    // Corner buttons
    cardCorner: {
        flexDirection: 'column',
        gap: 5,
        flexShrink: 0,
    },
    cornerBtn: {
        width: 32,
        height: 30,
        backgroundColor: '#1a1a2e',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#2a2a3e',
        justifyContent: 'center',
        alignItems: 'center',
    },
    cornerBtnIcon: {
        fontSize: 13,
    },
    cornerBtnMenuIcon: {
        fontSize: 16,
        color: '#8b8aad',
        fontWeight: '700',
        lineHeight: 18,
    },

    // Nudge strip
    nudgeStrip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(245,158,11,0.07)',
        borderTopWidth: 1,
        borderTopColor: 'rgba(245,158,11,0.13)',
    },
    nudgeMain: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    nudgeText: {
        fontSize: 11,
        color: '#d97706',
        flex: 1,
    },
    nudgeBtn: {
        fontSize: 11,
        fontWeight: '700',
        color: '#f59e0b',
        marginLeft: 8,
    },
    nudgeDismiss: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignSelf: 'stretch',
        justifyContent: 'center',
        borderLeftWidth: 1,
        borderLeftColor: 'rgba(245,158,11,0.13)',
    },
    nudgeDismissIcon: {
        fontSize: 11,
        color: 'rgba(245,158,11,0.5)',
    },

    // Action sheet
    sheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: '#12121f',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: 32,
    },
    sheetHandle: {
        width: 36,
        height: 4,
        backgroundColor: '#2a2a3e',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: 10,
        marginBottom: 14,
    },
    sheetTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: '#8b8aad',
        textTransform: 'uppercase',
        letterSpacing: 1,
        paddingHorizontal: 20,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#1a1a2e',
        marginBottom: 6,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    sheetItemHighlight: {
        backgroundColor: 'rgba(245,158,11,0.06)',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(245,158,11,0.10)',
    },
    sheetItemIcon: {
        fontSize: 20,
        width: 26,
        textAlign: 'center',
        flexShrink: 0,
    },
    sheetItemBody: {
        flex: 1,
    },
    sheetItemLabel: {
        fontSize: 15,
        color: '#f1f0ff',
    },
    sheetItemSub: {
        fontSize: 11,
        color: '#8b8aad',
        marginTop: 1,
    },
    sheetSep: {
        height: 1,
        backgroundColor: '#1a1a2e',
        marginVertical: 6,
    },
});
