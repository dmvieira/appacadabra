import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator, ToastAndroid } from 'react-native';
import { useManaStore } from '../lib/manaStore';
import { t } from '../lib/i18n';
import { colors, borderRadius, spacing } from '../lib/theme';
import * as firebase from '../lib/firebase';
import { RewardedAd, RewardedAdEventType, AdEventType } from 'react-native-google-mobile-ads';
import * as iap from '../lib/iapService';

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
    { productId: 'mana_10', title: t('manaPackage1') + ' ⚡', description: '', price: '4.90', localizedPrice: 'R$ 4,90', currency: 'BRL', manaAmount: 10 },
    { productId: 'mana_50', title: t('manaPackage2') + ' ⚡', description: '', price: '19.90', localizedPrice: 'R$ 19,90', currency: 'BRL', manaAmount: 50 },
    { productId: 'mana_120', title: t('manaPackage3') + ' ⚡', description: '', price: '44.90', localizedPrice: 'R$ 44,90', currency: 'BRL', manaAmount: 120 },
];


export function ManaShop() {
    const { addMana, balance, isShopOpen, closeShop, isAnonymous, userEmail, refreshUser } = useManaStore();
    const [isAdLoading, setIsAdLoading] = useState(false);
    const [rewardedAd, setRewardedAd] = useState<RewardedAd | null>(null);

    // IAP State
    const [products, setProducts] = useState<IAPProduct[]>(FALLBACK_PRODUCTS);
    const [isPurchasing, setIsPurchasing] = useState(false);
    // const [iapInitialized, setIapInitialized] = useState(false);

    // Track the revenue earned from the current ad impression
    const adRevenueRef = useRef<number>(0);



    // Load IAP and Ads when shop opens
    useEffect(() => {
        if (isShopOpen) {
            loadRewardedAd();
            initializeIAP();
        }
        return () => {
            // Cleanup ad listeners when shop closes
            if (rewardedAd) {
                rewardedAd.removeAllListeners();
            }
            // Close IAP connection
            iap.closeConnection();
        };
    }, [isShopOpen]);

    const initializeIAP = async () => {
        const connected = await iap.initIAP();
        if (connected) {
            setupListeners();
            loadProducts();
        }
    };

    const setupListeners = () => {
        iap.setupPurchaseListeners(
            async (purchase: any, productId: string) => {
                // Determine mana amount from product ID
                const product = products.find(p => p.productId === productId);
                const amount = product ? product.manaAmount : 0; // Fallback if product not found

                setIsPurchasing(false); // Stop loading on success

                if (amount > 0) {
                    try {
                        await firebase.addCredits(amount, 'iap_purchase');
                        Alert.alert(t('success'), t('purchaseSuccess', { amount }));
                        closeShop();
                    } catch (error) {
                        console.error('Failed to credit mana:', error);
                        Alert.alert(t('error'), 'Purchase successful but failed to add mana. Please contact support.');
                    }
                }
            },
            (error: any) => {
                setIsPurchasing(false); // Stop loading on error
                if (error.code !== 'E_USER_CANCELLED') {
                    Alert.alert(t('error'), t('purchaseFailed'));
                }
            }
        );
    };

    const loadProducts = async () => {
        const fetchedProducts = await iap.fetchProducts();
        if (fetchedProducts && fetchedProducts.length > 0) {
            // Map IAP products to our internal format
            const mappedProducts: IAPProduct[] = fetchedProducts.map((p: any) => {
                // Determine mana amount based on product ID
                let manaAmount = 0;
                if (p.productId.includes('10')) manaAmount = 10;
                if (p.productId.includes('50')) manaAmount = 50;
                if (p.productId.includes('120')) manaAmount = 120;

                return {
                    productId: p.productId,
                    title: p.title, // Use title from store
                    description: p.description,
                    price: p.price,
                    localizedPrice: p.localizedPrice,
                    currency: p.currency,
                    manaAmount: manaAmount
                };
            }).sort((a, b: any) => a.manaAmount - b.manaAmount);

            setProducts(mappedProducts);
        }
    };

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

    const handlePurchase = async (productId: string) => {
        if (isPurchasing) return;

        setIsPurchasing(true);
        try {
            await iap.requestProductPurchase(productId);
            // NOTE: The purchase flow is async. The actual result (success or error) 
            // comes through the listeners setup in setupListeners().
            // We do NOT set isPurchasing(false) here because the modal is still open.
        } catch (error: any) {
            console.log('Purchase request failed:', error);
            setIsPurchasing(false);

            // Handle user cancellation specifically if it throws (depends on platform/version)
            if (error.code === 'E_USER_CANCELLED' || error.message.includes('User cancelled')) {
                // User cancelled, just stop loading
                ToastAndroid.show(t('purchaseCancelled'), ToastAndroid.SHORT);
            } else {
                Alert.alert(t('error'), t('purchaseFailed'));
            }
        }
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
                        {/* Account Section */}
                        <View style={styles.accountContainer}>
                            <Text style={styles.sectionTitle}>{t('account')}</Text>
                            {isAnonymous ? (
                                <TouchableOpacity
                                    style={styles.linkCard}
                                    onPress={async () => {
                                        try {
                                            // Ensure we have an anonymous user to link to
                                            await firebase.ensureAuthenticated();
                                            await firebase.linkWithGoogle();
                                            await refreshUser(); // Force UI update
                                            Alert.alert(t('success'), t('linkSuccess'));
                                        } catch (e: any) {
                                            console.error(e);
                                            if (e.message && (e.message.includes('credential-already-in-use') || e.code === 'auth/credential-already-in-use')) {
                                                Alert.alert(
                                                    t('account'), // Title
                                                    t('accountConflict'),
                                                    [
                                                        { text: t('cancel'), style: 'cancel' },
                                                        {
                                                            text: t('signInGoogle'), onPress: async () => {
                                                                try {
                                                                    await firebase.signInWithGoogle();
                                                                    await refreshUser(); // Force UI update
                                                                } catch (err) {
                                                                    Alert.alert(t('error'), t('signInFailed'));
                                                                }
                                                            }
                                                        }
                                                    ]
                                                );
                                            } else {
                                                Alert.alert(t('error'), t('linkError'));
                                            }
                                        }
                                    }}
                                >
                                    <View>
                                        <Text style={styles.linkTitle}>🔗 {t('linkAccount')}</Text>
                                        <Text style={styles.linkDesc}>{t('linkAccountDesc')}</Text>
                                    </View>
                                    <Text style={styles.arrow}>›</Text>
                                </TouchableOpacity>
                            ) : (
                                <View style={styles.accountCard}>
                                    <Text style={styles.accountEmail}>👤 {userEmail || 'User'}</Text>
                                    <TouchableOpacity onPress={() => firebase.signOut()}>
                                        <Text style={styles.signOutLink}>{t('signOut')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>

                        <View style={styles.balanceContainer}>
                            <Text style={styles.balanceLabel}>{t('currentBalance')}</Text>
                            <Text style={styles.balanceValue}>{(Math.floor(balance * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ⚡</Text>
                        </View>
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
    },
    accountContainer: {
        marginBottom: spacing.lg,
    },
    linkCard: {
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: colors.primary,
    },
    linkTitle: {
        color: colors.primary,
        fontWeight: 'bold',
        fontSize: 16,
    },
    linkDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    arrow: {
        fontSize: 24,
        color: colors.primary,
        fontWeight: 'bold',
        marginTop: -4,
    },
    accountCard: {
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    accountEmail: {
        color: colors.onSurface,
        fontWeight: 'bold',
    },
    signOutLink: {
        color: colors.error,
        fontWeight: 'bold',
    }
});
