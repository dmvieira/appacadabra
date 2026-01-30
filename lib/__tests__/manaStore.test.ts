/**
 * Unit tests for manaStore.ts
 */

import { useManaStore } from '../manaStore';

// Mock Firebase
jest.mock('../firebase', () => ({
    onAuthStateChanged: jest.fn(),
    onCreditsChanged: jest.fn(),
    getCredits: jest.fn(() => Promise.resolve(100)),
}));

describe('manaStore', () => {
    beforeEach(() => {
        // Reset store state before each test
        useManaStore.setState({ balance: 0, isShopOpen: false });
    });

    describe('initial state', () => {
        it('should have balance of 0', () => {
            const state = useManaStore.getState();
            expect(state.balance).toBe(0);
        });

        it('should have shop closed', () => {
            const state = useManaStore.getState();
            expect(state.isShopOpen).toBe(false);
        });
    });

    describe('setBalance', () => {
        it('should update the balance', () => {
            useManaStore.getState().setBalance(100);
            expect(useManaStore.getState().balance).toBe(100);
        });

        it('should handle zero balance', () => {
            useManaStore.getState().setBalance(50);
            useManaStore.getState().setBalance(0);
            expect(useManaStore.getState().balance).toBe(0);
        });
    });

    describe('openShop', () => {
        it('should open the shop modal', () => {
            expect(useManaStore.getState().isShopOpen).toBe(false);
            useManaStore.getState().openShop();
            expect(useManaStore.getState().isShopOpen).toBe(true);
        });
    });

    describe('closeShop', () => {
        it('should close the shop modal', () => {
            useManaStore.getState().openShop();
            expect(useManaStore.getState().isShopOpen).toBe(true);
            useManaStore.getState().closeShop();
            expect(useManaStore.getState().isShopOpen).toBe(false);
        });
    });

    describe('addMana', () => {
        it('should log a warning (handled by server)', () => {
            const consoleSpy = jest.spyOn(console, 'warn');
            useManaStore.getState().addMana(10);
            expect(consoleSpy).toHaveBeenCalled();
        });
    });
});
