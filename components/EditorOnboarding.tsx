import React, { useState, useRef, useCallback } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Animated,
    Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../lib/i18n';
import { colors, spacing, borderRadius } from '../lib/theme';

interface EditorOnboardingProps {
    onComplete: () => void;
}

interface OnboardingStep {
    icon: string;
    titleKey: string;
    descKey: string;
    exampleKey: string;
    color: string;
    highlightIndex: number;
}

const STEPS: OnboardingStep[] = [
    {
        icon: '👆',
        titleKey: 'editorObStep1Title',
        descKey: 'editorObStep1Desc',
        exampleKey: 'editorObStep1Example',
        color: '#7C3AED',
        highlightIndex: 0,
    },
    {
        icon: '✏️',
        titleKey: 'editorObStep2Title',
        descKey: 'editorObStep2Desc',
        exampleKey: 'editorObStep2Example',
        color: '#D97706',
        highlightIndex: 1,
    },
    {
        icon: '📜',
        titleKey: 'editorObStep3Title',
        descKey: 'editorObStep3Desc',
        exampleKey: 'editorObStep3Example',
        color: '#2563EB',
        highlightIndex: 2,
    },
];

const PREVIEW_TABS = [
    { icon: '👆', labelKey: 'selectElement' },
    { icon: '✏️', labelKey: 'edit' },
    { icon: '📜', labelKey: 'history' },
];

type Screen = 'onboarding' | 'finish';

