// updateAppContent must recompute required_capabilities/required_mcps from
// the new code — an edit that adds an MCP connector has to show up in the
// spell's "uses" data immediately.

const mockRunAsync = jest.fn(async (_sql: string, _params: unknown[]) => ({ lastInsertRowId: 1 }));

jest.mock('expo-sqlite', () => ({
    openDatabaseAsync: jest.fn(() => Promise.resolve({
        execAsync: jest.fn(),
        runAsync: (sql: string, params: unknown[]) => mockRunAsync(sql, params),
        getAllAsync: jest.fn(async () => []),
        getFirstAsync: jest.fn(async () => null),
    })),
}));

import { updateAppContent } from '../db';

describe('updateAppContent', () => {
    it('rewrites the derived requirements columns from the new code', async () => {
        await updateAppContent(
            7,
            'AppacadabraMCP.callTool("picpay", "get_balance", {}, "cb"); AppacadabraMCP.listTools("notion", "cb");',
            3,
            0.5,
            'job-1',
        );

        expect(mockRunAsync).toHaveBeenCalledTimes(1);
        const [sql, params] = mockRunAsync.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('required_capabilities = ?');
        expect(sql).toContain('required_mcps = ?');
        // Derived from the code, not copied from a previous snapshot.
        const caps = JSON.parse(params[5] as string) as string[];
        const mcps = JSON.parse(params[6] as string) as string[];
        expect(mcps.sort()).toEqual(['notion', 'picpay']);
        expect(caps).toEqual([]); // no capabilities
        // Positional order ends with the row id.
        expect(params[params.length - 1]).toBe(7);
    });

    it('clears stale mcps when the new code no longer references them', async () => {
        mockRunAsync.mockClear();
        await updateAppContent(7, '<p>plain spell</p>', 4, 0, 'job-2');
        const [, params] = mockRunAsync.mock.calls[0] as [string, unknown[]];
        expect(JSON.parse(params[6] as string)).toEqual([]);
        expect(params).not.toContain('["picpay","notion"]');
    });
});
