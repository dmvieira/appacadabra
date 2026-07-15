// Tests for pending_jobs CRUD + the store-level reconciliation that
// marks stale 'processing' rows as failed on cold start.
//
// The default expo-sqlite mock in jest.setup.js is a no-op (returns null/[]),
// so we override it here with an in-memory store keyed by jobId that mimics
// the SQL semantics we rely on.

import type { PendingJob } from '../types';

type Row = PendingJob;

const mockMemory = new Map<string, Row>();

jest.mock('expo-sqlite', () => ({
    openDatabaseAsync: jest.fn(() => Promise.resolve({
        execAsync: jest.fn(),
        runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
            const text = sql.toLowerCase();
            if (text.includes('insert or replace into pending_jobs')) {
                const [
                    jobId, type, appId, promptText, selectedContext,
                    status, startedAt, updatedAt, lastErrorCode, lastErrorMessage,
                    currentStage, stageAttempt, outerAttempt, planJson, currentHtml, usageJson,
                ] = params as any[];
                mockMemory.set(jobId, {
                    jobId, type, appId, promptText, selectedContext,
                    status, startedAt, updatedAt, lastErrorCode, lastErrorMessage,
                    currentStage, stageAttempt, outerAttempt, planJson, currentHtml, usageJson,
                });
                return;
            }
            if (text.includes('delete from pending_jobs where jobid = ?')) {
                mockMemory.delete(params[0] as string);
                return;
            }
            if (text.includes("delete from pending_jobs where status = 'draft' and type = 'draft' and appid is null")) {
                for (const [k, v] of mockMemory) {
                    if (v.status === 'draft' && v.type === 'draft' && v.appId === null) mockMemory.delete(k);
                }
                return;
            }
            if (text.includes("delete from pending_jobs where status = 'draft' and type = 'draft' and appid = ?")) {
                const targetId = params[0] as number;
                for (const [k, v] of mockMemory) {
                    if (v.status === 'draft' && v.type === 'draft' && v.appId === targetId) mockMemory.delete(k);
                }
                return;
            }
        }),
        getAllAsync: jest.fn(async (sql: string) => {
            const text = sql.toLowerCase();
            if (text.includes("status = 'processing'")) {
                return Array.from(mockMemory.values())
                    .filter(r => r.status === 'processing')
                    .sort((a, b) => a.startedAt - b.startedAt);
            }
            return [];
        }),
        getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
            const text = sql.toLowerCase();
            if (text.includes('from pending_jobs where jobid = ?')) {
                return mockMemory.get(params[0] as string) || null;
            }
            if (text.includes("where status = 'draft' and type = 'draft' and appid is null")) {
                const rows = Array.from(mockMemory.values())
                    .filter(r => r.status === 'draft' && r.type === 'draft' && r.appId === null)
                    .sort((a, b) => b.updatedAt - a.updatedAt);
                return rows[0] || null;
            }
            if (text.includes("where status = 'draft' and type = 'draft' and appid = ?")) {
                const targetId = params[0] as number;
                const rows = Array.from(mockMemory.values())
                    .filter(r => r.status === 'draft' && r.type === 'draft' && r.appId === targetId)
                    .sort((a, b) => b.updatedAt - a.updatedAt);
                return rows[0] || null;
            }
            return null;
        }),
        closeAsync: jest.fn(),
    })),
}));

// db.ts is loaded after the mock above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../db');

function makeJob(overrides: Partial<Row> = {}): PendingJob {
    return {
        jobId: 'job-1',
        type: 'create',
        appId: null,
        promptText: 'hello',
        selectedContext: null,
        status: 'processing',
        startedAt: 1_000,
        updatedAt: 1_000,
        lastErrorCode: null,
        lastErrorMessage: null,
        currentStage: null,
        stageAttempt: null,
        outerAttempt: null,
        planJson: null,
        currentHtml: null,
        usageJson: null,
        ...overrides,
    };
}

beforeEach(() => {
    mockMemory.clear();
});

