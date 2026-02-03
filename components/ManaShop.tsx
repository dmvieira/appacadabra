import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert } from 'react-native';
import { useManaStore } from '../lib/manaStore';
import { t } from '../lib/i18n';
import { colors, borderRadius, spacing } from '../lib/theme';
import * as firebase from '../lib/firebase';

export function ManaShop() {
    const { addMana, balance, isShopOpen, closeShop } = useManaStore();

    if (!isShopOpen) return null;

    const handlePurchase = async (amount: number) => {
        // Simulate purchase
        Alert.alert(
            t('confirmPurchase'),
            t('purchaseConfirmMessage', { amount }),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    onPress: async () => {
                        try {
                            const result = await firebase.addCredits(amount, 'purchase_simulator');
                            Alert.alert(t('purchaseSuccess', { amount }));
                            closeShop();
                        } catch (error) {
                            console.error(error);
                            Alert.alert('Error', 'Failed to add credits');
                        }
                    }
                }
            ]
        );
    };

    const handleWatchAd = async () => {
        // Simulate Ad
        Alert.alert(t('watchAd'), t('watchingAd'), [
            {
                text: 'OK', onPress: async () => {
                    try {
                        await firebase.addCredits(1, 'ad_reward');
                        Alert.alert(t('purchaseSuccess', { amount: 1 }));
                    } catch (error) {
                        console.error(error);
                        Alert.alert('Error', 'Failed to add reward');
                    }
                }
            }
        ]);
    };

    return (
        <Modal visible={isShopOpen} transparent animationType="slide" onRequestClose={closeShop}>
            <View style={styles.overlay}>
                <View style={styles.modal}>
                    <View style={styles.header}>
                        <Text style={styles.title}>⚡ {t('manaShopTitle')}</Text>
                        <TouchableOpacity onPress={closeShop}>
                            <Text style={styles.close}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <ScrollView contentContainerStyle={styles.content}>
                        <View style={styles.balanceContainer}>
                            <Text style={styles.balanceLabel}>{t('currentBalance')}</Text>
                            <Text style={styles.balanceValue}>{(Math.floor(balance * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ⚡</Text>
                        </View>

                        <Text style={styles.sectionTitle}>{t('buyMana')}</Text>

                        <TouchableOpacity style={styles.packageCard} onPress={() => handlePurchase(10)}>
                            <View>
                                <Text style={styles.packageTitle}>{t('manaPackage1')}</Text>
                                <Text style={styles.packageSub}>$0.99</Text>
                            </View>
                            <Text style={styles.buyBtn}>$0.99</Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={[styles.packageCard, styles.popularCard]} onPress={() => handlePurchase(50)}>
                            <View>
                                <Text style={styles.packageTitle}>{t('manaPackage2')}</Text>
                                <Text style={styles.packageSub}>$4.99</Text>
                            </View>
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>POPULAR</Text>
                            </View>
                            <Text style={styles.buyBtn}>$4.99</Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.packageCard} onPress={() => handlePurchase(120)}>
                            <View>
                                <Text style={styles.packageTitle}>{t('manaPackage3')}</Text>
                                <Text style={styles.packageSub}>$10.99</Text>
                            </View>
                            <Text style={styles.buyBtn}>$10.99</Text>
                        </TouchableOpacity>

                        <Text style={styles.sectionTitle}>{t('freeMana')}</Text>
                        <TouchableOpacity style={styles.adCard} onPress={handleWatchAd}>
                            <Text style={styles.adText}>📺 {t('watchAd')}</Text>
                        </TouchableOpacity>

                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.8)',
        justifyContent: 'flex-end',
    },
    modal: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        height: '80%',
        padding: spacing.md,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.onSurface,
    },
    close: {
        fontSize: 24,
        color: colors.onSurfaceVariant,
        padding: 4,
    },
    content: {
        paddingBottom: spacing.xl,
    },
    balanceContainer: {
        alignItems: 'center',
        marginBottom: spacing.lg,
        backgroundColor: colors.background,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
    },
    balanceLabel: {
        color: colors.onSurfaceVariant,
        marginBottom: 4,
    },
    balanceValue: {
        fontSize: 32,
        fontWeight: 'bold',
        color: '#FFD700',
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
        marginTop: spacing.md,
    },
    packageCard: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: colors.primaryContainer,
    },
    popularCard: {
        borderColor: '#FFD700',
        backgroundColor: 'rgba(255, 215, 0, 0.05)',
    },
    packageTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: colors.onSurface,
    },
    packageSub: {
        color: colors.onSurfaceVariant,
        marginTop: 2,
    },
    buyBtn: {
        backgroundColor: colors.primary,
        color: 'white',
        fontWeight: 'bold',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: borderRadius.md,
        overflow: 'hidden',
    },
    badge: {
        position: 'absolute',
        top: -10,
        right: 10,
        backgroundColor: '#FFD700',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
    },
    badgeText: {
        fontSize: 10,
        fontWeight: 'bold',
        color: 'black',
    },
    adCard: {
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.primaryContainer,
        borderStyle: 'dashed',
    },
    adText: {
        color: colors.primary,
        fontWeight: 'bold',
        fontSize: 16,
    }
});
