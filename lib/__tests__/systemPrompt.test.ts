import { buildSystemInstructions, SYSTEM_PREAMBLE, versionGte } from '../api/systemPrompt';
import { ALL_CAPABILITIES } from '../capabilities';

describe('versionGte', () => {
    it('returns true for equal versions', () => {
        expect(versionGte('2.0.15', '2.0.15')).toBe(true);
    });
    it('returns true when appVersion is newer', () => {
        expect(versionGte('2.1.0', '2.0.15')).toBe(true);
        expect(versionGte('3.0.0', '2.99.99')).toBe(true);
    });
    it('returns false when appVersion is older', () => {
        expect(versionGte('2.0.14', '2.0.15')).toBe(false);
        expect(versionGte('1.9.99', '2.0.0')).toBe(false);
    });
});

describe('buildSystemInstructions', () => {
    it('returns just the preamble when no capabilities are passed', () => {
        expect(buildSystemInstructions('2.0.15', [])).toBe(SYSTEM_PREAMBLE);
    });

    it('joins available capability docs with the canonical separator', () => {
        const out = buildSystemInstructions('99.99.99', ALL_CAPABILITIES);
        expect(out.startsWith(SYSTEM_PREAMBLE)).toBe(true);
        expect(out).toContain('--- API DOCUMENTATION ---');
        for (const cap of ALL_CAPABILITIES) {
            expect(out).toContain(cap.docs);
        }
    });

    it('omits capabilities whose minVersion is newer than the app version', () => {
        const future = ALL_CAPABILITIES.map(c => ({ ...c, minVersion: '999.0.0' }));
        const out = buildSystemInstructions('2.0.15', future);
        expect(out).toBe(SYSTEM_PREAMBLE);
    });
});
