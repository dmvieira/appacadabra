import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useManaStore } from '../lib/manaStore';
import { colors, borderRadius, spacing } from '../lib/theme';

export function ManaDisplay() {
    const { balance, openShop } = useManaStore();

    return (
        <TouchableOpacity style={styles.container} onPress={openShop}>
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
        marginRight: 4,
    },
    text: {
        color: '#FFD700', // Gold
        fontWeight: 'bold',
        fontSize: 14,
    },
});
