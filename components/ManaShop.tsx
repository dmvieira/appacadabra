import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator, ToastAndroid, Platform } from 'react-native';
import * as Application from 'expo-application';
import { useManaStore } from '../lib/manaStore';
import { useAppStore } from '../lib/store';
import { t } from '../lib/i18n';
import { colors, borderRadius, spacing } from '../lib/theme';
import * as firebase from '../lib/firebase';
import { RewardedAd, RewardedAdEventType, AdEventType } from 'react-native-google-mobile-ads';
import * as iap from '../lib/iapService';
import { logManaEarned, logShopOpened, logAdStarted, logAdPaidTimeout, logAdLoadFailed, logAdClosedEarly, logIapInitiated, logIapCancelled, logIapFailed, logIapCreditFailed } from '../lib/analytics';

// Production Ad Unit ID (always use real ads)
const REWARDED_AD_UNIT_ID = 'ca-app-pub-2256826632523784/9261189872';


// Conversion rate: 1 mana = $0.27 USD (based on mana_10 gross price of $2.69, net after fees)
// Formula: mana = revenueUSD / 0.27
const MANA_COST_USD = 0.27;

// Maximum mana reward cap (to prevent exploits)
const MAX_MANA_REWARD = 1;

// How long to wait for the AdMob PAID event before giving up (ms)
// Fixes race condition where EARNED_REWARD fires before PAID
const PAID_EVENT_WAIT_MS = 2000;

// Mana granted when PAID event never arrives (user watched the full ad)
const MIN_MANA_FALLBACK = 0.05;

interface IAPProduct {
    productId: string;
    title: string;
    description: string;
    price: string;
    localizedPrice: string;
    currency: string;
    manaAmount: number;
}



