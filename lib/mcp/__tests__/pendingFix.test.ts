import { buildMcpFixInstruction, isMcpFixInstruction, computeMcpPendingFix, backfillPendingFixFlags, extractCallToolPairs } from '../pendingFix';

jest.mock('../store', () => ({
    getAllConnections: jest.fn(),
    getCachedTools: jest.fn(),
    getShapesForSlug: jest.fn(),
    getEarliestShapeObservedAt: jest.fn(),
    getToolShapeObservedAt: jest.fn(),
}));

jest.mock('../manager', () => ({
    isConnected: jest.fn(),
    callProviderTool: jest.fn(),
}));

jest.mock('../curatedCatalog', () => ({
    CURATED_PROVIDERS: [{ slug: 'picpay', name: 'PicPay' }, { slug: 'notion', name: 'Notion' }],
}));

jest.mock('../../database/db', () => ({
    getAppsWithoutMcpFixEvaluation: jest.fn(),
    setMcpPendingFix: jest.fn(),
}));

import { getCachedTools, getShapesForSlug, getEarliestShapeObservedAt, getToolShapeObservedAt } from '../store';
import { isConnected } from '../manager';
import { getAppsWithoutMcpFixEvaluation, setMcpPendingFix } from '../../database/db';

const mockedGetCachedTools = getCachedTools as jest.Mock;
const mockedGetShapesForSlug = getShapesForSlug as jest.Mock;
const mockedGetEarliestShapeObservedAt = getEarliestShapeObservedAt as jest.Mock;
const mockedGetToolShapeObservedAt = getToolShapeObservedAt as jest.Mock;
const mockedIsConnected = isConnected as jest.Mock;
const mockedGetWithoutEval = getAppsWithoutMcpFixEvaluation as jest.Mock;
const mockedSetMcpPendingFix = setMcpPendingFix as jest.Mock;

function reset(connected: string[], shapes: Record<string, string> = {}, tools: unknown[] = [{ name: 'list_x' }]) {
    jest.clearAllMocks();
    mockedIsConnected.mockImplementation((slug: string) => Promise.resolve(connected.includes(slug)));
    mockedGetShapesForSlug.mockImplementation((slug: string) => Promise.resolve(slug === 'picpay' ? shapes : {}));
    mockedGetCachedTools.mockResolvedValue(tools);
    mockedGetEarliestShapeObservedAt.mockResolvedValue(null);
    mockedGetToolShapeObservedAt.mockResolvedValue(null);
    mockedGetWithoutEval.mockResolvedValue([]);
    mockedSetMcpPendingFix.mockResolvedValue(undefined);
}

describe('buildMcpFixInstruction', () => {
    it('is deterministic, English, and mentions the slugs', () => {
        const a = buildMcpFixInstruction(['picpay']);
        const b = buildMcpFixInstruction(['picpay']);
        expect(a).toBe(b);
        expect(a).toContain('`picpay`');
        expect(a).toContain('AppacadabraMCP');
    });

    it('isMcpFixInstruction matches only fix instructions', () => {
        expect(isMcpFixInstruction(buildMcpFixInstruction(['picpay']))).toBe(true);
        expect(isMcpFixInstruction('make the header blue')).toBe(false);
        expect(isMcpFixInstruction('')).toBe(false);
        expect(isMcpFixInstruction(null)).toBe(false);
    });
});

