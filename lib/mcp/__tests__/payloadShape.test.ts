import { extractShape } from '../payloadShape';

describe('extractShape', () => {
    it('keeps real field names and truncated values', () => {
        const payload = {
            dias: [{ dia: 'Dom, 11/out', saldo_do_dia: 'R$ 993,18', movimentacoes: [{ transaction_id: 'abc123' }] }],
        };
        const shape = extractShape(payload);
        expect(shape).toContain('dia:"Dom, 11/out"');
        expect(shape).toContain('saldo_do_dia:"R$ 993,18"');
        expect(shape).toContain('movimentacoes:[{transaction_id:"abc123"}]');
    });

    it('truncates long strings', () => {
        const shape = extractShape({ field: 'a'.repeat(100) });
        expect(shape).toContain(`"${'a'.repeat(24)}…"`);
        expect(shape).not.toContain('a'.repeat(25));
    });

    it('uses the first array item only and counts the rest', () => {
        const shape = extractShape({ items: [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }] });
        expect(shape).toContain('[{v:1}, …+3]');
    });

    it('respects max depth', () => {
        const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
        expect(extractShape(deep)).toContain('{…}');
    });

    it('handles empty arrays and objects', () => {
        expect(extractShape({ list: [], meta: {} })).toBe('{list:[], meta:{}}');
    });

    it('is cycle-safe and applies the total cap', () => {
        const node: any = { name: 'root' };
        node.self = node;
        expect(extractShape(node)).toContain('[circular]');

        // Nested wide objects genuinely exceed the 1500-char total cap.
        const inner = (): Record<string, string> =>
            Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`j${j}`, 'x'.repeat(50)]));
        const big: Record<string, Record<string, string>> = {};
        for (let i = 0; i < 200; i++) big[`key_${i}`] = inner();
        const shape = extractShape(big);
        expect(shape.length).toBeLessThanOrEqual(1501);
        expect(shape.endsWith('…')).toBe(true);
    });

    it('handles primitives', () => {
        expect(extractShape('plain')).toBe('"plain"');
        expect(extractShape(42)).toBe('42');
        expect(extractShape(null)).toBe('null');
    });
});
