import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Modal,
    Dimensions,
    Animated,
    Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TOTAL_SCREENS = 3;

interface OnboardingProps {
    visible: boolean;
    onComplete: (selectedChip: number | null) => void;
}

// ── Typing dots animation ──
function TypingDots() {
    const dot1 = useRef(new Animated.Value(0)).current;
    const dot2 = useRef(new Animated.Value(0)).current;
    const dot3 = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const createBounce = (dot: Animated.Value, delay: number) =>
            Animated.loop(
                Animated.sequence([
                    Animated.delay(delay),
                    Animated.timing(dot, { toValue: -6, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
                    Animated.timing(dot, { toValue: 0, duration: 200, easing: Easing.in(Easing.ease), useNativeDriver: true }),
                    Animated.delay(600),
                ])
            );
        createBounce(dot1, 0).start();
        createBounce(dot2, 150).start();
        createBounce(dot3, 300).start();
    }, []);

    return (
        <View style={s.typingDotsRow}>
            {[dot1, dot2, dot3].map((dot, i) => (
                <Animated.View key={i} style={[s.typingDot, { transform: [{ translateY: dot }] }]} />
            ))}
        </View>
    );
}

// ── Floating emoji with bounce ──
function FloatingEmoji({ emoji, color }: { emoji: string; color: string }) {
    const y = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.loop(
            Animated.sequence([
                Animated.timing(y, { toValue: -10, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
                Animated.timing(y, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
            ])
        ).start();
    }, []);

    return (
        <View style={s.illustrationArea}>
            <Animated.Text style={[s.floatingEmoji, { transform: [{ translateY: y }], textShadowColor: color, textShadowRadius: 30 }]}>
                {emoji}
            </Animated.Text>
        </View>
    );
}

// ── Featured power card ──
function FeatCard({ icon, title, desc, delay }: { icon: string; title: string; desc: string; delay: number }) {
    const opacity = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(16)).current;

    useEffect(() => {
        Animated.parallel([
            Animated.timing(opacity, { toValue: 1, duration: 450, delay, useNativeDriver: true }),
            Animated.timing(translateY, { toValue: 0, duration: 450, delay, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]).start();
    }, []);

    return (
        <Animated.View style={[s.featCard, { opacity, transform: [{ translateY }] }]}>
            <View style={s.featIcon}>
                <Text style={s.featIconText}>{icon}</Text>
            </View>
            <View style={s.featInfo}>
                <Text style={s.featTitle}>{title}</Text>
                <Text style={s.featDesc}>{desc}</Text>
            </View>
        </Animated.View>
    );
}

export function Onboarding({ visible, onComplete }: OnboardingProps) {
    const [currentScreen, setCurrentScreen] = useState(0);
    const [showPreview, setShowPreview] = useState(false);
    const [selectedChip, setSelectedChip] = useState<number | null>(null);
    const insets = useSafeAreaInsets();
    const slideAnim = useRef(new Animated.Value(0)).current;
    const previewAnim = useRef(new Animated.Value(0)).current;

    // Reset when closing
    useEffect(() => {
        if (!visible) {
            setCurrentScreen(0);
            setShowPreview(false);
            setSelectedChip(null);
            slideAnim.setValue(0);
        }
    }, [visible]);

    // Show mini app preview after delay on screen 1
    useEffect(() => {
        if (visible && currentScreen === 0 && !showPreview) {
            const timer = setTimeout(() => {
                setShowPreview(true);
                Animated.spring(previewAnim, { toValue: 1, friction: 6, useNativeDriver: true }).start();
            }, 2500);
            return () => clearTimeout(timer);
        }
    }, [visible, currentScreen]);

    const goToScreen = (n: number) => {
        const direction = n > currentScreen ? 1 : -1;
        slideAnim.setValue(direction * 40);
        setCurrentScreen(n);
        Animated.timing(slideAnim, { toValue: 0, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
    };

    const handleNext = () => {
        // Don't advance from try-it screen (now screen 2) without a chip selection
        if (currentScreen === 2 && selectedChip === null) return;

        if (currentScreen < TOTAL_SCREENS - 1) {
            goToScreen(currentScreen + 1);
        } else {
            onComplete(selectedChip);
        }
    };

    const handleChipPress = (index: number) => {
        setSelectedChip(index);
    };

    const progressWidth = `${((currentScreen + 1) / TOTAL_SCREENS) * 100}%`;
    const isLastScreen = currentScreen === TOTAL_SCREENS - 1;

    const chips = [
        { emoji: '🛒', labelKey: 'obChipShopping' },
        { emoji: '📓', labelKey: 'obChipDiary' },
        { emoji: '💪', labelKey: 'obChipWorkout' },
        { emoji: '💰', labelKey: 'obChipExpenses' },
    ];

    const chipTexts = [
        'obChipShoppingFull',
        'obChipDiaryFull',
        'obChipWorkoutFull',
        'obChipExpensesFull',
    ];

    const moreTags = [
        { emoji: '🔔', key: 'obTagNotifications' },
        { emoji: '❤️', key: 'obTagHealth' },
        { emoji: '📍', key: 'obTagSensors' },
    ];

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
            <View style={[s.overlay, { paddingTop: Math.max(insets.top, 20) }]}>
                {/* Progress bar */}
                <View style={s.progressBar}>
                    <View style={[s.progressFill, { width: progressWidth as any }]} />
                </View>

                <Animated.View style={[s.screenContainer, { transform: [{ translateX: slideAnim }] }]}>
                    {/* Skip button — only on last screen */}
                    {currentScreen === 2 && (
                        <TouchableOpacity
                            style={s.skipButton}
                            onPress={() => onComplete(null)}
                            accessibilityLabel={t('onboardingSkip')}
                            accessibilityRole="button"
                        >
                            <Text style={s.skipText}>{t('onboardingSkip')}</Text>
                        </TouchableOpacity>
                    )}

                    {/* ── SCREEN 1: Concept ── */}
                    {currentScreen === 0 && (
                        <View style={s.screenContent}>
                            <FloatingEmoji emoji="🪄" color="#7c3aed" />

                            <Text style={s.heading}>
                                {t('obConceptTitle1')}{'\n'}
                                <Text style={s.headingAccent}>{t('obConceptTitle2')}</Text>{'\n'}
                                {t('obConceptTitle3')}
                            </Text>
                            <Text style={s.subtext}>{t('obConceptSubtext')}</Text>

                            {/* Chat demo */}
                            <View style={s.chatDemo}>
                                <View style={s.chatBubbleUser}>
                                    <Text style={s.chatBubbleText}>{t('obConceptPrompt')}</Text>
                                </View>

                                <View style={{ marginTop: 10 }}>
                                    {!showPreview ? (
                                        <TypingDots />
                                    ) : (
                                        <Animated.View style={[s.miniAppPreview, {
                                            opacity: previewAnim,
                                            transform: [{ translateY: previewAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
                                        }]}>
                                            <View style={s.miniAppIcon}>
                                                <Text style={{ fontSize: 20 }}>🚀</Text>
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={s.miniAppName}>Space Shopping List</Text>
                                                <Text style={s.miniAppTag}>{t('obConceptCreated')}</Text>
                                            </View>
                                        </Animated.View>
                                    )}
                                </View>
                            </View>

                            {/* Dots */}
                            <View style={s.dotsRow}>
                                {[0, 1, 2].map(i => (
                                    <View key={i} style={[s.dot, i === 0 && s.dotActive]} />
                                ))}
                            </View>
                        </View>
                    )}

                    {/* ── SCREEN 2: Superpowers ── */}
                    {currentScreen === 1 && (
                        <View style={s.screenContent}>
                            <View style={s.heroArea}>
                                <View>
                                    <Text style={[s.heading, { fontSize: 28 }]}>
                                        {t('obPowersTitle1')} <Text style={s.headingAccent}>{t('obPowersTitle2')}</Text>
                                    </Text>
                                    <Text style={s.subtext}>{t('obPowersSubtext')}</Text>
                                </View>

                                {/* Featured cards */}
                                <View style={s.featuredCards}>
                                    <FeatCard
                                        icon="🔗"
                                        title={t('obFeatIntegratedTitle')}
                                        desc={t('obFeatIntegratedDesc')}
                                        delay={0}
                                    />
                                    <FeatCard
                                        icon="📅"
                                        title={t('obFeatCalendarTitle')}
                                        desc={t('obFeatCalendarDesc')}
                                        delay={150}
                                    />
                                </View>

                                {/* More tags */}
                                <View>
                                    <Text style={s.moreLabel}>{t('obMoreLabel')}</Text>
                                    <View style={s.moreRow}>
                                        {moreTags.map((tag, i) => (
                                            <View key={i} style={s.moreTag}>
                                                <Text style={s.moreTagText}>{tag.emoji} {t(tag.key)}</Text>
                                            </View>
                                        ))}
                                    </View>
                                </View>
                            </View>

                            {/* Dots */}
                            <View style={[s.dotsRow, { marginTop: 14 }]}>
                                {[0, 1, 2].map(i => (
                                    <View key={i} style={[s.dot, i === 1 && s.dotActive]} />
                                ))}
                            </View>
                        </View>
                    )}

                    {/* ── SCREEN 3: Try it ── */}
                    {currentScreen === 2 && (
                        <View style={s.screenContent}>
                            <FloatingEmoji emoji="✨" color="#f59e0b" />

                            <Text style={s.heading}>
                                {t('obTryTitle1')} <Text style={s.headingAccent}>{t('obTryTitle2')}</Text>{'\n'}
                                {t('obTryTitle3')}
                            </Text>
                            <Text style={s.subtext}>{t('obTrySubtext')}</Text>


                            {/* Chips */}
                            <View style={s.chipsRow}>
                                {chips.map((chip, i) => (
                                    <TouchableOpacity
                                        key={i}
                                        style={[s.chip, selectedChip === i && s.chipSelected]}
                                        onPress={() => handleChipPress(i)}
                                        accessibilityRole="button"
                                    >
                                        <Text style={[s.chipText, selectedChip === i && s.chipTextSelected]}>
                                            {chip.emoji} {t(chip.labelKey)}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            {/* Input area */}
                            <View style={[s.tryInputArea, selectedChip !== null && s.tryInputFocused]}>
                                <Text style={s.tryInputLabel}>{t('obTryPlaceholder')}</Text>
                                <Text style={s.tryTypedText}>
                                    {selectedChip !== null ? t(chipTexts[selectedChip]) : ' '}
                                </Text>
                            </View>

                            {/* Dots */}
                            <View style={s.dotsRow}>
                                {[0, 1, 2].map(i => (
                                    <View key={i} style={[s.dot, i === 2 && s.dotActive]} />
                                ))}
                            </View>
                        </View>
                    )}
                </Animated.View>

                {/* Footer CTA */}
                <View style={s.footer}>
                    <TouchableOpacity
                        style={[s.ctaButton, currentScreen === 2 && selectedChip === null && { opacity: 0.5 }]}
                        onPress={handleNext}
                        accessibilityLabel={isLastScreen ? t('obCreateCTA') : t('onboardingNext')}
                        accessibilityRole="button"
                    >
                        <Text style={s.ctaText}>
                            {currentScreen < 2
                                ? t('obNextLabel')
                                : t('obCreateCTA')
                            }
                        </Text>
                    </TouchableOpacity>
                    {currentScreen === 2 && (
                        <Text style={s.footerHint}>{t('obCreateHint')}</Text>
                    )}
                </View>
            </View>
        </Modal>
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
    screenContainer: {
        flex: 1,
        paddingHorizontal: 28,
    },
    skipButton: {
        alignSelf: 'flex-end',
        paddingTop: 12,
        paddingBottom: 4,
    },
    skipText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },
    screenContent: {
        flex: 1,
    },

    // ── Illustration ──
    illustrationArea: {
        height: 160,
        alignItems: 'center',
        justifyContent: 'center',
    },
    floatingEmoji: {
        fontSize: 80,
    },

    // ── Typography ──
    heading: {
        fontSize: 26,
        fontWeight: '800',
        color: colors.onSurface,
        lineHeight: 32,
        marginBottom: 8,
    },
    headingAccent: {
        color: '#a855f7',
    },
    subtext: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        lineHeight: 22,
        marginBottom: 20,
    },

    // ── Chat demo (Screen 1) ──
    chatDemo: {
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: '#2a2a3e',
        borderRadius: 20,
        padding: 16,
    },
    chatBubbleUser: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: 16,
        borderBottomEndRadius: 4,
        paddingHorizontal: 14,
        paddingVertical: 10,
        alignSelf: 'flex-end',
    },
    chatBubbleText: {
        fontSize: 13,
        color: colors.onSurface,
    },
    typingDotsRow: {
        flexDirection: 'row',
        gap: 4,
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignSelf: 'flex-start',
    },
    typingDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#a855f7',
    },
    miniAppPreview: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: 12,
        padding: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: 'rgba(124,58,237,0.3)',
    },
    miniAppIcon: {
        width: 40,
        height: 40,
        backgroundColor: colors.primary,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    miniAppName: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.onSurface,
    },
    miniAppTag: {
        fontSize: 11,
        color: '#10b981',
    },

    // ── Dots ──
    dotsRow: {
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'center',
        paddingVertical: 20,
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.surfaceVariant,
    },
    dotActive: {
        width: 28,
        borderRadius: 4,
        backgroundColor: colors.primary,
    },

    // ── Try it (Screen 2) ──
    tryInputArea: {
        backgroundColor: colors.surface,
        borderWidth: 1.5,
        borderColor: colors.primaryContainer,
        borderRadius: 20,
        padding: 16,
    },
    tryInputFocused: {
        borderColor: colors.primary,
    },
    tryInputLabel: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
        marginBottom: 8,
    },
    tryTypedText: {
        fontSize: 15,
        color: colors.onSurface,
        minHeight: 22,
    },
    chipsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 12,
        justifyContent: 'center',
        marginBottom: 20,
    },
    chip: {
        backgroundColor: colors.surfaceVariant,
        borderWidth: 1,
        borderColor: '#2a2a3e',
        borderRadius: 100,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    chipSelected: {
        borderColor: colors.primary,
        backgroundColor: colors.primaryContainer,
    },
    chipText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    chipTextSelected: {
        color: '#a855f7',
    },

    // ── Powers grid (Screen 3) ──
    heroArea: {
        flex: 1,
        justifyContent: 'center',
        gap: 28,
    },
    featuredCards: {
        gap: 12,
    },
    featCard: {
        backgroundColor: '#111827',
        borderWidth: 1,
        borderColor: 'rgba(124,58,237,0.25)',
        borderRadius: 20,
        padding: 20,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 18,
    },
    featIcon: {
        width: 64,
        height: 64,
        backgroundColor: '#1a1a2e',
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    featIconText: {
        fontSize: 32,
    },
    featInfo: {
        flex: 1,
    },
    featTitle: {
        color: '#F9FAFB',
        fontSize: 16,
        fontWeight: '800',
        marginBottom: 4,
    },
    featDesc: {
        color: '#9CA3AF',
        fontSize: 13,
        fontWeight: '600',
        lineHeight: 19,
    },
    moreLabel: {
        color: '#4B5563',
        fontSize: 12,
        fontWeight: '700',
        marginBottom: 6,
    },
    moreRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    moreTag: {
        backgroundColor: '#1F2937',
        borderRadius: 99,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    moreTagText: {
        color: '#6B7280',
        fontSize: 12,
        fontWeight: '700',
    },

    // ── Footer ──
    footer: {
        paddingHorizontal: 28,
        paddingBottom: 36,
        paddingTop: 20,
        gap: 12,
    },
    ctaButton: {
        backgroundColor: colors.primary,
        borderRadius: 100,
        paddingVertical: 16,
        paddingHorizontal: 24,
        alignItems: 'center',
    },
    ctaText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
    },
    footerHint: {
        textAlign: 'center',
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
});