export function ManaShop() {
    const { addMana, balance, isShopOpen, requiredMana, closeShop, isAnonymous, userEmail, refreshUser } = useManaStore();
    const setStatusMessage = useAppStore(state => state.setStatusMessage);
    const [isAdLoading, setIsAdLoading] = useState(false);
    const [isProcessingReward, setIsProcessingReward] = useState(false);
    const [rewardedAd, setRewardedAd] = useState<RewardedAd | null>(null);

    // IAP State
    const [products, setProducts] = useState<IAPProduct[]>([]);
    const productsRef = useRef<IAPProduct[]>([]);
    const [isLoadingProducts, setIsLoadingProducts] = useState(false);
    const [isPurchasing, setIsPurchasing] = useState(false);
    const [purchaseStatus, setPurchaseStatus] = useState<'idle' | 'crediting' | 'refunding'>('idle');
    // const [iapInitialized, setIapInitialized] = useState(false);

    // Track the revenue earned from the current ad impression
    const adRevenueRef = useRef<number>(0);
    // Unique ID per impression — passed as purchaseToken to deduplicate on the backend
    const impressionIdRef = useRef<string | null>(null);
    // Tracks whether the user earned the reward (to detect early close)
    const earnedRewardRef = useRef<boolean>(false);



    // Load IAP and Ads when shop opens
    useEffect(() => {
        if (isShopOpen) {
            setStatusMessage('');
            if (isAnonymous) setShowLoginPrompt(true);
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

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const setupListeners = () => {
        iap.setupPurchaseListeners(
            async (purchase: any, productId: string) => {
                // Use the static map so pending purchases from previous sessions
                // work even if productsRef hasn't loaded yet.
                const amount = iap.PRODUCT_MANA_AMOUNTS[productId] ?? 0;

                if (amount > 0) {
                    const delays = [0, 2000, 4000];
                    let credited = false;

                    setPurchaseStatus('crediting');

                    for (let attempt = 0; attempt < delays.length; attempt++) {
                        if (delays[attempt] > 0) await sleep(delays[attempt]);
                        try {
                            await firebase.ensureAuthenticated();
                            await firebase.addCredits(amount, 'iap_purchase', purchase.purchaseToken);
                            logManaEarned('iap_purchase', amount);
                            credited = true;
                            break;
                        } catch (error) {
                            console.error(`Failed to credit mana (attempt ${attempt + 1}):`, error);
                        }
                    }

                    if (credited) {
                        // Acknowledge ONLY after credits are confirmed — correct IAP order.
                        try {
                            await iap.finishTransaction({ purchase, isConsumable: true });
                        } catch (finishErr) {
                            console.warn('[IAP] finishTransaction failed (non-critical):', finishErr);
                        }
                        setPurchaseStatus('idle');
                        setIsPurchasing(false);
                        Alert.alert(t('success'), t('purchaseSuccess', { amount }));
                        closeShop();
                    } else {
                        // Do NOT acknowledge — Google Play auto-refunds in ~3 days.
                        // Also attempt immediate refund as best-effort.
                        logIapCreditFailed(productId);
                        setPurchaseStatus('refunding');
                        try {
                            await firebase.voidPurchase(purchase.purchaseToken, productId);
                        } catch (refundError) {
                            console.error('Immediate refund failed (auto-refund in 3 days):', refundError);
                        }
                        setPurchaseStatus('idle');
                        setIsPurchasing(false);
                        Alert.alert(t('purchaseRefundedTitle'), t('purchaseRefundedMessage'));
                        closeShop();
                    }
                } else {
                    setIsPurchasing(false);
                }
            },
            (error: any) => {
                setIsPurchasing(false);
                if (error.code === 'E_USER_CANCELLED') {
                    logIapCancelled('unknown');
                } else {
                    logIapFailed('unknown');
                    Alert.alert(t('error'), t('purchaseFailed'));
                }
            }
        );
    };

    const loadProducts = async () => {
        setIsLoadingProducts(true);
        try {
            const fetchedProducts = await iap.fetchProducts();
            if (fetchedProducts && fetchedProducts.length > 0) {
                // Map IAP products to our internal format
                const mappedProducts: IAPProduct[] = fetchedProducts.map((p: any) => {
                    // Determine mana amount based on product ID
                    // Handle both id and productId as property names may vary by platform/version
                    const id = p.productId || p.id;
                    let manaAmount = 0;

                    if (id) {
                        if (id.includes('10')) manaAmount = 10;
                        else if (id.includes('50')) manaAmount = 50;
                        else if (id.includes('120')) manaAmount = 120;
                    }

                    return {
                        productId: id || '',
                        title: p.title || '', // Use title from store
                        description: p.description || '',
                        price: p.price || '',
                        localizedPrice: p.localizedPrice || p.displayPrice || '',
                        currency: p.currency || '',
                        manaAmount: manaAmount
                    };
                }).sort((a, b) => a.manaAmount - b.manaAmount);

                setProducts(mappedProducts);
                productsRef.current = mappedProducts;
            }
        } finally {
            setIsLoadingProducts(false);
        }
    };

    const loadRewardedAd = () => {
        // Reset per-impression state
        adRevenueRef.current = 0;
        earnedRewardRef.current = false;

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
            earnedRewardRef.current = true;
            const impressionId = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            impressionIdRef.current = impressionId;
            setIsProcessingReward(true);

            // Wait for PAID event if it hasn't arrived yet (race condition fix)
            // The PAID event can fire AFTER EARNED_REWARD; without this wait
            // adRevenueRef would be 0 and the user would get no mana.
            if (adRevenueRef.current <= 0) {
                console.log('PAID event not received yet, waiting up to', PAID_EVENT_WAIT_MS, 'ms...');
                const waitStart = Date.now();
                while (adRevenueRef.current <= 0 && (Date.now() - waitStart) < PAID_EVENT_WAIT_MS) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                console.log(`Wait finished after ${Date.now() - waitStart}ms. Revenue: $${adRevenueRef.current.toFixed(6)}`);
            }

            // Calculate mana: use revenue if PAID arrived, otherwise give fallback
            let manaToGive: number;
            if (adRevenueRef.current > 0) {
                manaToGive = adRevenueRef.current / MANA_COST_USD;
                if (manaToGive > MAX_MANA_REWARD) manaToGive = MAX_MANA_REWARD;
                manaToGive = Math.round(Math.max(manaToGive, MIN_MANA_FALLBACK) * 100) / 100;
            } else {
                logAdPaidTimeout();
                manaToGive = MIN_MANA_FALLBACK;
            }

            console.log(`Giving ${manaToGive} mana (revenue: $${adRevenueRef.current.toFixed(4)})`);

            try {
                // Only add credits if there's something to add
                if (manaToGive > 0) {
                    await firebase.addCredits(manaToGive, 'ad_reward', impressionId);
                    logManaEarned('ad_reward', manaToGive, adRevenueRef.current);
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

                setRewardBanner({ message: toastMessage, type: manaToGive > 0 ? 'success' : 'error' });
                // Hide banner after 5 seconds
                setTimeout(() => setRewardBanner(null), 5000);
                // Global toast — persists after modal closes, cross-platform
                setStatusMessage(toastMessage);

            } catch (error) {
                console.error('Failed to add reward:', error);
                setRewardBanner({ message: t('rewardError'), type: 'error' });
                setStatusMessage(t('rewardError'));
            } finally {
                setIsProcessingReward(false);
            }

        });

        const unsubscribeClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
            console.log('Ad closed, loading new ad');
            if (!earnedRewardRef.current) {
                logAdClosedEarly();
            }
            loadRewardedAd();
        });

        const unsubscribeError = ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
            console.error('Rewarded ad error:', error);
            logAdLoadFailed(String(error?.code ?? 'unknown'));
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
        logIapInitiated(productId);
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
                logIapCancelled(productId);
                ToastAndroid.show(t('purchaseCancelled'), ToastAndroid.SHORT);
            } else {
                logIapFailed(productId);
                Alert.alert(t('error'), t('purchaseFailed'));
            }
        }
    };

    const handleWatchAd = async () => {
        if (rewardedAd && rewardedAd.loaded) {
            logAdStarted();
            rewardedAd.show();
        } else if (!isAdLoading) {
            // Start loading if not already loading
            loadRewardedAd();
        }
        // If already loading, do nothing - UI shows loading state
    };
    // Login prompt state
    const [showLoginPrompt, setShowLoginPrompt] = useState(false);
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [rewardBanner, setRewardBanner] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    const closeShopWithCleanup = () => {
        setRewardBanner(null);
        setShowLoginPrompt(false);
        closeShop();
    };

    const handleLoginRequired = () => {
        setShowLoginPrompt(true);
    };

    async function getHardwareId(): Promise<string> {
        if (Platform.OS === 'android') {
            return Application.getAndroidId() ?? '';
        } else {
            return (await Application.getIosIdForVendorAsync()) ?? '';
        }
    }

    const handleGoogleSignIn = async () => {
        setIsSigningIn(true);
        setLoginError(null);
        try {
            await firebase.ensureAuthenticated();
            await firebase.linkWithGoogle();
            await refreshUser();
            getHardwareId().then(id => {
                if (id) firebase.claimInstallBonus(id).catch(() => { });
            });
            setShowLoginPrompt(false);
        } catch (e: any) {
            console.error(e);
            setLoginError(e.message || t('linkError'));
        } finally {
            setIsSigningIn(false);
        }
    };

    return (
        <Modal visible={isShopOpen} transparent animationType="slide" onRequestClose={closeShop}>
            <View style={styles.overlay}>
                <View style={styles.modal}>
                    <View style={styles.header}>
                        <Text style={styles.title}>⚡ {t('manaShopTitle')}</Text>
                        <TouchableOpacity onPress={closeShopWithCleanup} accessibilityLabel={t('close')} accessibilityRole="button">
                            <Text style={styles.close}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    {(isPurchasing || isProcessingReward) && (
                        <View style={styles.purchasingOverlay}>
                            <ActivityIndicator size="large" color={colors.primary} />
                            <Text style={styles.purchasingText}>
                                {isProcessingReward
                                    ? t('processingReward')
                                    : purchaseStatus === 'crediting'
                                        ? t('creditingPurchase')
                                        : purchaseStatus === 'refunding'
                                            ? t('refundingPurchase')
                                            : t('processingPurchase')}
                            </Text>
                        </View>
                    )}
                    <ScrollView contentContainerStyle={styles.content}>
                        {rewardBanner && (
                            <TouchableOpacity
                                style={[styles.rewardBanner, rewardBanner.type === 'error' && styles.rewardBannerError]}
                                onPress={() => setRewardBanner(null)}
                            >
                                <Text style={styles.rewardBannerText}>{rewardBanner.message}</Text>
                            </TouchableOpacity>
                        )}
                        {showLoginPrompt ? (
                            /* ── Login Prompt ── */
                            <View style={styles.loginPromptContainer}>
                                <Text style={styles.loginPromptEmoji}>⚡</Text>
                                <Text style={styles.loginPromptTitle}>{t('loginRequired')}</Text>
                                <Text style={styles.loginPromptDesc}>{t('loginRequiredDesc')}</Text>

                                <TouchableOpacity
                                    style={styles.googleButton}
                                    onPress={handleGoogleSignIn}
                                    disabled={isSigningIn}
                                    accessibilityLabel={t('signInGoogle')}
                                    accessibilityRole="button"
                                >
                                    {isSigningIn ? (
                                        <ActivityIndicator size="small" color="#1a1a1a" />
                                    ) : (
                                        <Text style={styles.googleButtonText}>🔗 {t('signInGoogle')}</Text>
                                    )}
                                </TouchableOpacity>
                                {loginError && (
                                    <Text style={styles.loginError}>{loginError}</Text>
                                )}
                                <TouchableOpacity
                                    style={styles.cancelButton}
                                    onPress={() => setShowLoginPrompt(false)}
                                    accessibilityLabel={t('cancel')}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.cancelButtonText}>{t('cancel')}</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            /* ── Shop Content ── */
                            <>
                                {/* Balance + Account */}
                                <View style={styles.balanceRow}>
                                    <View>
                                        <Text style={styles.balanceLabel}>{t('currentBalance')}</Text>
                                        <Text style={styles.balanceValue}>
                                            {(Math.floor(balance * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ⚡
                                        </Text>
                                    </View>
                                    {isAnonymous ? (
                                        <TouchableOpacity style={styles.lockPill} onPress={handleLoginRequired}>
                                            <Text style={styles.lockPillText}>🔒 {t('noLogin')}</Text>
                                        </TouchableOpacity>
                                    ) : (
                                        <View style={styles.accountChip}>
                                            <Text style={styles.accountAvatar}>👤</Text>
                                            <Text style={styles.accountEmailText}>{userEmail || 'User'}</Text>
                                        </View>
                                    )}
                                </View>

                                {(requiredMana !== null && requiredMana > balance) ? (
                                    <View style={styles.manaWarningBanner}>
                                        <Text style={styles.manaWarningEmoji}>⚡</Text>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.manaWarningTitle}>{t('manaInsufficientTitle')}</Text>
                                            <Text style={styles.manaWarningText}>
                                                {t('manaInsufficientMessage', {
                                                    required: requiredMana.toFixed(1),
                                                    balance: balance.toFixed(1)
                                                })}
                                            </Text>
                                        </View>
                                    </View>
                                ) : balance <= 0 ? (
                                    <View style={styles.manaWarningBanner}>
                                        <Text style={styles.manaWarningEmoji}>⚡</Text>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.manaWarningTitle}>{t('manaDepletedTitle')}</Text>
                                            <Text style={styles.manaWarningText}>{t('manaDepletedMessage')}</Text>
                                        </View>
                                    </View>
                                ) : null}

                                {/* Free Mana Section */}
                                <Text style={styles.sectionLabel}>{t('freeMana')}</Text>
                                <TouchableOpacity
                                    style={[styles.adRow, isAnonymous && styles.disabledRow]}
                                    onPress={isAnonymous ? handleLoginRequired : handleWatchAd}
                                    disabled={!isAnonymous && isAdLoading}
                                    accessibilityLabel={t('watchAd')}
                                    accessibilityRole="button"
                                >
                                    <View style={styles.adIconWrap}>
                                        {isAdLoading && !isAnonymous ? (
                                            <ActivityIndicator size="small" color={colors.primary} />
                                        ) : (
                                            <Text style={{ fontSize: 16 }}>📺</Text>
                                        )}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.adLabel}>{t('watchAd')}</Text>
                                        <Text style={styles.adSub}>{t('freeMana')}</Text>
                                    </View>
                                    {isAnonymous ? (
                                        <View style={styles.lockBtn}>
                                            <Text style={styles.lockBtnText}>🔒 Login</Text>
                                        </View>
                                    ) : (
                                        <View style={styles.adActionBtn}>
                                            <Text style={styles.adActionBtnText}>{t('watchAd')}</Text>
                                        </View>
                                    )}
                                </TouchableOpacity>

                                {/* Buy Mana Section */}
                                <Text style={styles.sectionLabel}>{t('buyMana')}</Text>
                                {isLoadingProducts ? (
                                    <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: spacing.md }} />
                                ) : products.length === 0 ? (
                                    <Text style={styles.packageSub}>{t('productsUnavailable')}</Text>
                                ) : (
                                    products.map((product, index) => (
                                        <TouchableOpacity
                                            key={product.productId}
                                            style={[
                                                styles.packageCard,
                                                index === 1 && styles.popularCard,
                                                (isAnonymous || isPurchasing) && styles.disabledCard
                                            ]}
                                            onPress={isAnonymous ? handleLoginRequired : () => handlePurchase(product.productId)}
                                            disabled={!isAnonymous && isPurchasing}
                                            accessibilityLabel={product.manaAmount + ' Mana — ' + product.localizedPrice}
                                            accessibilityRole="button"
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
                                            {isAnonymous ? (
                                                <View style={styles.lockBtn}>
                                                    <Text style={styles.lockBtnText}>🔒 Login</Text>
                                                </View>
                                            ) : isPurchasing ? (
                                                <ActivityIndicator size="small" color={colors.primary} />
                                            ) : (
                                                <Text style={styles.buyBtn}>{product.localizedPrice}</Text>
                                            )}
                                        </TouchableOpacity>
                                    ))
                                )}
                            </>
                        )}
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

    // ── Balance Row ──
    balanceRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        backgroundColor: colors.background,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
    },
    balanceLabel: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        marginBottom: 3,
    },
    balanceValue: {
        fontSize: 24,
        fontWeight: 'bold' as const,
        color: '#FFD700',
    },

    // ── Lock Pill (anonymous) ──
    lockPill: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    lockPillText: {
        fontSize: 10,
        color: colors.onSurfaceVariant,
    },

    // ── Account Chip (logged in) ──
    accountChip: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        backgroundColor: colors.surfaceVariant,
        borderRadius: 20,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.07)',
    },
    accountAvatar: {
        fontSize: 12,
        marginRight: 5,
    },
    accountEmailText: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        flexShrink: 1,
    },

    // ── Section Label ──
    sectionLabel: {
        fontSize: 10,
        fontWeight: '700' as const,
        letterSpacing: 1,
        textTransform: 'uppercase' as const,
        color: colors.onSurfaceVariant,
        marginBottom: 8,
        marginTop: spacing.md,
    },

    // ── Ad Row ──
    adRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        backgroundColor: colors.background,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.07)',
        gap: 12,
    },
    disabledRow: {
        opacity: 0.45,
    },
    adIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(124,58,237,0.15)',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    adLabel: {
        fontSize: 13,
        fontWeight: '600' as const,
        color: colors.onSurface,
    },
    adSub: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        marginTop: 2,
    },
    adActionBtn: {
        marginLeft: 'auto' as any,
        backgroundColor: 'rgba(124,58,237,0.2)',
        borderWidth: 1,
        borderColor: 'rgba(124,58,237,0.3)',
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    adActionBtnText: {
        fontSize: 11,
        fontWeight: '700' as const,
        color: colors.primary,
    },

    // ── Lock Button ──
    lockBtn: {
        backgroundColor: 'rgba(255,255,255,0.07)',
        borderRadius: 9,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    lockBtnText: {
        fontSize: 12,
        fontWeight: '700' as const,
        color: colors.onSurfaceVariant,
    },

    // ── Package Cards ──
    packageCard: {
        flexDirection: 'row' as const,
        justifyContent: 'space-between' as const,
        alignItems: 'center' as const,
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
        opacity: 0.45,
    },
    packageTitle: {
        fontSize: 14,
        fontWeight: 'bold' as const,
        color: colors.onSurface,
    },
    packageSub: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    buyBtn: {
        backgroundColor: colors.primary,
        color: 'white',
        fontWeight: 'bold' as const,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: borderRadius.md,
        overflow: 'hidden' as const,
        fontSize: 12,
    },
    badge: {
        position: 'absolute' as const,
        top: -10,
        right: 10,
        backgroundColor: '#FFD700',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
    },
    badgeText: {
        fontSize: 9,
        fontWeight: 'bold' as const,
        color: 'black',
        letterSpacing: 0.5,
    },

    // ── Login Prompt ──
    loginPromptContainer: {
        alignItems: 'center' as const,
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.md,
    },
    loginPromptEmoji: {
        fontSize: 48,
        marginBottom: spacing.md,
    },
    loginPromptTitle: {
        fontSize: 18,
        fontWeight: 'bold' as const,
        color: colors.onSurface,
        textAlign: 'center' as const,
        marginBottom: spacing.sm,
    },
    loginPromptDesc: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
        textAlign: 'center' as const,
        lineHeight: 20,
        marginBottom: spacing.lg,
    },
    googleButton: {
        backgroundColor: '#FFFFFF',
        borderRadius: 11,
        paddingVertical: 13,
        paddingHorizontal: spacing.lg,
        width: '100%' as any,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        marginBottom: spacing.sm,
    },
    googleButtonText: {
        fontSize: 14,
        fontWeight: '600' as const,
        color: '#1a1a1a',
    },
    loginError: {
        fontSize: 13,
        color: colors.error,
        textAlign: 'center' as const,
        marginBottom: spacing.sm,
    },
    cancelButton: {
        paddingVertical: 8,
        width: '100%' as any,
        alignItems: 'center' as const,
    },
    cancelButtonText: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
    },

    // ── Mana Warning ──
    manaWarningBanner: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        backgroundColor: colors.error + '15',
        marginBottom: spacing.lg,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: colors.error + '40',
    },
    manaWarningEmoji: {
        fontSize: 24,
        marginEnd: spacing.md,
    },
    manaWarningTitle: {
        fontSize: 14,
        fontWeight: 'bold' as const,
        color: colors.error,
    },
    manaWarningText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    // ── Purchasing Overlay ──
    purchasingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.75)',
        alignItems: 'center',
        justifyContent: 'center',
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        zIndex: 10,
        gap: 16,
    },
    purchasingText: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '600',
    },

    // ── Reward Banner ──
    rewardBanner: {
        backgroundColor: colors.success + '25',
        borderColor: colors.success + '50',
        borderWidth: 1,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
        alignItems: 'center',
    },
    rewardBannerError: {
        backgroundColor: colors.error + '25',
        borderColor: colors.error + '50',
    },
    rewardBannerText: {
        color: colors.onSurface,
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
    },
});

