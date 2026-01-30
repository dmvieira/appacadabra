import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, TouchableOpacity } from 'react-native';
import { colors, spacing, borderRadius, typography, shadows } from '../lib/theme';
import { useAppStore } from '../lib/store';
// @ts-expect-error - vector-icons type mismatch in newer Expo SDK
import { Ionicons } from '@expo/vector-icons';

export const Toast = () => {
    const statusMessage = useAppStore(state => state.statusMessage);
    const error = useAppStore(state => state.error);
    const clearStatusMessage = useAppStore(state => state.clearStatusMessage);
    const clearError = useAppStore(state => state.clearError);
    const translateY = useRef(new Animated.Value(100)).current;
    const opacity = useRef(new Animated.Value(0)).current;

    const activeMessage = error || statusMessage;
    const isError = !!error;

    useEffect(() => {
        if (activeMessage) {
            // Animate In
            Animated.parallel([
                Animated.timing(translateY, {
                    toValue: 0,
                    duration: 400,
                    easing: Easing.out(Easing.back(1.5)),
                    useNativeDriver: true,
                }),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: 300,
                    useNativeDriver: true,
                }),
            ]).start();

            // Auto dismiss
            const timer = setTimeout(() => {
                dismiss();
            }, 5000);

            return () => clearTimeout(timer);
        }
    }, [activeMessage]);

    const dismiss = () => {
        Animated.parallel([
            Animated.timing(translateY, {
                toValue: 100,
                duration: 300,
                easing: Easing.in(Easing.cubic),
                useNativeDriver: true,
            }),
            Animated.timing(opacity, {
                toValue: 0,
                duration: 250,
                useNativeDriver: true,
            }),
        ]).start(() => {
            clearStatusMessage();
            clearError();
        });
    };

    if (!activeMessage) return null;

    return (
        <Animated.View
            style={[
                styles.container,
                {
                    opacity,
                    transform: [{ translateY }],
                },
            ]}
        >
            <View style={[styles.content, isError && styles.contentError]}>
                <Ionicons
                    name={isError ? "alert-circle" : "sparkles"}
                    size={20}
                    color={colors.onPrimary}
                    style={styles.icon}
                />
                <Text style={styles.text}>{activeMessage}</Text>
                <TouchableOpacity onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={18} color={colors.onPrimary} style={{ opacity: 0.8 }} />
                </TouchableOpacity>
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        bottom: 80, // Above tab bar / bottom safe area
        left: 20,
        right: 20,
        alignItems: 'center',
        zIndex: 9999,
        elevation: 10, // Android shadow
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primary,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: borderRadius.full,
        ...shadows.lg,
        maxWidth: 400,
    },
    contentError: {
        backgroundColor: colors.error,
    },
    icon: {
        marginRight: spacing.sm,
    },
    text: {
        flex: 1,
        color: colors.onPrimary,
        ...typography.bodyMedium,
        fontWeight: '600',
    },
});
