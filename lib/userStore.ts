/**
 * Reactive auth-state store. Replaces the `isAnonymous`/`userEmail` slice that
 * used to live in the now-deleted `manaStore`. Subscribes once to Firebase auth
 * on `init()` and projects the user identity into Zustand so React components
 * can re-render when the user signs in or out.
 *
 * Keep this store tiny — anything beyond auth identity belongs elsewhere.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as firebase from './firebase';
import { getCurrentLanguage } from './i18n';

interface UserState {
    userEmail: string | null;
    isAnonymous: boolean;

    init: () => void;
    refreshUser: () => Promise<void>;
}

export const useUserStore = create<UserState>()(
    persist(
        (set) => ({
            userEmail: null,
            isAnonymous: true,

            init: () => {
                try {
                    firebase.onAuthStateChanged((userId) => {
                        const user = firebase.getCurrentUser();
                        set({
                            userEmail: user?.email || null,
                            isAnonymous: user?.isAnonymous ?? true,
                        });
                        if (userId) {
                            firebase.registerAndSavePushTokenAsync(userId, getCurrentLanguage()).catch(e => {
                                console.warn('UserStore: Failed to register push token', e);
                            });
                        }
                    });
                } catch (e) {
                    console.error('UserStore: init failed:', e);
                }
            },

            refreshUser: async () => {
                const user = firebase.getCurrentUser();
                const { reload: reloadUser } = await import('@react-native-firebase/auth');
                if (user) await reloadUser(user);
                const updated = firebase.getCurrentUser();
                set({
                    userEmail: updated?.email || null,
                    isAnonymous: updated?.isAnonymous ?? true,
                });
            },
        }),
        {
            name: 'appacadabra-user-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
