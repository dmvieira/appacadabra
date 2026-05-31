import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Modal,
    Pressable,
    Alert,
    Share,
    Linking,
    ScrollView,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import type { GeneratedApp } from '../lib/database/types';
import { useStoreSyncStore } from '../lib/storeSync';
import type { PublishOutcome } from '../lib/storeSync';
import { useManaStore } from '../lib/manaStore';
import { linkWithGoogle } from '../lib/firebase';

interface Props {
    app: GeneratedApp | null;
    visible: boolean;
    onClose: () => void;
}

type SheetView = 'form' | 'publishing' | 'success' | 'already-shared';

const COLOR_PAIRS: [string, string][] = [
    ['#1a3a2a', '#4ade80'],
    ['#1a1a3a', '#818cf8'],
    ['#2a1a1a', '#f87171'],
    ['#1a2a3a', '#60a5fa'],
    ['#2a1a2a', '#c084fc'],
    ['#2a2a1a', '#facc15'],
    ['#1a2a2a', '#2dd4bf'],
    ['#2a1a22', '#fb7185'],
    ['#1a1a22', '#a78bfa'],
    ['#22261a', '#a3e635'],
];

function nameToColors(name: string): { bg: string; fg: string } {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const pair = COLOR_PAIRS[Math.abs(hash) % COLOR_PAIRS.length];
    return { bg: pair[0], fg: pair[1] };
}

