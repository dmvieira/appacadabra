import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator, ToastAndroid } from 'react-native';
import { useManaStore } from '../lib/manaStore';
import { t } from '../lib/i18n';
import { colors, borderRadius, spacing } from '../lib/theme';
import * as firebase from '../lib/firebase';
import { RewardedAd, RewardedAdEventType, AdEventType } from 'react-native-google-mobile-ads';
// import * as iap from '../lib/iapService';

// Production Ad Unit ID (always use real ads)
const REWARDED_AD_UNIT_ID = 'ca-app-pub-2256826632523784/9261189872';


// Conversion rate: 1 mana = $0.09 USD
// Formula: mana = revenueUSD / 0.09
const MANA_COST_USD = 0.09;

// Maximum mana reward cap (to prevent exploits)
const MAX_MANA_REWARD = 5;

interface IAPProduct {
    productId: string;
    title: string;
    description: string;
    price: string;
    localizedPrice: string;
    currency: string;
    manaAmount: number;
}

// Fallback products if Play Store fetch fails
const FALLBACK_PRODUCTS: IAPProduct[] = [
    { productId: 'mana_10', title: '10 Mana ⚡', description: '', price: '4.90', localizedPrice: 'R$ 4,90', currency: 'BRL', manaAmount: 10 },
    { productId: 'mana_50', title: '50 Mana ⚡', description: '', price: '19.90', localizedPrice: 'R$ 19,90', currency: 'BRL', manaAmount: 50 },
    { productId: 'mana_120', title: '120 Mana ⚡', description: '', price: '44.90', localizedPrice: 'R$ 44,90', currency: 'BRL', manaAmount: 120 },
];


