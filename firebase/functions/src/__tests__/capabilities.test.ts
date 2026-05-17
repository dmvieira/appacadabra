import { ALL_CAPABILITIES, versionGte, buildSystemInstructions } from '../capabilities/index';
import { SYSTEM_PREAMBLE } from '../prompts';
import { FirebaseCapabilityDoc } from '../capabilities/types';

// ─── versionGte ──────────────────────────────────────────────────────────────

describe('versionGte', () => {
    it('1.0.0 >= 1.0.0 → true', () => expect(versionGte('1.0.0', '1.0.0')).toBe(true));
    it('1.1.0 >= 1.0.0 → true', () => expect(versionGte('1.1.0', '1.0.0')).toBe(true));
    it('2.0.0 >= 1.9.9 → true', () => expect(versionGte('2.0.0', '1.9.9')).toBe(true));
    it('0.9.9 >= 1.0.0 → false', () => expect(versionGte('0.9.9', '1.0.0')).toBe(false));
    it('1.0.0 >= 1.0.1 → false', () => expect(versionGte('1.0.0', '1.0.1')).toBe(false));
    it('1.0.1 >= 1.0.0 → true', () => expect(versionGte('1.0.1', '1.0.0')).toBe(true));
    it('1.0.0 >= 1.1.0 → false', () => expect(versionGte('1.0.0', '1.1.0')).toBe(false));
    it('10.0.0 >= 9.99.99 → true', () => expect(versionGte('10.0.0', '9.99.99')).toBe(true));

    it('handles non-numeric segments gracefully (treats as 0)', () => {
        expect(versionGte('1.x.0', '1.0.0')).toBe(true); // 'x' parses to 0, so 1.0.0 >= 1.0.0
        expect(() => versionGte('abc', 'def')).not.toThrow();
    });
});

// ─── ALL_CAPABILITIES ────────────────────────────────────────────────────────

describe('ALL_CAPABILITIES array', () => {
    it('all IDs are unique', () => {
        const ids = ALL_CAPABILITIES.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it.each(ALL_CAPABILITIES)('$id — conforms to FirebaseCapabilityDoc shape', (cap) => {
        expect(typeof cap.id).toBe('string');
        expect(cap.id.length).toBeGreaterThan(0);
        expect(typeof cap.displayName).toBe('string');
        expect(cap.displayName.length).toBeGreaterThan(0);
        expect(cap.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(typeof cap.docs).toBe('string');
        expect(cap.docs.length).toBeGreaterThan(0);
    });

});

// ─── buildSystemInstructions ─────────────────────────────────────────────────

describe('buildSystemInstructions', () => {
    it('returns SYSTEM_PREAMBLE when caps array is empty', () => {
        const result = buildSystemInstructions('1.0.0', []);
        expect(result).toBe(SYSTEM_PREAMBLE);
    });

    it('includes SYSTEM_PREAMBLE content in output', () => {
        const result = buildSystemInstructions('1.0.0', ALL_CAPABILITIES);
        expect(result).toContain(SYSTEM_PREAMBLE);
    });

    it('includes docs for all capabilities with version 2.0.0', () => {
        const result = buildSystemInstructions('2.0.0', ALL_CAPABILITIES);
        for (const cap of ALL_CAPABILITIES) {
            expect(result).toContain(cap.docs);
        }
    });

    it('excludes capabilities with minVersion higher than appVersion', () => {
        const futureCap: FirebaseCapabilityDoc = {
            id: 'future',
            displayName: 'Future',
            minVersion: '99.0.0',
            description: 'Future capability.',
            docs: 'FUTURE_CAP_DOCS_UNIQUE_STRING',
            validationMock: '    window.AppacadabraFuture = apiProxy;',
        };
        const caps = [...ALL_CAPABILITIES, futureCap];
        const result = buildSystemInstructions('1.0.0', caps);
        expect(result).not.toContain('FUTURE_CAP_DOCS_UNIQUE_STRING');
    });

    it('includes capabilities at exact minVersion threshold', () => {
        const exactCap: FirebaseCapabilityDoc = {
            id: 'exact',
            displayName: 'Exact',
            minVersion: '2.0.0',
            description: 'Exact capability.',
            docs: 'EXACT_CAP_DOCS_UNIQUE_STRING',
            validationMock: '    window.AppacadabraExact = apiProxy;',
        };
        const result = buildSystemInstructions('2.0.0', [exactCap]);
        expect(result).toContain('EXACT_CAP_DOCS_UNIQUE_STRING');
    });

    it('includes --- API DOCUMENTATION --- separator when caps are present', () => {
        const result = buildSystemInstructions('1.0.0', ALL_CAPABILITIES);
        expect(result).toContain('--- API DOCUMENTATION ---');
    });

    it('each included capability docs appears in output', () => {
        const subset: FirebaseCapabilityDoc[] = ALL_CAPABILITIES.slice(0, 4);
        const result = buildSystemInstructions('1.0.0', subset);
        for (const cap of subset) {
            expect(result).toContain(cap.docs);
        }
    });

    it('excludes capabilities with minVersion just above appVersion', () => {
        const nearFutureCap: FirebaseCapabilityDoc = {
            id: 'nearfuture',
            displayName: 'Near Future',
            minVersion: '1.0.1',
            description: 'Near future capability.',
            docs: 'NEAR_FUTURE_CAP_UNIQUE',
            validationMock: '    window.AppacadabraNearFuture = apiProxy;',
        };
        const result = buildSystemInstructions('1.0.0', [nearFutureCap]);
        expect(result).not.toContain('NEAR_FUTURE_CAP_UNIQUE');
    });
});