describe('pending_jobs CRUD', () => {
    it('upsert + getPendingJob roundtrips a row', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a' }));
        const got = await db.getPendingJob('a');
        expect(got).not.toBeNull();
        expect(got.jobId).toBe('a');
        expect(got.promptText).toBe('hello');
    });

    it('roundtrips state-machine columns (currentStage, attempts, planJson, currentHtml, usageJson)', async () => {
        await db.upsertPendingJob(makeJob({
            jobId: 'sm',
            currentStage: 'coder',
            stageAttempt: 2,
            outerAttempt: 1,
            planJson: '{"steps":["a","b"]}',
            currentHtml: '<html></html>',
            usageJson: '{"totalTokens":123}',
        }));
        const got = await db.getPendingJob('sm');
        expect(got.currentStage).toBe('coder');
        expect(got.stageAttempt).toBe(2);
        expect(got.outerAttempt).toBe(1);
        expect(got.planJson).toBe('{"steps":["a","b"]}');
        expect(got.currentHtml).toBe('<html></html>');
        expect(got.usageJson).toBe('{"totalTokens":123}');
    });

    it('upsert with same jobId replaces the row', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a', promptText: 'v1', updatedAt: 1 }));
        await db.upsertPendingJob(makeJob({ jobId: 'a', promptText: 'v2', updatedAt: 2 }));
        const got = await db.getPendingJob('a');
        expect(got.promptText).toBe('v2');
        expect(got.updatedAt).toBe(2);
    });

    it('deletePendingJob removes the row', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a' }));
        await db.deletePendingJob('a');
        expect(await db.getPendingJob('a')).toBeNull();
    });

    it('listProcessingJobs returns only processing rows, oldest first', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a', status: 'processing', startedAt: 200 }));
        await db.upsertPendingJob(makeJob({ jobId: 'b', status: 'processing', startedAt: 100 }));
        await db.upsertPendingJob(makeJob({ jobId: 'c', status: 'failed', startedAt: 50 }));
        await db.upsertPendingJob(makeJob({ jobId: 'd', status: 'draft', type: 'draft', startedAt: 10 }));
        const rows: PendingJob[] = await db.listProcessingJobs();
        expect(rows.map(r => r.jobId)).toEqual(['b', 'a']);
    });

    it('getPendingDraft(create) returns most recent create-draft only', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'old', type: 'draft', status: 'draft', appId: null, promptText: 'old', updatedAt: 100 }));
        await db.upsertPendingJob(makeJob({ jobId: 'new', type: 'draft', status: 'draft', appId: null, promptText: 'new', updatedAt: 200 }));
        await db.upsertPendingJob(makeJob({ jobId: 'edit', type: 'draft', status: 'draft', appId: 42, promptText: 'edit-draft', updatedAt: 300 }));
        const draft = await db.getPendingDraft('create');
        expect(draft.promptText).toBe('new');
    });

    it('getPendingDraft(edit, appId) is keyed by appId', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a', type: 'draft', status: 'draft', appId: 7, promptText: 'for-7' }));
        await db.upsertPendingJob(makeJob({ jobId: 'b', type: 'draft', status: 'draft', appId: 8, promptText: 'for-8' }));
        const d7 = await db.getPendingDraft('edit', 7);
        const d8 = await db.getPendingDraft('edit', 8);
        const dMissing = await db.getPendingDraft('edit', 99);
        expect(d7.promptText).toBe('for-7');
        expect(d8.promptText).toBe('for-8');
        expect(dMissing).toBeNull();
    });

    it('deleteDraftFor(create) only removes the create-draft, leaving edit-drafts intact', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'c', type: 'draft', status: 'draft', appId: null }));
        await db.upsertPendingJob(makeJob({ jobId: 'e', type: 'draft', status: 'draft', appId: 5 }));
        await db.deleteDraftFor('create');
        expect(await db.getPendingDraft('create')).toBeNull();
        expect(await db.getPendingDraft('edit', 5)).not.toBeNull();
    });

    it('deleteDraftFor(edit, appId) only removes that specific draft', async () => {
        await db.upsertPendingJob(makeJob({ jobId: 'a', type: 'draft', status: 'draft', appId: 7 }));
        await db.upsertPendingJob(makeJob({ jobId: 'b', type: 'draft', status: 'draft', appId: 8 }));
        await db.deleteDraftFor('edit', 7);
        expect(await db.getPendingDraft('edit', 7)).toBeNull();
        expect(await db.getPendingDraft('edit', 8)).not.toBeNull();
    });
});
