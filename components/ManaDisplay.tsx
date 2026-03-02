import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useManaStore } from '../lib/manaStore';
import { colors, borderRadius, spacing } from '../lib/theme';
import { logShopOpened } from '../lib/analytics';

export function ManaDisplay() {
    const { balance, openShop } = useManaStore();

    const handlePress = () => {
        logShopOpened();
        openShop();
    };

    return (
        <TouchableOpacity style={styles.container} onPress={handlePress}>
            <Text style={styles.icon}>⚡</Text>
            <Text style={styles.text}>
                {(Math.floor(balance * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 215, 0, 0.15)', // Golden tint
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        borderRadius: borderRadius.full,
        borderWidth: 1,
        borderColor: 'rgba(255, 215, 0, 0.3)',
    },
    icon: {
        fontSize: 16,
        marginEnd: 4,
    },
    text: {
        color: '#FFD700', // Gold
        fontWeight: 'bold',
        fontSize: 14,
    },
});
