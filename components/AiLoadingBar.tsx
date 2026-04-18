import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, useWindowDimensions } from 'react-native';
import { colors } from '../lib/theme';
import { t } from '../lib/i18n';

interface AiLoadingBarProps {
    visible: boolean;
    elapsedSeconds?: number;
    isLargePayload?: boolean;
}

function getLoadingMessage(elapsed: number, isLarge: boolean): string | null {
    if (isLarge && elapsed < 8) return t('aiLoadingLargePayload');
    if (elapsed >= 45) return t('aiLoadingTakingLong');
    if (elapsed >= 20) return t('aiLoadingStillWorking');
    if (elapsed >= 8) return t('aiLoadingThinking');
    return null;
}

export const AiLoadingBar: React.FC<AiLoadingBarProps> = ({ visible, elapsedSeconds = 0, isLargePayload = false }) => {
    const { width: screenWidth } = useWindowDimensions();
    const translateX = useRef(new Animated.Value(-screenWidth * 0.4)).current;

    useEffect(() => {
        if (visible) {
            // Reset position
            translateX.setValue(-screenWidth * 0.4);
            
            // Indeterminate animation loop
            Animated.loop(
                Animated.timing(translateX, {
                    toValue: screenWidth,
                    duration: 1500,
                    easing: Easing.bezier(0.4, 0, 0.2, 1),
                    useNativeDriver: true,
                })
            ).start();
        } else {
            translateX.stopAnimation();
        }
    }, [visible, screenWidth]);

    if (!visible) return null;

    const msg = getLoadingMessage(elapsedSeconds, isLargePayload);

    return (
        <View style={styles.container}>
            <Animated.View
                style={[
                    styles.bar,
                    {
                        transform: [{ translateX }],
                    },
                ]}
            />
            {msg && (
                <Text style={styles.label}>{msg}</Text>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        backgroundColor: 'rgba(0,0,0,0.05)',
        zIndex: 10000,
        overflow: 'visible',
    },
    bar: {
        width: '40%',
        height: '100%',
        backgroundColor: colors.primary,
        borderRadius: 2,
    },
    label: {
        position: 'absolute',
        top: 3,
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: 11,
        color: '#fff',
        backgroundColor: 'rgba(0,0,0,0.6)',
        paddingVertical: 2,
        paddingHorizontal: 8,
    },
});

export default AiLoadingBar;
