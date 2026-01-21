import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as firebase from './firebase';

interface ManaState {
    balance: number;
    isShopOpen: boolean;

    // Actions
    init: () => void; // Start listening
    setBalance: (amount: number) => void;
    openShop: () => void;
    closeShop: () => void;

    // Legacy support (redirects to firebase logging)
    addMana: (amount: number) => void;
}



export const useManaStore = create<ManaState>()(
    persist(
        (set, get) => ({
            balance: 0,
            isShopOpen: false,

            init: () => {
                console.log('ManaStore: Initializing firebase sync...');

                // Listen for Auth changes first
                firebase.onAuthStateChanged((userId) => {
                    if (userId) {
                        console.log('ManaStore: User authenticated, listening to credits for', userId);
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
                        console.log('ManaStore: User not authenticated yet');
                    }
                });
            },

            addMana: (amount: number) => {
                // This is now handled by the server or specific ad/purchase logic
                // But for optimistic UI, we could update, but better wait for sync.
                console.warn('ManaStore: addMana called locally. Should call firebase.addCredits instead.');
            },



            setBalance: (amount: number) => {
                set({ balance: amount });
            },

            openShop: () => set({ isShopOpen: true }),
            closeShop: () => set({ isShopOpen: false }),
        }),
        {
            name: 'appacadabra-mana-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);