export function SendSpellSheet({ app, visible, onClose }: Props) {
    const [view, setView] = useState<SheetView>('form');
    const [mode, setMode] = useState<'unlisted' | 'public'>('unlisted');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

    const lastError = useStoreSyncStore(s => s.lastError);
    const clearError = useStoreSyncStore(s => s.clearError);
    const isAnonymous = useManaStore(s => s.isAnonymous);

    useEffect(() => {
        if (!visible || !app) return;
        clearError();
        setOutcome(null);
        if (app.storeSpellId) {
            setView('already-shared');
        } else {
            setView('form');
            setMode('unlisted');
            setName(app.name);
            setDescription(app.shortDescription ?? '');
        }
    }, [app?.id, visible]);

    const handleClose = () => {
        clearError();
        onClose();
    };

    const handleSend = async () => {
        if (!app) return;
        if (mode === 'public' && !name.trim()) {
            Alert.alert(t('error'), t('publishSpellNameRequired'));
            return;
        }
        setView('publishing');
        try {
            const result = await useStoreSyncStore.getState().publishSpell({
                appId: app.id,
                name: mode === 'unlisted' ? app.name : name.trim(),
                description: mode === 'unlisted'
                    ? (app.shortDescription ?? '')
                    : description.trim(),
                visibility: mode,
            });
            setOutcome(result);
            setView('success');
        } catch {
            setView('form');
        }
    };

    const handleUnpublish = () => {
        if (!app?.storeSpellId) return;
        Alert.alert(
            t('unpublishSpell'),
            t('unpublishConsequence'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('unpublishSpell'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await useStoreSyncStore.getState().unpublishSpell(app.id, app.storeSpellId!);
                            handleClose();
                        } catch (e: any) {
                            Alert.alert(t('error'), e?.message || 'Failed to unpublish');
                        }
                    },
                },
            ]
        );
    };

    if (!app) return null;

    const { bg: avatarBg, fg: avatarFg } = nameToColors(app.name);
    const initials = app.name.slice(0, 2).toUpperCase();
    const storeUrl = app.storeSpellId
        ? `https://appacadabra.ai/store/${app.storeSpellId}${app.storeSpellSlug ? `/${app.storeSpellSlug}` : ''}`
        : '';
    const successUrl = outcome?.storeUrl ?? '';

    const Header = ({ dimmed = false }: { dimmed?: boolean }) => (
        <View style={[styles.header, dimmed && { opacity: 0.35 }]}>
            <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
                <Text style={[styles.avatarText, { color: avatarFg }]}>{initials}</Text>
            </View>
            <View style={styles.headerInfo}>
                <Text style={styles.headerName} numberOfLines={1}>{app.name}</Text>
                <Text style={styles.headerSub}>v{app.currentVersion}</Text>
            </View>
            {!dimmed && (
                <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
                    <Text style={styles.closeBtnText}>✕</Text>
                </TouchableOpacity>
            )}
        </View>
    );

    // ── already-shared ────────────────────────────────────────────────────────
    if (view === 'already-shared') {
        return (
            <Modal transparent visible={visible} onRequestClose={handleClose} animationType="fade">
                <Pressable style={styles.overlay} onPress={handleClose}>
                    <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
                        <SafeAreaView edges={['bottom']}>
                            <View style={styles.handle} />
                            <Header />
                            <View style={styles.urlBox}>
                                <Text style={styles.urlText} selectable>{storeUrl}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.btnPrimary}
                                onPress={() => Share.share({ message: storeUrl, url: storeUrl })}
                            >
                                <Text style={styles.btnPrimaryText}>{t('shareSpell')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.btnSecondary, { marginTop: spacing.sm }]}
                                onPress={() => Linking.openURL(storeUrl).catch(() => {})}
                            >
                                <Text style={styles.btnSecondaryText}>{t('openInBrowser')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.btnGhost} onPress={handleClose}>
                                <Text style={styles.btnGhostText}>{t('close')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.btnDangerText} onPress={handleUnpublish}>
                                <Text style={styles.btnDangerLabel}>{t('unpublishSpell')}</Text>
                            </TouchableOpacity>
                        </SafeAreaView>
                    </Pressable>
                </Pressable>
            </Modal>
        );
    }

    // ── success ───────────────────────────────────────────────────────────────
    if (view === 'success') {
        return (
            <Modal transparent visible={visible} onRequestClose={handleClose} animationType="fade">
                <Pressable style={styles.overlay} onPress={handleClose}>
                    <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
                        <SafeAreaView edges={['bottom']}>
                            <View style={styles.handle} />
                            <View style={styles.successCenter}>
                                <Text style={styles.successEmoji}>✨</Text>
                                <Text style={styles.successTitle}>{t('publishSuccessTitle')}</Text>
                                <Text style={styles.successSub}>{t('publishSuccessSubtitle')}</Text>
                            </View>
                            <View style={styles.urlBox}>
                                <Text style={styles.urlText} selectable>{successUrl}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.btnPrimary}
                                onPress={() => Share.share({ message: successUrl, url: successUrl })}
                            >
                                <Text style={styles.btnPrimaryText}>{t('shareSpell')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.btnGhost, { marginTop: spacing.sm }]} onPress={handleClose}>
                                <Text style={styles.btnGhostText}>{t('done')}</Text>
                            </TouchableOpacity>
                        </SafeAreaView>
                    </Pressable>
                </Pressable>
            </Modal>
        );
    }

    // ── publishing ────────────────────────────────────────────────────────────
    if (view === 'publishing') {
        return (
            <Modal transparent visible={visible} onRequestClose={() => {}} animationType="fade">
                <View style={styles.overlay}>
                    <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
                        <SafeAreaView edges={['bottom']}>
                            <View style={styles.handle} />
                            <Header dimmed />
                            <View style={styles.modeRow}>
                                <View style={[styles.modePill, mode === 'unlisted' && styles.modePillActive, { opacity: 0.35 }]}>
                                    <Text style={styles.modePillText}>{t('privateLinkMode')}</Text>
                                </View>
                                <View style={[styles.modePill, mode === 'public' && styles.modePillActive, { opacity: 0.35 }]}>
                                    <Text style={styles.modePillText}>{t('publicListingMode')}</Text>
                                </View>
                            </View>
                            <View style={styles.publishingCenter}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.publishingText}>{t('publishingSpellMessage')}</Text>
                            </View>
                            <TouchableOpacity style={[styles.btnPrimary, styles.btnDisabled]} disabled>
                                <ActivityIndicator size="small" color="#fff" />
                            </TouchableOpacity>
                        </SafeAreaView>
                    </Pressable>
                </View>
            </Modal>
        );
    }

    // ── form ──────────────────────────────────────────────────────────────────
    return (
        <Modal transparent visible={visible} onRequestClose={handleClose} animationType="fade">
            <Pressable style={styles.overlay} onPress={handleClose}>
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={{ width: '100%' }}
                >
                <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
                    <SafeAreaView edges={['bottom']}>
                        <ScrollView keyboardShouldPersistTaps="handled">
                            <View style={styles.handle} />
                            <Header />

                            <View style={styles.modeRow}>
                                <TouchableOpacity
                                    style={[styles.modePill, mode === 'unlisted' && styles.modePillActive]}
                                    onPress={() => setMode('unlisted')}
                                >
                                    <Text style={[styles.modePillText, mode === 'unlisted' && styles.modePillTextActive]}>
                                        {t('privateLinkMode')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.modePill, mode === 'public' && styles.modePillActive]}
                                    onPress={() => setMode('public')}
                                >
                                    <Text style={[styles.modePillText, mode === 'public' && styles.modePillTextActive]}>
                                        {t('publicListingMode')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.modeDesc}>
                                {mode === 'unlisted' ? t('visibilityUnlistedSub') : t('visibilityPublicSub')}
                            </Text>

                            {mode === 'public' && (
                                <View style={styles.fields}>
                                    <Text style={styles.fieldLabel}>{t('spellName')}</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={name}
                                        onChangeText={setName}
                                        placeholder={app.name}
                                        placeholderTextColor={colors.onSurfaceVariant}
                                        maxLength={80}
                                    />
                                    <Text style={styles.fieldLabel}>{t('description')}</Text>
                                    <TextInput
                                        style={[styles.input, styles.inputMultiline]}
                                        value={description}
                                        onChangeText={setDescription}
                                        placeholder={t('descriptionPlaceholder')}
                                        placeholderTextColor={colors.onSurfaceVariant}
                                        multiline
                                        maxLength={500}
                                    />
                                </View>
                            )}

                            {!!app.forkOfStoreSpellId && (
                                <View style={styles.infoBox}>
                                    <Text style={styles.infoText}>🌿 {t('publishingAsVariant')}</Text>
                                </View>
                            )}

                            {isAnonymous && (
                                <View style={styles.warningBox}>
                                    <Text style={styles.warningText}>{t('publishAnonymousWarning')}</Text>
                                    <TouchableOpacity
                                        style={styles.btnSecondarySmall}
                                        onPress={async () => { try { await linkWithGoogle(); } catch {} }}
                                    >
                                        <Text style={styles.btnSecondaryText}>{t('signInWithGoogle')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}

                            {!!lastError && (
                                <View style={styles.errorBox}>
                                    <Text style={styles.errorText}>{lastError}</Text>
                                </View>
                            )}
                        </ScrollView>

                        <View style={styles.actions}>
                            <TouchableOpacity style={styles.btnGhost} onPress={handleClose}>
                                <Text style={styles.btnGhostText}>{t('cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.btnPrimary, isAnonymous && styles.btnDisabled, { flex: 2 }]}
                                onPress={handleSend}
                                disabled={isAnonymous}
                            >
                                <Text style={styles.btnPrimaryText} numberOfLines={1} adjustsFontSizeToFit>
                                    {mode === 'unlisted' ? t('createLinkAndShare') : t('publishAndShare')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </SafeAreaView>
                </Pressable>
                </KeyboardAvoidingView>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.55)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.background,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.md,
        maxHeight: '85%',
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: spacing.sm,
        marginBottom: spacing.lg,
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingBottom: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
        marginBottom: spacing.md,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    avatarText: {
        fontSize: 18,
        fontWeight: '900',
    },
    headerInfo: {
        flex: 1,
        minWidth: 0,
    },
    headerName: {
        fontSize: 16,
        fontWeight: '800',
        color: colors.onBackground,
    },
    headerSub: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginTop: 2,
    },
    closeBtn: {
        width: 32,
        height: 32,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeBtnText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },

    // Mode selector
    modeRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    modePill: {
        flex: 1,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: borderRadius.md,
        backgroundColor: colors.surface,
        borderWidth: 1.5,
        borderColor: colors.surfaceVariant,
        alignItems: 'center',
    },
    modePillActive: {
        borderColor: colors.primary,
        backgroundColor: 'rgba(123,46,255,0.12)',
    },
    modePillText: {
        fontSize: 13,
        fontWeight: '700',
        color: colors.onBackground,
    },
    modePillTextActive: {
        color: '#c4b5fd',
    },
    modeDesc: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginBottom: spacing.md,
        lineHeight: 17,
    },

    // Fields
    fields: {
        gap: spacing.sm,
        marginBottom: spacing.md,
    },
    fieldLabel: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 4,
    },
    input: {
        backgroundColor: colors.surface,
        color: colors.onBackground,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        fontSize: 16,
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
    },
    inputMultiline: {
        minHeight: 80,
        textAlignVertical: 'top',
    },

    // Banners
    infoBox: {
        backgroundColor: '#1a2e1a',
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
        borderLeftWidth: 3,
        borderLeftColor: '#4ade80',
    },
    infoText: {
        fontSize: 13,
        color: '#86efac',
    },
    warningBox: {
        backgroundColor: '#3a2a1a',
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
        borderLeftWidth: 3,
        borderLeftColor: '#f59e0b',
        gap: spacing.sm,
    },
    warningText: {
        fontSize: 13,
        color: '#fbbf24',
        lineHeight: 18,
    },
    errorBox: {
        backgroundColor: '#3a1a1a',
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginTop: spacing.sm,
        borderLeftWidth: 3,
        borderLeftColor: colors.error,
    },
    errorText: {
        fontSize: 13,
        color: '#fca5a5',
    },

    // URL box
    urlBox: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: colors.primary,
    },
    urlText: {
        fontFamily: 'monospace',
        fontSize: 13,
        color: colors.primary,
    },

    // Buttons
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md,
    },
    btnPrimary: {
        backgroundColor: colors.primary,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 48,
    },
    btnPrimaryText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '700',
    },
    btnSecondary: {
        backgroundColor: colors.surfaceVariant,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 48,
    },
    btnSecondarySmall: {
        backgroundColor: colors.surfaceVariant,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: borderRadius.sm,
        alignItems: 'center',
        alignSelf: 'flex-start',
    },
    btnSecondaryText: {
        color: colors.onBackground,
        fontSize: 14,
        fontWeight: '600',
    },
    btnGhost: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 48,
    },
    btnGhostText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        fontWeight: '600',
    },
    btnDisabled: {
        opacity: 0.5,
    },
    btnDangerText: {
        paddingVertical: spacing.sm,
        alignItems: 'center',
    },
    btnDangerLabel: {
        color: '#f87171',
        fontSize: 13,
        fontWeight: '600',
    },

    // Success view
    successCenter: {
        alignItems: 'center',
        paddingVertical: spacing.md,
        marginBottom: spacing.sm,
    },
    successEmoji: {
        fontSize: 36,
        marginBottom: spacing.sm,
    },
    successTitle: {
        fontSize: 20,
        fontWeight: '800',
        color: colors.onBackground,
        textAlign: 'center',
    },
    successSub: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        marginTop: spacing.xs,
        lineHeight: 18,
    },

    // Publishing view
    publishingCenter: {
        alignItems: 'center',
        paddingVertical: spacing.lg,
        gap: spacing.md,
    },
    publishingText: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        fontWeight: '600',
        textAlign: 'center',
    },
});
