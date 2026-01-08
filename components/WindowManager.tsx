import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useAppStore } from '../lib/store';
import AppRunner from './AppRunner';

export default function WindowManager() {
    const { runningInstances, activeAppId } = useAppStore();

    if (runningInstances.length === 0) return null;

    // If there is an active app, capture touches. Otherwise let them pass through.
    const pointerEvents = activeAppId !== null ? 'auto' : 'none';

    return (
        <View style={styles.container} pointerEvents={pointerEvents}>
            {runningInstances.map(instance => (
                <AppRunner
                    key={instance.id}
                    appId={instance.id}
                    isVisible={instance.id === activeAppId}
                    mode={instance.mode}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 1000,
        elevation: 1000, // Android
        backgroundColor: 'transparent',
    },
});
