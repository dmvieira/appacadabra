import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ManaState {
    balance: number;
    isShopOpen: boolean;

    // Actions
    addMana: (amount: number) => void;
    deductMana: (amount: number) => boolean;
    resetMana: () => void;
    setBalance: (amount: number) => void; // For restore
    openShop: () => void;
    closeShop: () => void;
}

export const MANA_COSTS = {
    // 1 Mana per 5000 tokens
    TOKENS_PER_MANA: 5000,

    // Minimums checks (just to allow start)
    MIN_REQUIRED: 0.1,
};

export const calculateManaCost = (totalTokens: number): number => {
    return totalTokens / MANA_COSTS.TOKENS_PER_MANA;
};

export const useManaStore = create<ManaState>()(
    persist(
        (set, get) => ({
            balance: 100, // Initial welcome bonus
            isShopOpen: false,

            addMana: (amount: number) => {
                set((state) => ({ balance: state.balance + amount }));
            },

            deductMana: (amount: number) => {
                const currentBalance = get().balance;
                if (currentBalance >= amount) {
                    set({ balance: currentBalance - amount });
                    return true;
                }
                return false;
            },

            resetMana: () => {
                set({ balance: 100 });
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
