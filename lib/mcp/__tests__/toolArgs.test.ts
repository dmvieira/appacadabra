import { missingRequiredArgs } from '../toolArgs';
import type { McpTool } from '../types';

function tool(schema: unknown): McpTool {
    return { name: 'cards_invoice_transactions_list', inputSchema: schema };
}

describe('missingRequiredArgs', () => {
    it('flags required args missing from the call', () => {
        const t = tool({
            type: 'object',
            required: ['invoice_id'],
            properties: { invoice_id: { type: 'string' }, limit: { type: 'integer' } },
        });
        expect(missingRequiredArgs(t, {})).toEqual(['invoice_id']);
        expect(missingRequiredArgs(t, { invoice_id: 'abc' })).toEqual([]);
        expect(missingRequiredArgs(t, { limit: 5 })).toEqual(['invoice_id']);
    });

    it('passes through when there is no required list or no schema', () => {
        expect(missingRequiredArgs(tool({ type: 'object', properties: {} }), {})).toEqual([]);
        expect(missingRequiredArgs(tool(undefined), {})).toEqual([]);
        expect(missingRequiredArgs(undefined, { a: 1 })).toEqual([]);
    });

    it('never throws on malformed input', () => {
        expect(missingRequiredArgs(tool({ required: 'nope' }), {})).toEqual([]);
        expect(missingRequiredArgs(tool({ required: [1, 'ok', null] }), {})).toEqual(['ok']);
        // @ts-expect-error runtime leniency
        expect(missingRequiredArgs(tool({ type: 'object', required: ['a'] }), null)).toEqual([]);
    });
});
