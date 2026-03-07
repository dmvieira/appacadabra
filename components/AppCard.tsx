import React, { useState, useRef, useEffect } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Image,
    Modal,
    Pressable,
    ActivityIndicator,
    Platform,
    Animated,
} from 'react-native';
import { GeneratedApp } from '../lib/database/types';
import { colors } from '../lib/theme';
import { getCurrentLanguage, t } from '../lib/i18n';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic color pair (bg + fg) from a string */
const COLOR_PAIRS: [string, string][] = [
    ['#1a3a2a', '#4ade80'], // green
    ['#1a1a3a', '#818cf8'], // indigo
    ['#2a1a1a', '#f87171'], // red
    ['#1a2a3a', '#60a5fa'], // blue
    ['#2a1a2a', '#c084fc'], // purple
    ['#2a2a1a', '#facc15'], // yellow
    ['#1a2a2a', '#2dd4bf'], // teal
    ['#2a1a22', '#fb7185'], // pink
    ['#1a1a22', '#a78bfa'], // violet
    ['#22261a', '#a3e635'], // lime
];

function nameToColors(name: string): { bg: string; fg: string } {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const pair = COLOR_PAIRS[Math.abs(hash) % COLOR_PAIRS.length];
    return { bg: pair[0], fg: pair[1] };
}

function getManaLevel(total: number): 'low' | 'mid' | 'high' {
    if (total > 30) return 'high';
    if (total > 2) return 'mid';
    return 'low';
}

const MANA_COLOR = { low: '#22c55e', mid: '#f59e0b', high: '#ef4444' } as const;

// ── Component ─────────────────────────────────────────────────────────────────

interface AppCardProps {
    app: GeneratedApp;
    onRun: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRename: () => void;
    onShare?: () => void;
    onShortcut?: () => void;
    onToggleBiometric?: () => void;
    onViewSchedules?: () => void;
    isPlaceholder?: boolean;
    isLocked?: boolean;
    notificationCount?: number;
    /** 0 = no coach mark, 1 = spotlight ⋯ menu, 2 = spotlight ✏️ edit, 3 = long press hint */
    coachStep?: number;
    onCoachDismiss?: () => void;
    onLongPress?: () => void;
    onClearData?: () => void;
    isActive?: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onDismissActive?: () => void;
}

