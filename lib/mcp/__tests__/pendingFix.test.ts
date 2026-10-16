import { buildMcpFixInstruction, isMcpFixInstruction, computeMcpPendingFix, backfillPendingFixFlags, extractCallToolPairs, extractCodeMcpSlugs, clearOrphanMcpFixFlags, mergeEditPendingFix } from '../pendingFix';

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
    getAppsWithMcpFixFlagged: jest.fn(),
    setMcpPendingFix: jest.fn(),
}));

import { getCachedTools, getShapesForSlug, getEarliestShapeObservedAt, getToolShapeObservedAt } from '../store';
import { isConnected } from '../manager';
import { getAppsWithoutMcpFixEvaluation, getAppsWithMcpFixFlagged, setMcpPendingFix } from '../../database/db';

const mockedGetCachedTools = getCachedTools as jest.Mock;
const mockedGetShapesForSlug = getShapesForSlug as jest.Mock;
const mockedGetEarliestShapeObservedAt = getEarliestShapeObservedAt as jest.Mock;
const mockedGetToolShapeObservedAt = getToolShapeObservedAt as jest.Mock;
const mockedIsConnected = isConnected as jest.Mock;
const mockedGetWithoutEval = getAppsWithoutMcpFixEvaluation as jest.Mock;
const mockedGetFlagged = getAppsWithMcpFixFlagged as jest.Mock;
const mockedSetMcpPendingFix = setMcpPendingFix as jest.Mock;

function reset(connected: string[], shapes: Record<string, string> = {}, tools: unknown[] = [{ name: 'list_x' }]) {
    jest.clearAllMocks();
    mockedIsConnected.mockImplementation((slug: string) => Promise.resolve(connected.includes(slug)));
    mockedGetShapesForSlug.mockImplementation((slug: string) => Promise.resolve(slug === 'picpay' ? shapes : {}));
    mockedGetCachedTools.mockResolvedValue(tools);
    mockedGetEarliestShapeObservedAt.mockResolvedValue(null);
    mockedGetToolShapeObservedAt.mockResolvedValue(null);
    mockedGetWithoutEval.mockResolvedValue([]);
    mockedGetFlagged.mockResolvedValue([]);
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
    it('does not flag a catalog slug merely named in the prompt (strict heuristic)', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({ prompt: 'app de transações do picpay' });
        expect(pending).toEqual([]);
    });

    it('does not flag unrelated slugs', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({ prompt: 'lista de tarefas simples' });
        expect(pending).toEqual([]);
    });

    it('flags a plan-declared slug when not connected', async () => {
        reset([]);
        const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list'] }] } };
        const pending = await computeMcpPendingFix({ prompt: 'app de transações do picpay', plan });
        expect(pending).toEqual(['picpay']);
    });

    it('does NOT flag connected slug with cached tools but zero observed shapes (shapes are not a criterion)', async () => {
        reset(['picpay'], {});
        const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list'] }] } };
        const pending = await computeMcpPendingFix({ prompt: 'picpay', plan });
        expect(pending).toEqual([]);
    });

    it('flags connected slug when the tool cache is empty (coder saw no schemas)', async () => {
        reset(['picpay'], {}, []);
        const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list'] }] } };
        const pending = await computeMcpPendingFix({ prompt: 'picpay', plan });
        expect(pending).toEqual(['picpay']);
    });

    it('does not flag code-referenced connected slug with cached tools but zero shapes', async () => {
        reset(['picpay'], {});
        const pending = await computeMcpPendingFix({
            prompt: 'transações do picpay',
            code: 'AppacadabraMCP.callTool("picpay", "statements_list", {}, "cb");',
        });
        expect(pending).toEqual([]);
    });

    it('does not flag code-referenced slug that already has shapes', async () => {
        reset(['picpay'], { statements_list: '{dias:[]}' });
        const pending = await computeMcpPendingFix({
            prompt: 'transações do picpay',
            code: 'AppacadabraMCP.callTool("picpay", "statements_list", {}, "cb");',
        });
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

    it('ignores CSS that merely contains a slug-like substring (linear-gradient)', async () => {
        reset([]);
        const pending = await computeMcpPendingFix({
            prompt: 'tela bonita',
            code: 'background: linear-gradient(to right, #fff, #000);',
        });
        expect(pending).toEqual([]);
    });

    it('fails safe: connection errors mark the pendência instead of throwing', async () => {
        jest.clearAllMocks();
        mockedIsConnected.mockRejectedValue(new Error('no db'));
        await expect(computeMcpPendingFix({
            prompt: 'picpay',
            code: 'AppacadabraMCP.callTool("picpay", "statements_list", {}, "cb");',
        })).resolves.toEqual(['picpay']);
    });
});