export function ManaShop() {
    const { addMana, balance, isShopOpen, closeShop } = useManaStore();
    const [isAdLoading, setIsAdLoading] = useState(false);
    const [rewardedAd, setRewardedAd] = useState<RewardedAd | null>(null);

    // IAP State
    const [products, setProducts] = useState<IAPProduct[]>(FALLBACK_PRODUCTS);
    const [isPurchasing, setIsPurchasing] = useState(false);
    // const [iapInitialized, setIapInitialized] = useState(false);

    // Track the revenue earned from the current ad impression
    const adRevenueRef = useRef<number>(0);

    // Load a new rewarded ad when shop opens
    useEffect(() => {
        if (isShopOpen) {
            loadRewardedAd();
        }
        return () => {
            // Cleanup ad listeners when shop closes
            if (rewardedAd) {
                rewardedAd.removeAllListeners();
            }
        };
    }, [isShopOpen]);

    const loadRewardedAd = () => {
        // Reset revenue for new ad
        adRevenueRef.current = 0;

        const ad = RewardedAd.createForAdRequest(REWARDED_AD_UNIT_ID, {
            requestNonPersonalizedAdsOnly: true,
        });

        const unsubscribeLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
            console.log('Rewarded ad loaded');
            setRewardedAd(ad);
            setIsAdLoading(false);
        });

        // Listen to paid events to get actual revenue
        const unsubscribePaid = ad.addAdEventListener(AdEventType.PAID, (event: any) => {
            if (!event) return;
            // event contains: value (micros), currency, precision
            const revenueUSD = (event.value || 0) / 1_000_000; // Convert micros to dollars
            adRevenueRef.current = revenueUSD;
            console.log(`Ad Paid Event: $${revenueUSD.toFixed(6)} USD (precision: ${event.precision || 'unknown'})`);
        });

        const unsubscribeEarned = ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, async (reward) => {
            console.log('User earned reward:', reward);

            // Calculate mana based on actual revenue (no fallback - if ad didn't pay, user gets 0)
            let manaToGive = adRevenueRef.current / MANA_COST_USD;

            // Apply max bound
            if (manaToGive > MAX_MANA_REWARD) {
                manaToGive = MAX_MANA_REWARD;
            }

            // Round to 2 decimal places
            manaToGive = Math.round(manaToGive * 100) / 100;

            console.log(`Giving ${manaToGive} mana (revenue: $${adRevenueRef.current.toFixed(4)})`);

            try {
                // Only add credits if there's something to add
                if (manaToGive > 0) {
                    await firebase.addCredits(manaToGive, 'ad_reward');
                }

                // Festive messages based on mana amount
                let toastMessage = '';

                if (manaToGive >= 1) {
                    toastMessage = `🎉🔥 ${t('rewardAmazing')} +${manaToGive.toFixed(2)} Mana!`;
                } else if (manaToGive >= 0.5) {
                    toastMessage = `🎉 ${t('rewardGreat')} +${manaToGive.toFixed(2)} Mana!`;
                } else if (manaToGive > 0) {
                    toastMessage = `⚡ ${t('rewardNice')} +${manaToGive.toFixed(2)} Mana!`;
                } else {
                    toastMessage = `👀 ${t('rewardNone')}`;
                }

                ToastAndroid.show(toastMessage, ToastAndroid.LONG);

            } catch (error) {
                console.error('Failed to add reward:', error);
                ToastAndroid.show(t('rewardError'), ToastAndroid.SHORT);
            }

        });

        const unsubscribeClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
            console.log('Ad closed, loading new ad');
            // Load a new ad for next time
            loadRewardedAd();
        });

        const unsubscribeError = ad.addAdEventListener(AdEventType.ERROR, (error) => {
            console.error('Rewarded ad error:', error);
            setIsAdLoading(false);
            setRewardedAd(null);
        });

        setIsAdLoading(true);
        ad.load();

        // Return cleanup function
        return () => {
            unsubscribeLoaded();
            unsubscribePaid();
            unsubscribeEarned();
            unsubscribeClosed();
            unsubscribeError();
        };
    };


    if (!isShopOpen) return null;

    const handlePurchase = async (productId: string) => {
        const product = products.find(p => p.productId === productId);
        if (!product) return;

        const amount = product.manaAmount;

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
        if (rewardedAd && rewardedAd.loaded) {
            rewardedAd.show();
        } else if (!isAdLoading) {
            // Start loading if not already loading
            loadRewardedAd();
        }
        // If already loading, do nothing - UI shows loading state
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

                        {products.map((product, index) => (
                            <TouchableOpacity
                                key={product.productId}
                                style={[
                                    styles.packageCard,
                                    index === 1 && styles.popularCard,
                                    isPurchasing && styles.disabledCard
                                ]}
                                onPress={() => handlePurchase(product.productId)}
                                disabled={isPurchasing}
                            >
                                <View>
                                    <Text style={styles.packageTitle}>{product.manaAmount} Mana ⚡</Text>
                                    <Text style={styles.packageSub}>{product.localizedPrice}</Text>
                                </View>
                                {index === 1 && (
                                    <View style={styles.badge}>
                                        <Text style={styles.badgeText}>POPULAR</Text>
                                    </View>
                                )}
                                {isPurchasing ? (
                                    <ActivityIndicator size="small" color={colors.primary} />
                                ) : (
                                    <Text style={styles.buyBtn}>{product.localizedPrice}</Text>
                                )}
                            </TouchableOpacity>
                        ))}

                        <Text style={styles.sectionTitle}>{t('freeMana')}</Text>
                        <TouchableOpacity
                            style={[styles.adCard, isAdLoading && styles.adCardLoading]}
                            onPress={handleWatchAd}
                            disabled={isAdLoading}
                        >
                            {isAdLoading ? (
                                <View style={styles.adLoadingRow}>
                                    <ActivityIndicator size="small" color={colors.primary} />
                                    <Text style={styles.adLoadingText}>{t('adLoading')}</Text>
                                </View>
                            ) : rewardedAd && rewardedAd.loaded ? (
                                <Text style={styles.adText}>📺 {t('watchAd')}</Text>
                            ) : (
                                <Text style={styles.adTextRetry}>📺 {t('watchAd')} — {t('tapToLoad')}</Text>
                            )}
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
    disabledCard: {
        opacity: 0.6,
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
    adCardLoading: {
        opacity: 0.7,
    },
    adText: {
        color: colors.primary,
        fontWeight: 'bold',
        fontSize: 16,
    },
    adTextRetry: {
        color: colors.onSurfaceVariant,
        fontWeight: 'bold',
        fontSize: 16,
    },
    adLoadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    adLoadingText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    }
});
