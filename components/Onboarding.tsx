import React, { useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Modal,
    Dimensions,
} from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

const { width, height } = Dimensions.get('window');

interface OnboardingProps {
    visible: boolean;
    onComplete: () => void;
}

interface OnboardingScreen {
    titleKey: string;
    bodyKey: string;
    emoji: string;
}

const screens: OnboardingScreen[] = [
    {
        titleKey: 'onboardingWelcomeTitle',
        bodyKey: 'onboardingWelcomeBody',
        emoji: '🧙',
    },
    {
        titleKey: 'onboardingHowTitle',
        bodyKey: 'onboardingHowBody',
        emoji: '✨',
    },
    {
        titleKey: 'onboardingIntegrationsTitle',
        bodyKey: 'onboardingIntegrationsBody',
        emoji: '🧪',
    },
    {
        titleKey: 'onboardingManaTitle',
        bodyKey: 'onboardingManaBody',
        emoji: '⚡',
    },
    {
        titleKey: 'onboardingBackupTitle',
        bodyKey: 'onboardingBackupBody',
        emoji: '📖',
    },
    {
        titleKey: 'onboardingScrollTitle',
        bodyKey: 'onboardingScrollBody',
        emoji: '📜',
    },
];

export function Onboarding({ visible, onComplete }: OnboardingProps) {
    const [currentScreen, setCurrentScreen] = useState(0);

    const handleNext = () => {
        if (currentScreen < screens.length - 1) {
            setCurrentScreen(currentScreen + 1);
        } else {
            onComplete();
        }
    };

    const handleSkip = () => {
        onComplete();
    };

    const screen = screens[currentScreen];
    const isLastScreen = currentScreen === screens.length - 1;

    // Parse body text for bold markers **text**
    const renderBody = (text: string) => {
        const parts = text.split(/(\*\*[^*]+\*\*)/g);
        return parts.map((part, index) => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return (
                    <Text key={index} style={styles.boldText}>
                        {part.slice(2, -2)}
                    </Text>
                );
            }
            return <Text key={index}>{part}</Text>;
        });
    };

    return (
        <Modal visible={visible} transparent animationType="fade">
            <View style={styles.overlay}>
                <View style={styles.container}>
                    {/* Skip button */}
                    <TouchableOpacity style={styles.skipButton} onPress={handleSkip}>
                        <Text style={styles.skipText}>{t('onboardingSkip')}</Text>
                    </TouchableOpacity>

                    {/* Big Emoji */}
                    <Text style={styles.emoji}>{screen.emoji}</Text>

                    {/* Title */}
                    <Text style={styles.title}>{t(screen.titleKey)}</Text>

                    {/* Body */}
                    <Text style={styles.body}>
                        {renderBody(t(screen.bodyKey))}
                    </Text>

                    {/* Pagination dots */}
                    <View style={styles.pagination}>
                        {screens.map((_, index) => (
                            <View
                                key={index}
                                style={[
                                    styles.dot,
                                    index === currentScreen && styles.dotActive,
                                ]}
                            />
                        ))}
                    </View>

                    {/* Next/Start button */}
                    <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
                        <Text style={styles.nextButtonText}>
                            {isLastScreen ? t('onboardingStart') : t('onboardingNext')}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    container: {
        width: width * 0.85,
        maxWidth: 400,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.xl,
        padding: spacing.xl,
        alignItems: 'center',
    },
    skipButton: {
        position: 'absolute',
        top: spacing.md,
        right: spacing.md,
        padding: spacing.sm,
    },
    skipText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },
    emoji: {
        fontSize: 80,
        marginBottom: spacing.lg,
        marginTop: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.onSurface,
        textAlign: 'center',
        marginBottom: spacing.md,
    },
    body: {
        fontSize: 16,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        lineHeight: 24,
        marginBottom: spacing.xl,
    },
    boldText: {
        fontWeight: 'bold',
        color: colors.primary,
    },
    pagination: {
        flexDirection: 'row',
        marginBottom: spacing.lg,
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.surfaceVariant,
        marginHorizontal: 4,
    },
    dotActive: {
        backgroundColor: colors.primary,
        width: 24,
    },
    nextButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.lg,
        width: '100%',
        alignItems: 'center',
    },
    nextButtonText: {
        color: '#fff',
        fontSize: 18,
        fontWeight: 'bold',
    },
});