describe('extractCodeMcpSlugs', () => {
    it('extracts slugs from any AppacadabraMCP call, deduplicated', () => {
        const code = `AppacadabraMCP.callTool("picpay", "t", {}, "cb");
            AppacadabraMCP.isConnected('picpay', "cb");
            AppacadabraMCP.listTools("notion", "cb");`;
        expect(extractCodeMcpSlugs(code)).toEqual(['picpay', 'notion']);
    });

    it('ignores non-call mentions like CSS', () => {
        expect(extractCodeMcpSlugs('background: linear-gradient(to right, #fff, #000);')).toEqual([]);
    });
});

describe('clearOrphanMcpFixFlags', () => {
    it('clears flags whose slugs the code never references', async () => {
        reset(['picpay'], {});
        mockedGetFlagged.mockResolvedValue([
            { id: 1, code: 'no mcp here', flagged: ['picpay', 'notion'] },
        ]);
        const cleared = await clearOrphanMcpFixFlags();
        expect(cleared).toBe(1);
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(1, []);
    });

    it('leaves flags whose slugs are all still referenced (no rewrite)', async () => {
        reset(['picpay'], {});
        mockedGetFlagged.mockResolvedValue([
            { id: 2, code: 'AppacadabraMCP.callTool("picpay", "t", {}, "cb");', flagged: ['picpay'] },
        ]);
        const cleared = await clearOrphanMcpFixFlags();
        expect(cleared).toBe(0);
        expect(mockedSetMcpPendingFix).not.toHaveBeenCalled();
    });

    it('partial keeps: removes only orphan slugs', async () => {
        reset(['picpay'], {});
        mockedGetFlagged.mockResolvedValue([
            { id: 3, code: 'AppacadabraMCP.callTool("picpay", "t", {}, "cb");', flagged: ['picpay', 'notion'] },
        ]);
        const cleared = await clearOrphanMcpFixFlags();
        expect(cleared).toBe(1);
        expect(mockedSetMcpPendingFix).toHaveBeenCalledWith(3, ['picpay']);
    });

    it('tolerates db failures', async () => {
        reset([], {});
        mockedGetFlagged.mockRejectedValue(new Error('no db'));
        await expect(clearOrphanMcpFixFlags()).resolves.toBe(0);
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

describe('mergeEditPendingFix', () => {
    const CODE = 'AppacadabraMCP.callTool("picpay", "statements_list", {}, "cb");';

    it('the targeted fix edit clears everything', () => {
        expect(mergeEditPendingFix({
            instruction: buildMcpFixInstruction(['picpay']),
            previous: ['picpay'],
            recomputed: ['picpay'],
            code: CODE,
        })).toEqual([]);
    });

    it('a cosmetic edit keeps a still-called flagged slug even if recomputation is clean', () => {
        expect(mergeEditPendingFix({ instruction: 'make the header blue', previous: ['picpay'], recomputed: [], code: CODE })).toEqual(['picpay']);
    });

    it('drops flagged slugs the new code no longer calls', () => {
        expect(mergeEditPendingFix({ instruction: 'remove the picpay section', previous: ['picpay'], recomputed: [], code: '<p>hi</p>' })).toEqual([]);
    });

    it('adds newly blind slugs without duplicates', () => {
        const code = CODE + 'AppacadabraMCP.listTools("notion", "cb");';
        expect(mergeEditPendingFix({ instruction: 'add notion', previous: ['picpay'], recomputed: ['notion', 'picpay'], code }).sort()).toEqual(['notion', 'picpay']);
    });

    it('handles a spell with no previous flag', () => {
        expect(mergeEditPendingFix({ instruction: 'x', previous: undefined, recomputed: [], code: CODE })).toEqual([]);
    });
});
