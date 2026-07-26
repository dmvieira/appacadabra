/**
 * Integration coverage for `upsertPricingSnapshot` + `getAllPricingSnapshots`.
 *
 * All other test suites mock these two db helpers. This one exercises the
 * actual SQL path through an in-memory shim that faithfully implements the
 * UPSERT semantics of `INSERT ... ON CONFLICT(modelId) DO UPDATE SET ...`
 * — the only guarantee callers rely on. Without this, the UPSERT clause
 * is only covered by grep-level confidence.
 *
 * Note: this uses an in-memory JS map rather than a real SQLite binary
 * because expo-sqlite has no node build; every existing db test in this
 * folder follows the same convention.
 */

import type { ModelPricingSnapshotRow } from '../db';

interface Row {
    modelId: string;
    name: string;
    pricingJson: string;
    firstSeenAt: number;
    updatedAt: number;
}

const mockRows = new Map<string, Row>();

jest.mock('expo-sqlite', () => ({
    openDatabaseAsync: jest.fn(() => Promise.resolve({
        execAsync: jest.fn(),
        runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
            const text = sql.toLowerCase();
            if (text.includes('insert into model_pricing_snapshot')
                && text.includes('on conflict(modelid) do update')) {
                const [modelId, name, pricingJson, firstSeenAt, updatedAt] = params as [
                    string, string, string, number, number,
                ];
                const existing = mockRows.get(modelId);
                if (existing) {
                    mockRows.set(modelId, {
                        modelId,
                        name,
                        pricingJson,
                        firstSeenAt: existing.firstSeenAt,
                        updatedAt,
                    });
                } else {
                    mockRows.set(modelId, { modelId, name, pricingJson, firstSeenAt, updatedAt });
                }
                return;
            }
        }),
        getAllAsync: jest.fn(async (sql: string) => {
            const text = sql.toLowerCase();
            if (text.includes('from model_pricing_snapshot')) {
                return Array.from(mockRows.values());
            }
            return [];
        }),
        getFirstAsync: jest.fn(async () => null),
        closeAsync: jest.fn(),
    })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../db') as {
    upsertPricingSnapshot: (modelId: string, name: string, pricingJson: string) => Promise<void>;
    getAllPricingSnapshots: () => Promise<ModelPricingSnapshotRow[]>;
};

beforeEach(() => {
    mockRows.clear();
});

describe('model_pricing_snapshot UPSERT', () => {
    it('inserts a fresh row when modelId has no existing entry', async () => {
        await db.upsertPricingSnapshot(
            'openai/o1',
            'OpenAI o1',
            JSON.stringify({ inputPerMToken: 15, outputPerMToken: 60 }),
        );
        const all = await db.getAllPricingSnapshots();
        expect(all).toHaveLength(1);
        expect(all[0].modelId).toBe('openai/o1');
        expect(all[0].name).toBe('OpenAI o1');
        expect(JSON.parse(all[0].pricingJson)).toEqual({
            inputPerMToken: 15,
            outputPerMToken: 60,
        });
        expect(typeof all[0].firstSeenAt).toBe('number');
        expect(typeof all[0].updatedAt).toBe('number');
    });

    it('preserves firstSeenAt on re-upsert (updates name/pricing/updatedAt only)', async () => {
        const originalNow = Date.now;
        try {
            Date.now = () => 1_000;
            await db.upsertPricingSnapshot(
                'openai/o1',
                'OpenAI o1',
                JSON.stringify({ inputPerMToken: 15, outputPerMToken: 60 }),
            );
            Date.now = () => 5_000;
            await db.upsertPricingSnapshot(
                'openai/o1',
                'OpenAI o1 (updated)',
                JSON.stringify({ inputPerMToken: 20, outputPerMToken: 80 }),
            );
            const all = await db.getAllPricingSnapshots();
            expect(all).toHaveLength(1);
            expect(all[0].name).toBe('OpenAI o1 (updated)');
            expect(JSON.parse(all[0].pricingJson).inputPerMToken).toBe(20);
            expect(all[0].firstSeenAt).toBe(1_000);
            expect(all[0].updatedAt).toBe(5_000);
        } finally {
            Date.now = originalNow;
        }
    });

    it('B2 fallback: a zero-pricing row can be upgraded to real pricing later', async () => {
        // Simulates the B2 fix path — snapshotPricing() writes 0/0 when the
        // OpenRouter row has no pricing, then a later catalog sync upgrades it.
        await db.upsertPricingSnapshot(
            'weird/no-price-model',
            'Weird No-Price Model',
            JSON.stringify({ inputPerMToken: 0, outputPerMToken: 0 }),
        );
        let all = await db.getAllPricingSnapshots();
        expect(JSON.parse(all[0].pricingJson).inputPerMToken).toBe(0);

        await db.upsertPricingSnapshot(
            'weird/no-price-model',
            'Weird No-Price Model',
            JSON.stringify({ inputPerMToken: 1.5, outputPerMToken: 6 }),
        );
        all = await db.getAllPricingSnapshots();
        expect(all).toHaveLength(1);
        expect(JSON.parse(all[0].pricingJson)).toEqual({
            inputPerMToken: 1.5,
            outputPerMToken: 6,
        });
    });

    it('handles multiple distinct models independently', async () => {
        await db.upsertPricingSnapshot('a/one', 'A One', '{"inputPerMToken":1}');
        await db.upsertPricingSnapshot('b/two', 'B Two', '{"inputPerMToken":2}');
        await db.upsertPricingSnapshot('c/three', 'C Three', '{"inputPerMToken":3}');
        const all = await db.getAllPricingSnapshots();
        expect(all).toHaveLength(3);
        const byId = Object.fromEntries(all.map(r => [r.modelId, r]));
        expect(JSON.parse(byId['a/one'].pricingJson).inputPerMToken).toBe(1);
        expect(JSON.parse(byId['b/two'].pricingJson).inputPerMToken).toBe(2);
        expect(JSON.parse(byId['c/three'].pricingJson).inputPerMToken).toBe(3);
    });
});