describe('computeMcpPendingFix', () => {
    it('flags a catalog slug named in the prompt when not connected', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({ prompt: 'app de transações do picpay' });
        expect(pending).toEqual(['picpay']);
    });

    it('does not flag unrelated slugs', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({ prompt: 'lista de tarefas simples' });
        expect(pending).toEqual([]);
    });

    it('flags connected slug with declared tools but zero shapes', async () => {
        reset(['picpay'], {});
        const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list'] }] } };
        const pending = await computeMcpPendingFix({ prompt: 'picpay', plan });
        expect(pending).toEqual(['picpay']);
    });

    it('does not flag when at least one declared tool has a shape', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list', 'get_balance'] }] } };
        const pending = await computeMcpPendingFix({ prompt: 'picpay', plan });
        expect(pending).toEqual([]);
    });

    it('flags connected undeclared slug with tools but zero shapes', async () => {
        reset(['picpay'], {});
        const pending = await computeMcpPendingFix({ prompt: 'transações do picpay' });
        expect(pending).toEqual(['picpay']);
    });

    it('does not flag connected slug that already has shapes', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        const pending = await computeMcpPendingFix({ prompt: 'transações do picpay' });
        expect(pending).toEqual([]);
    });

    it('detects slugs referenced by the code (edit flow)', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({
            prompt: 'agrupe por dia',
            code: 'AppacadabraMCP.callTool("notion", "search", {}, "cb");',
        });
        expect(pending).toContain('notion');
    });

    it('fails safe: connection errors mark the pendência instead of throwing', async () => {
        jest.clearAllMocks();
        mockedIsConnected.mockRejectedValue(new Error('no db'));
        await expect(computeMcpPendingFix({ prompt: 'picpay' })).resolves.toEqual(['picpay']);
    });
});

describe('backfillPendingFixFlags', () => {
    const SPELL_CODE = `AppacadabraMCP.callTool("picpay", "statements_list", args, "cb");`;

    it('extracts static slug+tool pairs from code', () => {
        const pairs = extractCallToolPairs(`AppacadabraMCP.callTool("picpay", "statements_list", {}, "cb");
            AppacadabraMCP.callTool('notion', 'search_pages', {}, 'cb');
            AppacadabraMCP.callTool("picpay", dynamicToolName, {}, "cb");`);
        expect(pairs).toEqual([
            { slug: 'picpay', tool: 'statements_list' },
            { slug: 'notion', tool: 'search_pages' },
        ]);
    });

    it('flags a legacy spell whose called tool got a shape only after creation', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        mockedGetToolShapeObservedAt.mockResolvedValue(1_000);
        mockedGetWithoutEval.mockResolvedValue([{ id: 7, createdAt: 500, mcps: ['picpay'], code: SPELL_CODE }]);
        const evaluated = await backfillPendingFixFlags();
        expect(evaluated).toBe(1);
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(7, ['picpay']);
    });

    it('does not flag when the called tool already had a shape at creation', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        mockedGetToolShapeObservedAt.mockResolvedValue(100);
        mockedGetWithoutEval.mockResolvedValue([{ id: 7, createdAt: 500, mcps: ['picpay'], code: SPELL_CODE }]);
        await backfillPendingFixFlags();
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(7, []);
    });

    it('flags when the called tool has no shape at all', async () => {
        reset(['picpay'], { other_tool: '{x:1}' });
        mockedGetWithoutEval.mockResolvedValue([{ id: 7, createdAt: 500, mcps: ['picpay'], code: SPELL_CODE }]);
        await backfillPendingFixFlags();
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(7, ['picpay']);
    });

    it('falls back to slug-level timing when no static tool is referenced', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        mockedGetEarliestShapeObservedAt.mockResolvedValue(1_000);
        mockedGetWithoutEval.mockResolvedValue([{ id: 7, createdAt: 500, mcps: ['picpay'], code: 'AppacadabraMCP.listTools("picpay", "cb");' }]);
        await backfillPendingFixFlags();
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(7, ['picpay']);
    });

    it('flags when the server has no shapes at all', async () => {
        reset(['picpay'], {});
        mockedGetWithoutEval.mockResolvedValue([{ id: 3, createdAt: 5_000, mcps: ['picpay'], code: SPELL_CODE }]);
        await backfillPendingFixFlags();
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(3, ['picpay']);
    });

    it('flags when the server is not connected', async () => {
        reset([], {});
        mockedGetWithoutEval.mockResolvedValue([{ id: 3, createdAt: 5_000, mcps: ['notion'], code: '' }]);
        await backfillPendingFixFlags();
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(3, ['notion']);
    });

    it('tolerates db failures', async () => {
        reset([], {});
        mockedGetWithoutEval.mockRejectedValue(new Error('no db'));
        await expect(backfillPendingFixFlags()).resolves.toBe(0);
        expect(mockedSetMcpPendingFix).not.toHaveBeenCalled();
    });
});
