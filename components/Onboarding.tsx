/**
 * BYOK onboarding — 3 screens.
 *
 * Screen 0: welcome + Sign in with Google (skips the rest of onboarding) or
 * Continue without signing in. After successful sign-in, the BackupSyncModal
 * auto-pops on the home screen via the `app/index.tsx:230` useEffect.
 *
 * Screen 1: discovery grid of the top 6 spells from the public store. Tapping
 * one learns it (live `syncLearnedSpells({ forceSpellId })`). Skeleton while
 * Firestore loads; gracefully degrades to a "Skip for now" with no cards if
 * the read fails.
 *
 * Screen 2: pitch for OpenRouter BYOK with three benefits and a CTA into
 * `/settings/openrouter`. A ghost "Do this later" closes the onboarding.
 *
 * Caller contract preserved: `onComplete(null)` fires when the user closes
 * the flow. The chip-based template import path is gone — the caller's
 * `handleOnboardingComplete` already treats `null` as a no-op.
 */

import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Modal,
    ActivityIndicator,
    ScrollView,
    Image,
    Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { logObScreenView, logObCompleted, logObSkipped } from '../lib/analytics';
import * as firebase from '../lib/firebase';
import { learnStoreSpell } from '../lib/storeLearn';

const TOTAL_SCREENS = 3;

interface OnboardingProps {
    visible: boolean;
    onComplete: (selectedChip: number | null) => void;
}

