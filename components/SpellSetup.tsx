import React, { useState, useEffect, useMemo } from 'react';
import {
    View,
    Text,
    Modal,
    StyleSheet,
    TouchableOpacity,
    Image,
    Animated,
    Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { GeneratedApp } from '../lib/database/types';

interface SpellSetupProps {
    app: GeneratedApp;
    onComplete: (options: { biometric: boolean; homeScreen: boolean }) => void;
    onSkip: () => void;
}

function getInitials(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

export default function SpellSetup({ app, onComplete, onSkip }: SpellSetupProps) {
    const insets = useSafeAreaInsets();
    const [biometric, setBiometric] = useState(false);
    const [homeScreen, setHomeScreen] = useState(false);
    const slideAnim = useMemo(() => new Animated.Value(0), []);

    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue: 1,
            useNativeDriver: true,
            damping: 18,
            stiffness: 180,
        }).start();
    }, [slideAnim]);

    const initials = getInitials(app.name);

    return (
        <Modal visible={true} animationType="none" transparent statusBarTranslucent>
            <Animated.View style={[
                styles.container,
                {
                    opacity: slideAnim.interpolate({
                        inputRange: [0, 0.5, 1],
                        outputRange: [0, 1, 1],
                    }),
                },
            ]}>
                <View style={[
                    styles.content,
                    {
                        paddingTop: Math.max(insets.top, 16),
                        paddingBottom: Math.max(insets.bottom, 32),
                    },
                ]}>

                    {/* Spell header */}
                    <View style={styles.header}>
                        {app.iconPath ? (
                            <Image source={{ uri: app.iconPath }} style={styles.avatar} />
                        ) : (
                            <View style={styles.avatar}>
                                <Text style={styles.avatarText}>{initials}</Text>
                            </View>
                        )}
                        <View style={styles.headerInfo}>
                            <Text style={styles.spellName} numberOfLines={1}>{app.name}</Text>
                            <Text style={styles.spellSub}>{t('setupFirstOpen')}</Text>
                        </View>
                    </View>

                    {/* Body */}
                    <View style={styles.body}>
                        <Text style={styles.title}>
                            {t('setupTitle')}
                        </Text>
                        <Text style={styles.subtitle}>
                            {t('setupSubtitle')}
                        </Text>

                        {/* Biometric option */}
                        <TouchableOpacity
                            style={[styles.optionCard, biometric && styles.optionCardSelected]}
                            onPress={() => setBiometric(!biometric)}
                            activeOpacity={0.7}
                        >
                            <View style={styles.optionIcon}>
                                <Text style={styles.optionIconText}>🔒</Text>
                            </View>
                            <View style={styles.optionInfo}>
                                <Text style={styles.optionTitle}>{t('setupBiometricTitle')}</Text>
                                <Text style={styles.optionDesc}>{t('setupBiometricDesc')}</Text>
                            </View>
                            <View style={[styles.optionCheck, biometric && styles.optionCheckSelected]}>
                                {biometric && <Text style={styles.optionCheckMark}>✓</Text>}
                            </View>
                        </TouchableOpacity>

                        {/* Home screen option */}
                        {Platform.OS === 'android' && (
                            <TouchableOpacity
                                style={[styles.optionCard, homeScreen && styles.optionCardSelected]}
                                onPress={() => setHomeScreen(!homeScreen)}
                                activeOpacity={0.7}
                            >
                                <View style={styles.optionIcon}>
                                    <Text style={styles.optionIconText}>🏠</Text>
                                </View>
                                <View style={styles.optionInfo}>
                                    <Text style={styles.optionTitle}>{t('setupHomeTitle')}</Text>
                                    <Text style={styles.optionDesc}>{t('setupHomeDesc')}</Text>
                                </View>
                                <View style={[styles.optionCheck, homeScreen && styles.optionCheckSelected]}>
                                    {homeScreen && <Text style={styles.optionCheckMark}>✓</Text>}
                                </View>
                            </TouchableOpacity>
                        )}
                    </View>

                    {/* Footer */}
                    <View style={styles.footer}>
                        <TouchableOpacity
                            style={styles.primaryButton}
                            onPress={() => onComplete({ biometric, homeScreen })}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.primaryButtonText}>{t('setupEnter')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={onSkip} style={styles.skipLink}>
                            <Text style={styles.skipText}>{t('setupSkip')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    content: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: spacing.lg,
        paddingVertical: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#1F2937',
    },
    avatar: {
        width: 52,
        height: 52,
        borderRadius: 14,
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarText: {
        color: colors.onPrimaryContainer,
        fontSize: 20,
        fontWeight: '900',
    },
    headerInfo: {
        flex: 1,
    },
    spellName: {
        color: '#F9FAFB',
        fontSize: 17,
        fontWeight: '800',
    },
    spellSub: {
        color: '#6B7280',
        fontSize: 13,
        fontWeight: '600',
        marginTop: 2,
    },

    // Body
    body: {
        flex: 1,
        paddingHorizontal: spacing.lg,
        paddingTop: 28,
        gap: 16,
    },
    title: {
        color: '#F9FAFB',
        fontSize: 22,
        fontWeight: '900',
        lineHeight: 28,
        marginBottom: 4,
    },
    subtitle: {
        color: '#6B7280',
        fontSize: 14,
        fontWeight: '600',
        lineHeight: 21,
        marginBottom: 8,
    },

    // Option card
    optionCard: {
        backgroundColor: '#111827',
        borderWidth: 2,
        borderColor: '#1F2937',
        borderRadius: 18,
        padding: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    optionCardSelected: {
        borderColor: colors.primary,
        backgroundColor: '#1a1230',
    },
    optionIcon: {
        width: 56,
        height: 56,
        backgroundColor: colors.background,
        borderRadius: 14,
        justifyContent: 'center',
        alignItems: 'center',
    },
    optionIconText: {
        fontSize: 28,
    },
    optionInfo: {
        flex: 1,
    },
    optionTitle: {
        color: '#F9FAFB',
        fontSize: 15,
        fontWeight: '800',
        marginBottom: 3,
    },
    optionDesc: {
        color: '#9CA3AF',
        fontSize: 13,
        fontWeight: '600',
        lineHeight: 18,
    },
    optionCheck: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: '#374151',
        justifyContent: 'center',
        alignItems: 'center',
    },
    optionCheckSelected: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    optionCheckMark: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
    },

    // Footer
    footer: {
        paddingHorizontal: spacing.lg,
        gap: 10,
    },
    primaryButton: {
        backgroundColor: colors.primary,
        borderRadius: 14,
        paddingVertical: 16,
        alignItems: 'center',
    },
    primaryButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '800',
    },
    skipLink: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    skipText: {
        color: '#6B7280',
        fontSize: 14,
        fontWeight: '600',
    },
});
