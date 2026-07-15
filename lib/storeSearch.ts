import { create } from 'zustand';
import * as Localization from 'expo-localization';
import firebaseFirestore, { collection, query, where, orderBy, limit, getDocs } from '@react-native-firebase/firestore';
import { publicStorageUrl } from './firebase';

const CACHE_TTL_MS = 10 * 60 * 1000;
const WINDOW_SIZE = 100;

export interface StoreSearchItem {
    spellId: string;
    slug: string;
    name: string;
    description: string;
    authorName: string;
    iconUrl: string | null;
    learnCount: number;
}

interface StoreSearchState {
    items: StoreSearchItem[];
    loading: boolean;
    loadedAt: number | null;
    error: string | null;
    ensureLoaded: () => Promise<void>;
    filter: (query: string, excludeSpellIds: Set<string>) => StoreSearchItem[];
}

async function fetchWindow(): Promise<StoreSearchItem[]> {
    const firestore = firebaseFirestore();
    const q = query(
        collection(firestore, 'store_spells'),
        where('status', '==', 'active'),
        where('visibility', '==', 'public'),
        orderBy('learnCount', 'desc'),
        limit(WINDOW_SIZE),
    );
    const snap = await getDocs(q);
    const userLang = Localization.getLocales()[0]?.languageCode ?? 'en';
    return snap.docs.map((d: any) => {
        const data = d.data() as any;
        const meta = data?.translations?.[userLang]
            ?? data?.translations?.['en']
            ?? { name: data?.name, description: data?.description };
        return {
            spellId: d.id,
            slug: typeof data?.slug === 'string' ? data.slug : '',
            name: meta?.name ?? data?.name ?? 'Spell',
            description: meta?.description ?? data?.description ?? '',
            authorName: typeof data?.authorName === 'string' ? data.authorName : '',
            iconUrl: publicStorageUrl(data?.iconPath),
            learnCount: typeof data?.learnCount === 'number' ? data.learnCount : 0,
        };
    });
}

export const useStoreSearchStore = create<StoreSearchState>((set, get) => ({
    items: [],
    loading: false,
    loadedAt: null,
    error: null,

    ensureLoaded: async () => {
        const { loading, loadedAt } = get();
        if (loading) return;
        if (loadedAt !== null && Date.now() - loadedAt < CACHE_TTL_MS) return;
        set({ loading: true, error: null });
        try {
            const items = await fetchWindow();
            set({ items, loading: false, loadedAt: Date.now() });
        } catch (e: any) {
            console.warn('[StoreSearch] fetchWindow failed:', e?.message);
            set({ loading: false, error: e?.message ?? 'fetch failed' });
        }
    },

    filter: (queryStr, excludeSpellIds) => {
        const q = queryStr.trim().toLowerCase();
        if (!q) return [];
        return get().items.filter(item => {
            if (excludeSpellIds.has(item.spellId)) return false;
            return item.name.toLowerCase().includes(q)
                || item.description.toLowerCase().includes(q);
        });
    },
}));
