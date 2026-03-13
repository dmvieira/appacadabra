import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing, useWindowDimensions } from 'react-native';
import { colors } from '../lib/theme';

interface AiLoadingBarProps {
    visible: boolean;
}

export const AiLoadingBar: React.FC<AiLoadingBarProps> = ({ visible }) => {
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
        overflow: 'hidden',
    },
    bar: {
        width: '40%',
        height: '100%',
        backgroundColor: colors.primary,
        borderRadius: 2,
    },
});

export default AiLoadingBar;
