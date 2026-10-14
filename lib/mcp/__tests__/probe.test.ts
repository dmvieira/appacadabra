import { findProbeTargets, probeShapesForGeneration, extractPlanMcpTools } from '../probe';
import { missingRequiredArgs } from '../toolArgs';

jest.mock('../store', () => ({
    getAllConnections: jest.fn(),
    getCachedTools: jest.fn(),
    getShapesForSlug: jest.fn(),
}));

jest.mock('../manager', () => ({
    isConnected: jest.fn(),
    callProviderTool: jest.fn(),
}));

import { getAllConnections, getCachedTools, getShapesForSlug } from '../store';
import { isConnected, callProviderTool } from '../manager';

const mockedGetAllConnections = getAllConnections as jest.Mock;
const mockedGetCachedTools = getCachedTools as jest.Mock;
const mockedGetShapesForSlug = getShapesForSlug as jest.Mock;
const mockedIsConnected = isConnected as jest.Mock;
const mockedCallProviderTool = callProviderTool as jest.Mock;

function reset(connections: unknown[], tools: unknown[] = [], shapes: Record<string, string> = {}) {
    jest.clearAllMocks();
    mockedGetAllConnections.mockResolvedValue(connections);
    mockedGetCachedTools.mockResolvedValue(tools);
    mockedGetShapesForSlug.mockResolvedValue(shapes);
    mockedIsConnected.mockResolvedValue(true);
    mockedCallProviderTool.mockResolvedValue({ text: '', raw: {}, isError: false });
}

const CONNECTION = { slug: 'picpay', name: 'PicPay', status: 'connected' };