export default function EditorOnboarding({ onComplete }: EditorOnboardingProps) {
    const [current, setCurrent] = useState(0);
    const [screen, setScreen] = useState<Screen>('onboarding');
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const slideAnim = useRef(new Animated.Value(0)).current;
    const insets = useSafeAreaInsets();

    const step = STEPS[current];
    const isLast = current === STEPS.length - 1;

    const animateTransition = useCallback((direction: 'next' | 'prev', cb: () => void) => {
        const toValue = direction === 'next' ? -30 : 30;
        Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
            Animated.timing(slideAnim, { toValue, duration: 120, useNativeDriver: true }),
        ]).start(() => {
            cb();
            slideAnim.setValue(direction === 'next' ? 30 : -30);
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
                Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
            ]).start();
        });
    }, [fadeAnim, slideAnim]);

    const goNext = () => {
        if (isLast) {
            setScreen('finish');
            return;
        }
        animateTransition('next', () => setCurrent(c => c + 1));
    };

    const goBack = () => {
        if (current > 0) {
            animateTransition('prev', () => setCurrent(c => c - 1));
        }
    };

    const goToDot = (index: number) => {
        if (index === current) return;
        animateTransition(index > current ? 'next' : 'prev', () => setCurrent(index));
    };

    const restart = () => {
        setCurrent(0);
        setScreen('onboarding');
    };

    // ─── FINISH SCREEN ───
    if (screen === 'finish') {
        return (
            <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
                <View style={styles.finishContainer}>
                    <View style={styles.finishInner}>
                        <Animated.Text style={styles.finishEmoji}>🎉</Animated.Text>
                        <Text style={styles.finishTitle}>{t('editorObFinishTitle')}</Text>
                        <Text style={styles.finishDesc}>{t('editorObFinishDesc')}</Text>
                        <TouchableOpacity
                            style={styles.finishBtn}
                            onPress={onComplete}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.finishBtnText}>{t('editorObFinishBtn')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={restart}>
                            <Text style={styles.retryText}>{t('editorObRetry')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        );
    }

    // ─── ONBOARDING STEPS ───
    return (
        <View style={styles.root}>
            {/* Glow effect */}
            <View style={[styles.glow, { backgroundColor: step.color + '18' }]} />

            {/* Header: counter + skip */}
            <View style={[styles.header, { paddingTop: Math.max(insets.top + 16, 48) }]}>
                <View style={styles.topRow}>
                    <Text style={styles.counter}>{current + 1}/{STEPS.length}</Text>
                    <TouchableOpacity onPress={() => setScreen('finish')}>
                        <Text style={styles.skipText}>{t('editorObSkip')} →</Text>
                    </TouchableOpacity>
                </View>

                {/* Dots */}
                <View style={styles.dots}>
                    {STEPS.map((_, i) => (
                        <TouchableOpacity
                            key={i}
                            onPress={() => goToDot(i)}
                            style={[
                                styles.dot,
                                {
                                    width: i === current ? 28 : 8,
                                    backgroundColor: i === current ? step.color : colors.surfaceVariant,
                                },
                            ]}
                        />
                    ))}
                </View>
            </View>

            {/* Animated content */}
            <Animated.View
                style={[
                    styles.content,
                    { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
                ]}
            >
                {/* Icon */}
                <View style={styles.iconBox}>
                    <View style={[styles.iconInner, { backgroundColor: step.color + '18', borderColor: step.color + '44' }]}>
                        <Text style={styles.iconText}>{step.icon}</Text>
                    </View>
                </View>

                {/* Title + Description */}
                <View style={styles.textBlock}>
                    <Text style={styles.stepTitle}>{t(step.titleKey)}</Text>
                    <Text style={styles.stepDesc}>{t(step.descKey)}</Text>
                </View>

                {/* Example pill */}
                <View style={[styles.examplePill, { backgroundColor: step.color + '14', borderColor: step.color + '30' }]}>
                    <Text style={[styles.exampleText, { color: step.color }]}>{t(step.exampleKey)}</Text>
                </View>
            </Animated.View>

            {/* Tab preview */}
            <View style={styles.tabWrap}>
                <Text style={styles.tabHint}>{t('editorObTabHint')}</Text>
                <View style={styles.tabPreview}>
                    {PREVIEW_TABS.map((tab, i) => {
                        const isHighlighted = i === step.highlightIndex;
                        return (
                            <View
                                key={i}
                                style={[
                                    styles.tabItem,
                                    isHighlighted && {
                                        backgroundColor: step.color + '22',
                                        borderColor: step.color + '55',
                                        transform: [{ scale: 1.1 }],
                                    },
                                ]}
                            >
                                <Text style={styles.tabIcon}>{tab.icon}</Text>
                                <Text style={[styles.tabLabel, isHighlighted && { color: step.color }]}>
                                    {t(tab.labelKey)}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </View>

            {/* Navigation buttons */}
            <View style={[styles.navRow, { paddingBottom: Math.max(insets.bottom + 12, 40) }]}>
                {current > 0 ? (
                    <TouchableOpacity style={styles.backBtn} onPress={goBack} activeOpacity={0.7}>
                        <Text style={styles.backBtnText}>← {t('editorObBack')}</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={{ flex: 1 }} />
                )}
                <TouchableOpacity
                    style={[styles.nextBtn, { backgroundColor: step.color }]}
                    onPress={goNext}
                    activeOpacity={0.8}
                >
                    <Text style={styles.nextBtnText}>
                        {isLast ? t('editorObGotIt') : t('editorObNext') + ' →'}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: colors.background,
    },

    // ─── Glow ───
    glow: {
        position: 'absolute',
        top: -80,
        alignSelf: 'center',
        width: 340,
        height: 340,
        borderRadius: 170,
    },

    // ─── Header ───
    header: {
        paddingHorizontal: 28,
    },
    topRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 28,
    },
    counter: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        fontWeight: '700',
    },
    skipText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        fontWeight: '700',
    },
    dots: {
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'center',
        marginBottom: 32,
    },
    dot: {
        height: 8,
        borderRadius: 4,
    },

    // ─── Content ───
    content: {
        flex: 1,
        paddingHorizontal: 28,
        gap: 20,
    },
    iconBox: {
        alignItems: 'center',
    },
    iconInner: {
        width: 100,
        height: 100,
        borderRadius: 28,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconText: {
        fontSize: 48,
    },
    textBlock: {
        alignItems: 'center',
    },
    stepTitle: {
        color: colors.onSurface,
        fontSize: 26,
        fontWeight: '900',
        marginBottom: 12,
        lineHeight: 32,
        textAlign: 'center',
    },
    stepDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
        lineHeight: 26,
        textAlign: 'center',
    },
    examplePill: {
        borderRadius: 14,
        padding: 14,
        borderWidth: 1,
        alignItems: 'center',
    },
    exampleText: {
        fontSize: 14,
        fontWeight: '700',
    },

    // ─── Tab preview ───
    tabWrap: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    tabHint: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        textAlign: 'center',
        marginBottom: 8,
        fontWeight: '600',
        opacity: 0.6,
    },
    tabPreview: {
        backgroundColor: colors.surface,
        borderRadius: 16,
        padding: 12,
        flexDirection: 'row',
        justifyContent: 'space-around',
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
    },
    tabItem: {
        alignItems: 'center',
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        minWidth: 52,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    tabIcon: {
        fontSize: 22,
    },
    tabLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.onSurfaceVariant,
    },

    // ─── Nav buttons ───
    navRow: {
        flexDirection: 'row',
        gap: 12,
        paddingHorizontal: 28,
        paddingTop: 14,
    },
    backBtn: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        borderRadius: 14,
        padding: 16,
        alignItems: 'center',
    },
    backBtnText: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
        fontWeight: '800',
    },
    nextBtn: {
        flex: 2,
        borderRadius: 14,
        padding: 16,
        alignItems: 'center',
    },
    nextBtnText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '800',
    },

    // ─── Finish ───
    finishContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    finishInner: {
        alignItems: 'center',
    },
    finishEmoji: {
        fontSize: 72,
        marginBottom: 16,
    },
    finishTitle: {
        color: colors.onSurface,
        fontSize: 28,
        fontWeight: '900',
        marginBottom: 12,
    },
    finishDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
        maxWidth: 280,
        textAlign: 'center',
        marginBottom: 32,
        lineHeight: 26,
    },
    finishBtn: {
        backgroundColor: colors.primary,
        borderRadius: 14,
        paddingVertical: 14,
        paddingHorizontal: 32,
        marginBottom: 16,
    },
    finishBtnText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '800',
    },
    retryText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
    },
});