export function Onboarding({ visible, onComplete }: OnboardingProps) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const [screen, setScreen] = useState(0);
    const [spells, setSpells] = useState<firebase.TopStoreSpell[]>([]);
    const [loading, setLoading] = useState(true);
    const [learningIds, setLearningIds] = useState<Set<string>>(new Set());
    const [learnedIds, setLearnedIds] = useState<Set<string>>(new Set());
    const [signingIn, setSigningIn] = useState(false);

    useEffect(() => {
        if (!visible) {
            setScreen(0);
            setLearningIds(new Set());
            setLearnedIds(new Set());
            setSigningIn(false);
        }
    }, [visible]);

    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        setLoading(true);
        firebase.listTopStoreSpells(6)
            .then(items => { if (!cancelled) setSpells(items); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [visible]);

    useEffect(() => {
        if (visible) logObScreenView(screen);
    }, [screen, visible]);

    // If the discover load returns empty (no public spells, offline, query
    // misconfig), silently skip screen 1 instead of confronting a first-time
    // user with an error state.
    useEffect(() => {
        if (visible && screen === 1 && !loading && spells.length === 0) {
            setScreen(2);
        }
    }, [visible, screen, loading, spells.length]);

    const handleLearn = async (spellId: string) => {
        if (learningIds.has(spellId) || learnedIds.has(spellId)) return;
        const next = new Set(learningIds);
        next.add(spellId);
        setLearningIds(next);
        try {
            await learnStoreSpell(spellId);
            setLearnedIds(prev => {
                const updated = new Set(prev);
                updated.add(spellId);
                return updated;
            });
        } catch (_) {
            // Surface no error: the spell card stays tappable so the user can retry.
        } finally {
            setLearningIds(prev => {
                const updated = new Set(prev);
                updated.delete(spellId);
                return updated;
            });
        }
    };

    const handleSignIn = async () => {
        if (signingIn) return;
        setSigningIn(true);
        try {
            await firebase.linkWithGoogle();
            logObCompleted('signed_in');
            onComplete(null);
        } catch (error: any) {
            const msg = String(error?.message ?? error ?? '');
            if (msg.includes('cancelled') || msg.includes('Cancelled')) {
                // User dismissed the picker — stay on welcome screen silently.
                return;
            }
            Alert.alert(t('signInFailed'), msg);
        } finally {
            setSigningIn(false);
        }
    };

    const goNext = () => {
        if (screen < TOTAL_SCREENS - 1) setScreen(screen + 1);
        else {
            logObCompleted('byok');
            onComplete(null);
        }
    };

    const skip = () => {
        logObSkipped(screen);
        onComplete(null);
    };

    const goToSettings = async () => {
        logObCompleted('byok_setup');
        onComplete(null);
        router.push('/settings/openrouter');
    };

    if (!visible) return null;

    const progressWidth = `${((screen + 1) / TOTAL_SCREENS) * 100}%`;

    return (
        <Modal visible transparent animationType="fade" statusBarTranslucent>
            <View style={[s.overlay, { paddingTop: Math.max(insets.top, 20) }]}>
                <View style={s.progressBar}>
                    <View style={[s.progressFill, { width: progressWidth as any }]} />
                </View>

                {screen === 0 && (
                    <View style={s.screen}>
                        <View style={s.welcomeHero}>
                            <Image source={require('../assets/icon.png')} style={s.welcomeLogo} />
                        </View>
                        <Text style={s.headline}>{t('obWelcomeTitle')}</Text>
                        <Text style={s.sub}>{t('obWelcomeSub')}</Text>
                    </View>
                )}

                {screen === 1 && (
                    <View style={s.screen}>
                        <Text style={s.headline}>{t('obDiscoverTitle')}</Text>
                        <Text style={s.sub}>{t('obDiscoverSub')}</Text>

                        {loading || spells.length === 0 ? (
                            // Empty case auto-skips to screen 2 via the effect above —
                            // the spinner shows briefly during the transition.
                            <View style={s.loadingArea}>
                                <ActivityIndicator color={colors.primary} />
                            </View>
                        ) : (
                            <ScrollView contentContainerStyle={s.grid}>
                                {spells.map(spell => {
                                    const isLearning = learningIds.has(spell.spellId);
                                    const isLearned = learnedIds.has(spell.spellId);
                                    return (
                                        <TouchableOpacity
                                            key={spell.spellId}
                                            style={[s.card, isLearned && s.cardLearned]}
                                            onPress={() => handleLearn(spell.spellId)}
                                            activeOpacity={0.85}
                                            disabled={isLearning || isLearned}
                                            accessibilityRole="button"
                                        >
                                            {spell.iconUrl ? (
                                                <Image source={{ uri: spell.iconUrl }} style={s.cardIcon} />
                                            ) : (
                                                <View style={[s.cardIcon, s.cardIconFallback]}>
                                                    <Text style={s.cardIconFallbackText}>✦</Text>
                                                </View>
                                            )}
                                            <Text style={s.cardName} numberOfLines={2}>{spell.name}</Text>
                                            {spell.description ? (
                                                <Text style={s.cardDesc} numberOfLines={3}>{spell.description}</Text>
                                            ) : null}
                                            <Text style={s.cardCta}>
                                                {isLearned
                                                    ? t('obDiscoverLearned')
                                                    : isLearning
                                                        ? t('obDiscoverLearning')
                                                        : t('obDiscoverLearn')}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        )}
                    </View>
                )}

                {screen === 2 && (
                    <View style={s.screen}>
                        <Text style={s.bigEmoji}>🔑</Text>
                        <Text style={s.headline}>{t('obKeyTitle')}</Text>
                        <Text style={s.sub}>{t('obKeySub')}</Text>

                        <View style={s.benefits}>
                            <Benefit icon="✨" text={t('obKeyBenefit1')} />
                            <Benefit icon="💸" text={t('obKeyBenefit2')} />
                            <Benefit icon="🔐" text={t('obKeyBenefit3')} />
                        </View>
                    </View>
                )}

                <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]}>
                    {screen === 0 ? (
                        firebase.isGoogleUser() ? (
                            <TouchableOpacity style={s.primaryBtn} onPress={goNext}>
                                <Text style={s.primaryText}>{t('obContinue')}</Text>
                            </TouchableOpacity>
                        ) : (
                            <>
                                <TouchableOpacity
                                    style={[s.primaryBtn, signingIn && s.primaryBtnDisabled]}
                                    onPress={handleSignIn}
                                    disabled={signingIn}
                                >
                                    {signingIn ? (
                                        <ActivityIndicator color="#fff" />
                                    ) : (
                                        <Text style={s.primaryText}>{t('signInGoogle')}</Text>
                                    )}
                                </TouchableOpacity>
                                <TouchableOpacity style={s.ghostBtn} onPress={goNext} disabled={signingIn}>
                                    <Text style={s.ghostText}>{t('obWelcomeContinue')}</Text>
                                </TouchableOpacity>
                            </>
                        )
                    ) : screen === TOTAL_SCREENS - 1 ? (
                        <>
                            <TouchableOpacity style={s.primaryBtn} onPress={goToSettings}>
                                <Text style={s.primaryText}>{t('obKeySetupCta')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.ghostBtn} onPress={skip}>
                                <Text style={s.ghostText}>{t('obKeyLaterCta')}</Text>
                            </TouchableOpacity>
                        </>
                    ) : (
                        <>
                            <TouchableOpacity style={s.primaryBtn} onPress={goNext}>
                                <Text style={s.primaryText}>{t('obContinue')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.ghostBtn} onPress={skip}>
                                <Text style={s.ghostText}>{t('obSkip')}</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>
            </View>
        </Modal>
    );
}

function Benefit({ icon, text }: { icon: string; text: string }) {
    return (
        <View style={s.benefitRow}>
            <Text style={s.benefitIcon}>{icon}</Text>
            <Text style={s.benefitText}>{text}</Text>
        </View>
    );
}

const s = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: colors.background,
    },
    progressBar: {
        height: 3,
        backgroundColor: colors.surfaceVariant,
    },
    progressFill: {
        height: '100%',
        backgroundColor: colors.primary,
    },
    screen: {
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 24,
    },
    bigEmoji: {
        fontSize: 64,
        textAlign: 'center',
        marginBottom: spacing.sm,
    },
    welcomeHero: {
        alignItems: 'center',
        marginTop: spacing.xl,
        marginBottom: spacing.lg,
    },
    welcomeLogo: {
        width: 120,
        height: 120,
    },
    headline: {
        fontSize: 26,
        fontWeight: '800',
        color: colors.onSurface,
        marginBottom: spacing.sm,
    },
    sub: {
        fontSize: 15,
        color: colors.onSurfaceVariant,
        lineHeight: 22,
        marginBottom: spacing.lg,
    },
    loadingArea: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        paddingBottom: 24,
    },
    card: {
        width: '48%',
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: 'rgba(124,58,237,0.18)',
        borderRadius: borderRadius.md,
        padding: 14,
        alignItems: 'center',
        gap: 8,
    },
    cardLearned: {
        borderColor: colors.primary,
        backgroundColor: colors.primaryContainer,
    },
    cardIcon: {
        width: 48,
        height: 48,
        borderRadius: 12,
    },
    cardIconFallback: {
        backgroundColor: colors.surfaceVariant,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardIconFallbackText: {
        fontSize: 24,
        color: colors.primary,
    },
    cardName: {
        fontSize: 13,
        fontWeight: '700',
        color: colors.onSurface,
        textAlign: 'center',
    },
    cardDesc: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        lineHeight: 15,
    },
    cardCta: {
        fontSize: 11,
        fontWeight: '600',
        color: colors.primary,
    },
    benefits: {
        gap: 16,
        marginTop: spacing.md,
    },
    benefitRow: {
        flexDirection: 'row',
        gap: 14,
        alignItems: 'center',
    },
    benefitIcon: {
        fontSize: 28,
    },
    benefitText: {
        flex: 1,
        fontSize: 14,
        color: colors.onSurface,
        lineHeight: 20,
    },
    footer: {
        paddingHorizontal: 24,
        gap: 8,
    },
    primaryBtn: {
        backgroundColor: colors.primary,
        borderRadius: 100,
        paddingVertical: 14,
        alignItems: 'center',
    },
    primaryBtnDisabled: {
        opacity: 0.6,
    },
    primaryText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '700',
    },
    ghostBtn: {
        paddingVertical: 10,
        alignItems: 'center',
    },
    ghostText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },
});