describe('probeShapesForGeneration', () => {
    beforeEach(() => {
        reset([CONNECTION]);
    });

    describe('findProbeTargets', () => {
        it('selects connected servers mentioned in the text', async () => {
            const targets = await findProbeTargets('quero ver minhas transações do picpay agrupadas por dia');
            expect(targets).toEqual(['picpay']);
        });

        it('matches by provider name too', async () => {
            const targets = await findProbeTargets('mostre meu extrato PicPay');
            expect(targets).toEqual(['picpay']);
        });

        it('skips servers not mentioned', async () => {
            const targets = await findProbeTargets('um app de tarefas simples');
            expect(targets).toEqual([]);
        });

        it('skips servers that are not connected', async () => {
            mockedIsConnected.mockResolvedValue(false);
            const targets = await findProbeTargets('transações do picpay');
            expect(targets).toEqual([]);
        });

        it('caps the number of probed servers', async () => {
            reset([
                { slug: 'alpha', name: 'Alpha', status: 'connected' },
                { slug: 'beta', name: 'Beta', status: 'connected' },
                { slug: 'gamma', name: 'Gamma', status: 'connected' },
            ]);
            const targets = await findProbeTargets('alpha beta gamma');
            expect(targets).toEqual(['alpha', 'beta']);
        });
    });

    it('probes safe tools without a known shape and reports successes', async () => {
        reset(
            [CONNECTION],
            [
                { name: 'get_balance', inputSchema: { type: 'object', properties: {} } },
                { name: 'list_transactions', inputSchema: { type: 'object', properties: { data_inicio: { type: 'string' }, data_fim: { type: 'string' } }, required: ['data_inicio', 'data_fim'] } },
            ],
        );
        const learned = await probeShapesForGeneration({ prompt: 'transações do picpay' });
        expect(mockedCallProviderTool).toHaveBeenCalledTimes(2);
        const [, , listArgs] = mockedCallProviderTool.mock.calls.find(c => c[1] === 'list_transactions');
        expect(listArgs.data_inicio).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(listArgs.data_fim).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(learned).toBe(2);
    });

    it('never probes unsafe (mutating) tools', async () => {
        reset([CONNECTION], [
            { name: 'create_payment', inputSchema: {} },
            { name: 'send_money', inputSchema: {} },
            { name: 'cancel_transfer', inputSchema: {} },
        ]);
        const learned = await probeShapesForGeneration({ prompt: 'picpay' });
        expect(mockedCallProviderTool).not.toHaveBeenCalled();
        expect(learned).toBe(0);
    });

    it('skips tools that already have an observed shape', async () => {
        reset([CONNECTION], [{ name: 'get_balance', inputSchema: {} }], { get_balance: '{balance:"1.00"}' });
        const learned = await probeShapesForGeneration({ prompt: 'picpay' });
        expect(mockedCallProviderTool).not.toHaveBeenCalled();
        expect(learned).toBe(0);
    });

    it('skips tools with opaque required identifiers', async () => {
        reset([CONNECTION], [
            { name: 'get_order', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
        ]);
        const learned = await probeShapesForGeneration({ prompt: 'picpay' });
        expect(mockedCallProviderTool).not.toHaveBeenCalled();
        expect(learned).toBe(0);
    });

    it('caps tools probed per server', async () => {
        reset(
            [CONNECTION],
            Array.from({ length: 10 }, (_, i) => ({ name: `list_items_${i}`, inputSchema: { type: 'object', properties: {} } })),
        );
        await probeShapesForGeneration({ prompt: 'picpay' });
        expect(mockedCallProviderTool).toHaveBeenCalledTimes(4);
    });

    it('scans the spell code for slugs (edit flow)', async () => {
        reset([CONNECTION], [{ name: 'get_balance', inputSchema: { type: 'object', properties: {} } }]);
        const learned = await probeShapesForGeneration({ prompt: 'agrupe por dia', plan: null, code: 'AppacadabraMCP.callTool("picpay", "get_balance", {}, "cb");' });
        expect(mockedCallProviderTool).toHaveBeenCalledTimes(1);
        expect(learned).toBe(1);
    });

    it('counts failures as not learned and never throws', async () => {
        reset([CONNECTION], [{ name: 'get_balance', inputSchema: {} }]);
        mockedCallProviderTool.mockRejectedValue(new Error('boom'));
        const learned = await probeShapesForGeneration({ prompt: 'picpay' });
        expect(learned).toBe(0);
    });

    it('tolerates store failures', async () => {
        jest.clearAllMocks();
        mockedGetAllConnections.mockRejectedValue(new Error('no db'));
        const learned = await probeShapesForGeneration({ prompt: 'picpay' });
        expect(learned).toBe(0);
    });

    it('missingRequiredArgs guard keeps synthesized args honest', () => {
        const tool = { name: 't', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] } };
        expect(missingRequiredArgs(tool as never, { limit: 10 })).toEqual([]);
        expect(missingRequiredArgs(tool as never, {})).toEqual(['limit']);
    });

    describe('plan-declared tools (mcpTools)', () => {
        it('extracts and merges server → tools declarations', () => {
            const map = extractPlanMcpTools({
                technicalRequirements: {
                    mcpTools: [
                        { server: 'picpay', tools: ['statements_list'] },
                        { server: 'PicPay', tools: ['balance_account_get', 'statements_list'] },
                        { server: '', tools: ['x'] },
                        { server: 'notion' },
                        'garbage',
                    ],
                },
            });
            expect([...map.keys()]).toEqual(['picpay']);
            expect(map.get('picpay')).toEqual(['statements_list', 'balance_account_get']);
        });

        it('probes exactly the planner-declared tools', async () => {
            reset(
                [CONNECTION],
                [
                    { name: 'balance_account_get', inputSchema: {} },
                    { name: 'statements_list', inputSchema: { type: 'object', properties: {} } },
                    { name: 'pix_contacts_list', inputSchema: { type: 'object', properties: {} } },
                ],
            );
            const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['statements_list'] }] } };
            const learned = await probeShapesForGeneration({ prompt: 'app financeiro', plan });
            const called = mockedCallProviderTool.mock.calls.map(c => c[1]);
            expect(called).toEqual(['statements_list']);
            expect(learned).toBe(1);
        });

        it('never probes unsafe tools even when the planner declares them', async () => {
            reset([CONNECTION], [{ name: 'pix_send', inputSchema: { type: 'object', properties: {} } }]);
            const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['pix_send'] }] } };
            const learned = await probeShapesForGeneration({ prompt: 'picpay', plan });
            expect(mockedCallProviderTool).not.toHaveBeenCalled();
            expect(learned).toBe(0);
        });

        it('skips declared tools that already have shapes', async () => {
            reset([CONNECTION], [{ name: 'get_balance', inputSchema: {} }], { get_balance: '{v:1}' });
            const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['get_balance'] }] } };
            const learned = await probeShapesForGeneration({ prompt: 'picpay', plan });
            expect(mockedCallProviderTool).not.toHaveBeenCalled();
            expect(learned).toBe(0);
        });

        it('ignores declared tools that do not exist in the cache', async () => {
            reset([CONNECTION], [{ name: 'get_balance', inputSchema: {} }]);
            const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['hallucinated_tool'] }] } };
            const learned = await probeShapesForGeneration({ prompt: 'picpay', plan });
            expect(mockedCallProviderTool).not.toHaveBeenCalled();
            expect(learned).toBe(0);
        });

        it('skips plan-declared slugs that are not connected', async () => {
            mockedIsConnected.mockResolvedValue(false);
            reset([CONNECTION], [{ name: 'get_balance', inputSchema: {} }]);
            mockedIsConnected.mockResolvedValue(false);
            const plan = { technicalRequirements: { mcpTools: [{ server: 'picpay', tools: ['get_balance'] }] } };
            const learned = await probeShapesForGeneration({ prompt: 'picpay', plan });
            expect(mockedCallProviderTool).not.toHaveBeenCalled();
            expect(learned).toBe(0);
        });
    });
});
