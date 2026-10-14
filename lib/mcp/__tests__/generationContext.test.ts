import { getMcpPromptBlock, getMcpPlannerLine, setConnectedMcpSlugs, setCachedMcpTools, setCachedMcpShapes } from '../generationContext';

describe('MCP generation context', () => {
    afterEach(() => {
        setConnectedMcpSlugs([]);
        setCachedMcpTools({});
        setCachedMcpShapes({});
    });

    it('lists curated providers including picpay', () => {
        const block = getMcpPromptBlock();
        expect(block).toContain('MCP CONNECTORS');
        expect(block).toContain('`picpay`');
        expect(block).toContain('AppacadabraMCP.listTools');
    });

    it('marks connected providers', () => {
        setConnectedMcpSlugs(['picpay']);
        const block = getMcpPromptBlock();
        expect(block).toContain('PicPay (connected)');
    });

    it('exposes a planner line mentioning AppacadabraMCP', () => {
        expect(getMcpPlannerLine()).toContain('AppacadabraMCP');
    });

    describe('planner tool index', () => {
        it('lists connected tools and asks the planner to declare mcpTools', () => {
            setConnectedMcpSlugs(['acme']);
            setCachedMcpTools({
                acme: [{ name: 'orders_list', description: 'Lists orders.', inputSchema: {} }],
            });
            const line = getMcpPlannerLine();
            expect(line).toContain('`acme`');
            expect(line).toContain('orders_list');
            expect(line).toContain('"mcpTools"');
            expect(line).toContain('never invent names');
        });

        it('marks not-connected catalog servers without tool names', () => {
            setConnectedMcpSlugs([]);
            setCachedMcpTools({ picpay: [{ name: 'balance_account_get', inputSchema: {} }] });
            const line = getMcpPlannerLine();
            expect(line).toContain('not connected');
            expect(line).not.toContain('balance_account_get');
        });
    });

    describe('cached tool schemas', () => {
        const longDescription = 'x'.repeat(300);

        beforeEach(() => {
            setConnectedMcpSlugs(['acme']);
            setCachedMcpTools({
                acme: [
                    {
                        name: 'orders_list',
                        title: 'List orders',
                        description: 'Lists the orders of the authenticated account.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                status: { type: 'string', enum: ['open', 'paid'] },
                                limit: { type: 'integer' },
                            },
                            required: ['status'],
                        },
                    },
                    { name: 'order_get', description: longDescription, inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
                ],
            });
        });

        it('injects a compact tool index for connected servers', () => {
            const block = getMcpPromptBlock();
            expect(block).toContain('Available tools on `acme`');
            expect(block).toContain('`orders_list` — List orders — Lists the orders of the authenticated account.');
            expect(block).toContain('status (string: open|paid)*');
            expect(block).toContain('(* = required)');
            expect(block).toContain('`order_get`');
        });

        it('trims long descriptions', () => {
            const block = getMcpPromptBlock();
            expect(block).not.toContain(longDescription);
            expect(block).toMatch(/`order_get` — .{1,160}…/);
        });

        it('keeps unconnected servers out of the tool index', () => {
            setConnectedMcpSlugs([]);
            setCachedMcpTools({ picpay: [{ name: 'balance_account_get', inputSchema: {} }] });
            const block = getMcpPromptBlock();
            expect(block).not.toContain('Available tools on');
        });

        it('still renders the generic block when no tools are cached', () => {
            setConnectedMcpSlugs(['picpay']);
            const block = getMcpPromptBlock();
            expect(block).toContain('PicPay (connected)');
            expect(block).not.toContain('Available tools on `picpay`');
        });

        it('lists connected non-curated servers that have cached tools', () => {
            setCachedMcpTools({});
            setConnectedMcpSlugs(['my-custom-server']);
            setCachedMcpTools({ 'my-custom-server': [{ name: 'ping', inputSchema: {} }] });
            const block = getMcpPromptBlock();
            expect(block).toContain('- `my-custom-server` — my-custom-server (connected):');
            expect(block).toContain('Available tools on `my-custom-server`');
            expect(block).toContain('`ping`');
        });
    });

    describe('observed response shapes', () => {
        beforeEach(() => {
            setConnectedMcpSlugs(['acme']);
            setCachedMcpTools({
                acme: [
                    { name: 'orders_list', description: 'Lists orders.', inputSchema: { type: 'object', properties: {} } },
                    { name: 'with_output_schema', description: 'Has published schema.', inputSchema: {}, outputSchema: { type: 'object', properties: { status: { type: 'string' }, total: { type: 'number' } } } },
                ],
            });
        });

        it('renders observed shapes so the coder reads the right fields', () => {
            setCachedMcpShapes({ acme: { orders_list: '{items:[{total:"10.00", data:"2026-02-14"}]}' } });
            const block = getMcpPromptBlock();
            expect(block).toContain('Returns (observed');
            expect(block).toContain('{items:[{total:"10.00", data:"2026-02-14"}]}');
            expect(block).toContain('raw` follows exactly this structure');
            expect(block).toContain('parseFloat');
        });

        it('omits the Returns line for tools without shapes', () => {
            setCachedMcpShapes({ acme: {} });
            const block = getMcpPromptBlock();
            expect(block).not.toContain('Returns (observed');
        });

        it('truncates oversized shapes', () => {
            setCachedMcpShapes({ acme: { orders_list: `x`.repeat(2000) } });
            const block = getMcpPromptBlock();
            expect(block).toMatch(/Returns \(observed[^]*x{600}…/);
        });

        it('renders published outputSchema as the authoritative structure', () => {
            const block = getMcpPromptBlock();
            expect(block).toContain('Returns (schema): {status: string, total: number}');
        });
    });
});
