import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as firebase from './firebase';
import { getCurrentLanguage } from './i18n';

interface ManaState {
    balance: number;
    isShopOpen: boolean;
    requiredMana: number | null;
    userEmail: string | null;
    isAnonymous: boolean;

    // Actions
    init: () => void; // Start listening
    setBalance: (amount: number) => void;
    refreshUser: () => Promise<void>;
    openShop: (requiredMana?: number) => void;
    closeShop: () => void;

    // Legacy support (redirects to firebase logging)
    addMana: (amount: number) => void;
}



export const useManaStore = create<ManaState>()(
    persist(
        (set, get) => ({
            balance: 0,
            isShopOpen: false,
            requiredMana: null,
            userEmail: null,
            isAnonymous: true,

            init: () => {
                try {
                    console.log('ManaStore: Initializing firebase sync...');

                    // Test mode (dev/E2E only): if a credit amount is injected via AsyncStorage,
                    // skip Firebase sync so automated E2E tests can run without Google Sign-In.
                    AsyncStorage.getItem('appacadabra_test_credits').then(testCredits => {
                        if (__DEV__ && testCredits !== null) {
                            console.log('ManaStore: Test mode — using injected credits:', testCredits);
                            set({ balance: parseInt(testCredits, 10) });
                            // Seed Firestore users/{uid} so Cloud Function accepts spell creation.
                            // addCredits with a uid-scoped purchaseToken is idempotent — runs once per uid.
                            firebase.ensureAuthenticated().then(() => {
                                const uid = firebase.getCurrentUserId();
                                if (uid) {
                                    const amount = parseInt(testCredits, 10);
                                    firebase.addCredits(amount, 'e2e_test', `e2e_seed_${uid}`)
                                        .catch(e => console.log('ManaStore: Test seed skipped (already seeded):', e?.message));
                                }
                            }).catch(() => {});
                            return;
                        }

                        // Listen for Auth changes first
                        firebase.onAuthStateChanged((userId) => {
                            const user = firebase.getCurrentUser();
                            set({
                                userEmail: user?.email || null,
                                isAnonymous: user?.isAnonymous ?? true
                            });

                            if (userId) {
                                console.log('ManaStore: User authenticated, listening to credits for', userId);

                                // Register background push token for this device
                                firebase.registerAndSavePushTokenAsync(userId, getCurrentLanguage()).catch(e => {
                                    console.warn('ManaStore: Failed to register push token', e);
                                });

                                // Setup credits listener
                                firebase.onCreditsChanged((credits) => {
                                    console.log('ManaStore: Balance updated:', credits);
                                    set({ balance: credits });
                                }, userId);

                                // Force a fetch as well
                                firebase.getCredits().then(credits => {
                                    set({ balance: credits });
                                }).catch(e => console.log('ManaStore: Fetch failed', e));

                            } else {
                                console.log('ManaStore: User not authenticated, resetting balance');
                                set({ balance: 0 });
                            }
                        });
                    });
                } catch (e) {
                    console.error('ManaStore: Firebase init failed, proceeding offline:', e);
                }
            },

            addMana: (amount: number) => {
                // This is now handled by the server or specific ad/purchase logic
                // But for optimistic UI, we could update, but better wait for sync.
                console.warn('ManaStore: addMana called locally. Should call firebase.addCredits instead.');
            },



            setBalance: (amount: number) => {
                set({ balance: amount });
            },

            refreshUser: async () => {
                console.log('ManaStore: Refreshing user state...');
                const user = firebase.getCurrentUser();
                const { reload: reloadUser } = await import('@react-native-firebase/auth');
                if (user) await reloadUser(user);
                const updatedUser = firebase.getCurrentUser();
                set({
                    userEmail: updatedUser?.email || null,
                    isAnonymous: updatedUser?.isAnonymous ?? true
                });
            },

            openShop: (requiredMana?: number) => set({ isShopOpen: true, requiredMana: requiredMana ?? null }),
            closeShop: () => set({ isShopOpen: false, requiredMana: null }),
        }),
        {
            name: 'appacadabra-mana-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);