export function AppCard({
    app, onRun, onEdit, onDelete, onRename,
    onShare, onShortcut, onToggleBiometric, onViewSchedules,
    isPlaceholder, isLocked, notificationCount, coachStep, onCoachDismiss,
    onLongPress, onClearData,
    isActive, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onDismissActive,
}: AppCardProps) {
    const [showSheet, setShowSheet] = useState(false);
    const scaleAnim = useRef(new Animated.Value(1)).current;

    useEffect(() => {
        Animated.spring(scaleAnim, {
            toValue: isActive ? 0.82 : 1,
            useNativeDriver: true,
            damping: 12,
            stiffness: 180,
        }).start();
    }, [isActive]);

    const locale = getCurrentLanguage() || 'en';
    const d = new Date(app.lastUpdated);
    const formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

    const isInteractionDisabled = isPlaceholder || isLocked;
    const avatarColors = nameToColors(app.name);
    const recentMana = app.recentManaCost ?? app.totalManaCost ?? 0;
    const manaLevel = getManaLevel(recentMana);
    const manaColor = MANA_COLOR[manaLevel];
    const manaStr = recentMana.toLocaleString(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
    // Period: from spell creation (max 30 days)
    const msPerDay = 86_400_000;
    const ageDays = Math.floor((Date.now() - (app.createdAt || app.lastUpdated)) / msPerDay);
    const windowDays = Math.min(ageDays, 30) || 1;
    const periodLabel = windowDays < 30
        ? t('manaLastDays', { days: windowDays })
        : t('manaLast30Days');

    const hasNotifs = (notificationCount ?? 0) > 0;

    return (
        <View style={[styles.wrapper, !!coachStep && styles.cardCoaching]}>
            {/* ── Share float button (above card) ─────────────────────── */}
            <View
                style={[styles.shareFloatWrap, { top: isActive ? -12 : 0, opacity: isActive ? 1 : 0 }]}
                pointerEvents={isActive ? 'auto' : 'none'}
            >
                <TouchableOpacity
                    style={styles.shareFloatBtn}
                    onPress={() => { onDismissActive?.(); onShare?.(); }}
                    activeOpacity={0.8}
                >
                    <Text style={styles.shareFloatText}>📤 {t('shareSpell')}</Text>
                </TouchableOpacity>
                <View style={styles.shareFloatStem} />
            </View>

            {/* ── Arrow up (left side) ─────────────────────────────────── */}
            <View
                style={[styles.arrowLeft, {
                    opacity: isActive && canMoveUp ? 1 : 0,
                    transform: [{ translateX: isActive && canMoveUp ? 0 : -20 }],
                }]}
                pointerEvents={isActive && canMoveUp ? 'auto' : 'none'}
            >
                <TouchableOpacity
                    style={styles.arrowCircleUp}
                    onPress={onMoveUp}
                    activeOpacity={0.8}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Text style={styles.arrowText}>↑</Text>
                </TouchableOpacity>
            </View>

            {/* ── Arrow down (right side) ──────────────────────────────── */}
            <View
                style={[styles.arrowRight, {
                    opacity: isActive && canMoveDown ? 1 : 0,
                    transform: [{ translateX: isActive && canMoveDown ? 0 : 20 }],
                }]}
                pointerEvents={isActive && canMoveDown ? 'auto' : 'none'}
            >
                <TouchableOpacity
                    style={styles.arrowCircleDown}
                    onPress={onMoveDown}
                    activeOpacity={0.8}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Text style={styles.arrowText}>↓</Text>
                </TouchableOpacity>
            </View>

            <Animated.View
                style={[
                    styles.card,
                    isActive && styles.cardActive,
                    { transform: [{ scale: scaleAnim }] }
                ]}
            >
                <View style={{ flex: 1 }}>
                    {/* ── Card main row ───────────────────────────────────────── */}
                    <TouchableOpacity
                        style={styles.cardMain}
                        activeOpacity={0.9}
                        onLongPress={!isInteractionDisabled ? onLongPress : undefined}
                        onPress={() => {
                            if (isActive) { onDismissActive?.(); return; }
                            if (!isInteractionDisabled) onRun();
                        }}
                        delayLongPress={400}
                    >
                        {/* Avatar with optional notification badge */}
                        <View style={styles.avatarWrap}>
                            <View style={[styles.cardAvatar, { backgroundColor: avatarColors.bg }]}>
                                {isPlaceholder ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                ) : app.iconPath ? (
                                    <Image source={{ uri: app.iconPath }} style={styles.avatarImage} />
                                ) : (
                                    <Text style={[styles.avatarInitials, { color: avatarColors.fg }]} numberOfLines={1}>
                                        {app.name.slice(0, 2).toUpperCase()}
                                    </Text>
                                )}
                                {!!app.requiresBiometric && (
                                    <View style={styles.lockBadge}>
                                        <Text style={styles.lockBadgeIcon}>🔒</Text>
                                    </View>
                                )}
                            </View>
                            {hasNotifs && (
                                <View style={styles.notifBadge} accessibilityLabel={t('notifCountScheduled', { count: notificationCount })}>
                                    <Text style={styles.notifBadgeIcon}>🔔</Text>
                                    <Text style={styles.notifBadgeText}>{notificationCount}</Text>
                                </View>
                            )}
                        </View>

                        {/* Info */}
                        <View style={styles.cardInfo}>
                            <Text style={styles.cardTitle} numberOfLines={1}>{app.name}</Text>

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
                                    {!!app.shortDescription && (
                                        <Text style={styles.cardDesc} numberOfLines={2}>{app.shortDescription}</Text>
                                    )}
                                </>
                            )}
                        </View>

                        {/* Action buttons — always normal */}
                        {!isInteractionDisabled && (
                            <View style={styles.cardActions}>
                                <TouchableOpacity
                                    style={[styles.btnIcon, coachStep === 2 && styles.btnIconHighlight]}
                                    onPress={() => {
                                        if (isActive) { onDismissActive?.(); return; }
                                        onEdit();
                                    }}
                                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                    accessibilityLabel={t('editWithAI')}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.btnIconText}>✏️</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.btnIcon, coachStep === 1 && styles.btnIconHighlight]}
                                    onPress={() => {
                                        if (isActive) { onDismissActive?.(); return; }
                                        setShowSheet(true);
                                    }}
                                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                    accessibilityLabel={t('options')}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.btnIconDots}>⋯</Text>
                                </TouchableOpacity>

                            </View>
                        )}
                    </TouchableOpacity>

                    {/* ── Card footer ──────────────────────────────────────── */}
                    {!isInteractionDisabled && (
                        <TouchableOpacity
                            style={styles.cardFooter}
                            activeOpacity={1}
                            onPress={() => { if (isActive) onDismissActive?.(); }}
                        >
                            <View style={styles.usage}>
                                <View style={[styles.usageDot, { backgroundColor: manaColor }]} />
                                <Text style={styles.usageText}>⚡ {manaStr} {periodLabel}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.btnOpen}
                                onPress={() => {
                                    if (isActive) { onDismissActive?.(); return; }
                                    onRun();
                                }}
                                activeOpacity={0.8}
                                accessibilityLabel={`${t('openSpell')} ${app.name}`}
                                accessibilityRole="button"
                            >
                                <Text style={styles.btnOpenText}>{t('openSpell')} ✨</Text>
                            </TouchableOpacity>
                        </TouchableOpacity>
                    )}

                    {/* ── Active hint ──────────────────────────────────────── */}
                    {isActive && (
                        <TouchableOpacity
                            style={styles.activeHint}
                            onPress={onDismissActive}
                            activeOpacity={1}
                        >
                            <Text style={styles.activeHintText}>↑↓ {t('moveHint')} · {t('tapToClose')}</Text>
                        </TouchableOpacity>
                    )}

                    {/* ── Action Sheet (Bottom Sheet) ────────────────────────── */}
                    <Modal
                        visible={showSheet}
                        transparent
                        animationType="slide"
                        onRequestClose={() => setShowSheet(false)}
                    >
                        <Pressable style={styles.sheetOverlay} onPress={() => setShowSheet(false)}>
                            <Pressable style={styles.sheet}>
                                <View style={styles.sheetHandle} />

                                {/* Sheet header with avatar */}
                                <View style={styles.sheetHeader}>
                                    <View style={[styles.sheetAvatar, { backgroundColor: avatarColors.bg }]}>
                                        {app.iconPath ? (
                                            <Image source={{ uri: app.iconPath }} style={styles.sheetAvatarImage} />
                                        ) : (
                                            <Text style={[styles.sheetAvatarInitials, { color: avatarColors.fg }]}>
                                                {app.name.slice(0, 2).toUpperCase()}
                                            </Text>
                                        )}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.sheetName} numberOfLines={1}>{app.name}</Text>
                                        <Text style={styles.sheetSub}>v{app.currentVersion} • {formattedDate}</Text>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.sheetClose}
                                        onPress={() => setShowSheet(false)}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('cancel')}
                                    >
                                        <Text style={styles.sheetCloseText}>✕</Text>
                                    </TouchableOpacity>
                                </View>

                                {/* Sheet items */}
                                <View style={styles.sheetBody}>
                                    {/* ── Personalization ── */}

                                    {/* Edit spell details (name, desc) */}
                                    <TouchableOpacity
                                        style={styles.sheetItem}
                                        onPress={() => { setShowSheet(false); onRename(); }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('editAppDetails')}
                                    >
                                        <View style={styles.sheetItemIconWrap}>
                                            <Text style={styles.sheetItemIconEmoji}>📝</Text>
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.sheetItemTitle}>{t('editAppDetails')}</Text>
                                            <Text style={styles.sheetItemSub}>{t('editDetailsSub')}</Text>
                                        </View>
                                    </TouchableOpacity>

                                    {/* ── Access ── */}

                                    {/* Add to home screen */}
                                    {onShortcut && (
                                        <TouchableOpacity
                                            style={styles.sheetItem}
                                            onPress={() => { setShowSheet(false); onShortcut(); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('createShortcut')}
                                        >
                                            <View style={styles.sheetItemIconWrap}>
                                                <Text style={styles.sheetItemIconEmoji}>🏠</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>{t('createShortcut')}</Text>
                                                <Text style={styles.sheetItemSub}>{t('shortcutSubtitle')}</Text>
                                            </View>
                                        </TouchableOpacity>
                                    )}

                                    {/* Biometric toggle */}
                                    {onToggleBiometric && (
                                        <TouchableOpacity
                                            style={styles.sheetItem}
                                            onPress={() => { setShowSheet(false); onToggleBiometric(); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={app.requiresBiometric ? t('disableBiometric') : t('enableBiometric')}
                                        >
                                            <View style={styles.sheetItemIconWrap}>
                                                <Text style={styles.sheetItemIconEmoji}>{app.requiresBiometric ? '🔓' : '🔒'}</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>
                                                    {app.requiresBiometric ? t('disableBiometric') : t('enableBiometric')}
                                                </Text>
                                            </View>
                                        </TouchableOpacity>
                                    )}

                                    {/* ── Extras ── */}

                                    {/* Scheduled notifications */}
                                    {onViewSchedules && (
                                        <TouchableOpacity
                                            style={styles.sheetItem}
                                            onPress={() => { setShowSheet(false); onViewSchedules(); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('scheduledNotifications')}
                                        >
                                            <View style={styles.sheetItemIconWrap}>
                                                <Text style={styles.sheetItemIconEmoji}>🔔</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>{t('scheduledNotifications')}</Text>
                                                {hasNotifs && (
                                                    <Text style={styles.sheetItemSub}>
                                                        {t('notifCountScheduled', { count: notificationCount })}
                                                    </Text>
                                                )}
                                            </View>
                                        </TouchableOpacity>
                                    )}

                                    {/* Share */}
                                    {onShare && (
                                        <TouchableOpacity
                                            style={styles.sheetItem}
                                            onPress={() => { setShowSheet(false); onShare(); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('shareSpell')}
                                        >
                                            <View style={styles.sheetItemIconWrap}>
                                                <Text style={styles.sheetItemIconEmoji}>📤</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>{t('shareSpell')}</Text>
                                            </View>
                                        </TouchableOpacity>
                                    )}

                                    {/* Clear Data */}
                                    {onClearData && (
                                        <TouchableOpacity
                                            style={styles.sheetItem}
                                            onPress={() => { setShowSheet(false); onClearData(); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('clearDataTitle')}
                                        >
                                            <View style={styles.sheetItemIconWrap}>
                                                <Text style={styles.sheetItemIconEmoji}>🧹</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.sheetItemTitle}>{t('clearDataTitle')}</Text>
                                                <Text style={styles.sheetItemSub}>{t('clearDataDesc')}</Text>
                                            </View>
                                        </TouchableOpacity>
                                    )}

                                    {/* Delete */}
                                    <TouchableOpacity
                                        style={[styles.sheetItem, styles.sheetItemDanger]}
                                        onPress={() => { setShowSheet(false); onDelete(); }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('delete')}
                                    >
                                        <View style={[styles.sheetItemIconWrap, styles.sheetItemIconDanger]}>
                                            <Text style={styles.sheetItemIconEmoji}>🗑️</Text>
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.sheetItemTitle, { color: '#f87171' }]}>{t('delete')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                </View>
                            </Pressable>
                        </Pressable>
                    </Modal>
                </View>
            </Animated.View>

            {/* Coach mark tooltip — rendered outside the card to avoid overflow:hidden clipping */}
            {!!coachStep && (
                <View style={[styles.coachBubble, coachStep === 3 && styles.coachBubbleCard]}>
                    <View style={[styles.coachArrow, coachStep === 3 && styles.coachArrowCard]} />
                    <Text style={styles.coachStep}>
                        {coachStep === 1 ? `1 ${t('coachOf')} 3`
                            : coachStep === 2 ? `2 ${t('coachOf')} 3`
                                : `3 ${t('coachOf')} 3`}
                    </Text>
                    <Text style={styles.coachText}>
                        {coachStep === 1 ? t('coachMenuHint')
                            : coachStep === 2 ? t('coachEditHint')
                                : t('coachLongPressHint')}
                    </Text>
                    <TouchableOpacity
                        style={styles.coachDismissBtn}
                        onPress={onCoachDismiss}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={coachStep < 3 ? t('coachNext') : t('coachGotIt')}
                    >
                        <Text style={styles.coachDismissText}>
                            {coachStep < 3 ? t('coachNext') : t('coachGotIt')}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    wrapper: {
        marginBottom: 12,
        position: 'relative',
        zIndex: 1,
    },
    card: {
        backgroundColor: '#111827',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#1F2937',
        overflow: 'hidden',
    },
    cardCoaching: {
        zIndex: 10,
        elevation: 10,
    },
    cardActive: {
        borderColor: 'rgba(168,85,247,0.4)',
        shadowColor: '#a855f7',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.3,
        shadowRadius: 20,
        elevation: 10,
    },
    shareFloatWrap: {
        position: 'absolute', alignSelf: 'center', alignItems: 'center',
        left: 0, right: 0, zIndex: 20,
    },
    shareFloatBtn: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: '#1e1030', borderWidth: 1, borderColor: 'rgba(168,85,247,0.33)',
        borderRadius: 20, paddingVertical: 7, paddingHorizontal: 16,
        shadowColor: '#a855f7', shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.27, shadowRadius: 12, elevation: 8,
        alignSelf: 'center',
    },
    shareFloatText: { color: '#c084fc', fontSize: 13, fontWeight: '700' },
    shareFloatStem: {
        width: 2, height: 8, backgroundColor: 'rgba(168,85,247,0.27)',
        alignSelf: 'center', borderRadius: 1,
    },
    arrowLeft: { position: 'absolute', left: 4, top: '50%', marginTop: -19, zIndex: 10 },
    arrowRight: { position: 'absolute', right: 4, top: '50%', marginTop: -19, zIndex: 10 },
    arrowCircleUp: {
        width: 38, height: 38, borderRadius: 19, backgroundColor: '#7c3aed',
        justifyContent: 'center', alignItems: 'center',
        shadowColor: '#a855f7', shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5, shadowRadius: 10, elevation: 8,
    },
    arrowCircleDown: {
        width: 38, height: 38, borderRadius: 19, backgroundColor: '#4f46e5',
        justifyContent: 'center', alignItems: 'center',
        shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5, shadowRadius: 10, elevation: 8,
    },
    arrowText: { color: '#fff', fontSize: 18, fontWeight: '700' },
    activeHint: {
        paddingHorizontal: 16, paddingBottom: 10,
        alignItems: 'center',
        borderTopWidth: 1, borderTopColor: 'rgba(168,85,247,0.13)',
        marginTop: 4, paddingTop: 8,
    },
    activeHintText: { color: 'rgba(168,85,247,0.53)', fontSize: 11 },
    cardMain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        padding: 16,
        paddingBottom: 10,
        zIndex: 2,
        elevation: 0.1,
    },
    avatarWrap: {
        position: 'relative',
        flexShrink: 0,
    },
    cardAvatar: {
        width: 56,
        height: 56,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
    },
    avatarImage: {
        width: 56,
        height: 56,
    },
    avatarInitials: {
        fontSize: 20,
        fontWeight: '900',
    },
    lockBadge: {
        position: 'absolute',
        bottom: 1,
        right: 1,
    },
    lockBadgeIcon: {
        fontSize: 10,
    },
    notifBadge: {
        position: 'absolute',
        top: -6,
        right: -8,
        backgroundColor: '#7C3AED',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        height: 20,
        borderRadius: 99,
        paddingHorizontal: 6,
        borderWidth: 2,
        borderColor: '#111827',
    },
    notifBadgeIcon: {
        fontSize: 10,
    },
    notifBadgeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '900',
    },
    cardInfo: {
        flex: 1,
        minWidth: 0,
    },
    cardTitle: {
        color: '#F9FAFB',
        fontSize: 16,
        fontWeight: '800',
    },
    cardMeta: {
        color: '#6B7280',
        fontSize: 13,
        fontWeight: '600',
        marginTop: 2,
    },
    cardDesc: {
        color: '#6B7280',
        fontSize: 13,
        lineHeight: 19,
        marginTop: 3,
    },
    cardActions: {
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
    },
    btnIcon: {
        width: 38,
        height: 38,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: '#1F2937',
        backgroundColor: '#1a2030',
        justifyContent: 'center',
        alignItems: 'center',
    },
    btnIconText: {
        fontSize: 16,
    },
    btnIconDots: {
        fontSize: 20,
        color: '#9CA3AF',
        fontWeight: '700',
        lineHeight: 22,
    },
    btnIconHighlight: {
        borderColor: '#7C3AED',
        backgroundColor: 'rgba(124,58,237,0.15)',
    },
    btnIconDisabled: {
        opacity: 0.4,
    },
    coachBubble: {
        position: 'absolute',
        // Positioned relative to wrapper (outside the card's overflow:hidden boundary).
        // top:100 ≈ card paddingTop(16) + cardActions offset(84) from original placement.
        top: 100,
        right: 12,
        backgroundColor: '#7C3AED',
        borderRadius: 14,
        padding: 12,
        paddingTop: 10,
        minWidth: 210,
        zIndex: 20,
        shadowColor: '#7C3AED',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 24,
        elevation: 20,
    },
    coachArrow: {
        position: 'absolute',
        top: -6,
        right: 12,
        width: 12,
        height: 12,
        backgroundColor: '#7C3AED',
        borderRadius: 2,
        transform: [{ rotate: '45deg' }],
    },
    // Step 3 (long-press hint): bubble shifts left so the arrow points at the card body
    coachBubbleCard: {
        right: undefined,
        left: 16,
    },
    coachArrowCard: {
        right: undefined,
        left: 20,
    },
    coachStep: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 11,
        fontWeight: '700',
        marginBottom: 4,
    },
    coachText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '700',
        lineHeight: 20,
    },
    coachDismissBtn: {
        marginTop: 10,
        backgroundColor: 'rgba(255,255,255,0.2)',
        borderRadius: 99,
        paddingVertical: 6,
        paddingHorizontal: 12,
        alignItems: 'center',
    },
    coachDismissText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '800',
    },
    cardFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 14,
        zIndex: 1,
    },
    usage: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    usageDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    usageText: {
        fontSize: 13,
        fontWeight: '700',
        color: '#6B7280',
    },
    btnOpen: {
        backgroundColor: '#7C3AED',
        borderRadius: 12,
        paddingVertical: 9,
        paddingHorizontal: 18,
    },
    btnOpenText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '800',
    },
    sheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.55)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: '#111827',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        paddingBottom: Platform.OS === 'ios' ? 44 : 32,
    },
    sheetHandle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: 12,
        marginBottom: 20,
    },
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#1F2937',
    },
    sheetAvatar: {
        width: 40,
        height: 40,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
    },
    sheetAvatarImage: {
        width: 40,
        height: 40,
    },
    sheetAvatarInitials: {
        fontSize: 16,
        fontWeight: '900',
    },
    sheetName: {
        color: '#F9FAFB',
        fontSize: 15,
        fontWeight: '800',
    },
    sheetSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 1,
    },
    sheetClose: {
        marginLeft: 'auto',
        width: 32,
        height: 32,
        borderRadius: 99,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sheetCloseText: {
        color: '#9CA3AF',
        fontSize: 16,
    },
    sheetBody: {
        paddingHorizontal: 20,
        paddingTop: 16,
        gap: 8,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        backgroundColor: '#0D0D1A',
        borderWidth: 1,
        borderColor: '#1F2937',
        borderRadius: 14,
    },
    sheetItemDanger: {
        borderColor: 'rgba(248,113,113,0.13)',
    },
    sheetItemIconWrap: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    sheetItemIconDanger: {
        backgroundColor: '#2a1a1a',
    },
    sheetItemIconEmoji: {
        fontSize: 20,
    },
    sheetItemTitle: {
        color: '#F9FAFB',
        fontSize: 14,
        fontWeight: '800',
    },
    sheetItemSub: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '600',
        marginTop: 2,
    },
});
