import { getMcpPromptBlock, getMcpPlannerLine, setConnectedMcpSlugs } from '../generationContext';

describe('MCP generation context', () => {
    afterEach(() => setConnectedMcpSlugs([]));

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
});
