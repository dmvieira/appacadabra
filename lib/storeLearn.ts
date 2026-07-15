import * as firebase from './firebase';
import { useStoreSyncStore } from './storeSync';

export interface LearnStoreSpellResult {
    ok: boolean;
    alreadyLearned?: boolean;
}

/**
 * Shared "learn a Store spell" flow: links Google if needed, calls the
 * `learnSpell` callable, then triggers a targeted sync that downloads the HTML
 * and inserts the row into SQLite via `syncLearnedSpells({ forceSpellId })`.
 * Callers are responsible for their own optimistic UI state.
 */
export async function learnStoreSpell(spellId: string): Promise<LearnStoreSpellResult> {
    if (!firebase.isGoogleUser()) {
        await firebase.linkWithGoogle();
    }
    const learnRes = await firebase.learnSpell(spellId);
    await useStoreSyncStore.getState().syncLearnedSpells({
        triggeredByDeepLink: true,
        forceSpellId: spellId,
    });
    return { ok: true, alreadyLearned: learnRes.alreadyLearned };
}
