import {
    applyManifestBlocks,
    applyPermissionsBlock,
    parseDisabledCapabilities,
    parseManifestBlocks,
} from '../sync-capability-docs';
import type { ManifestBlock } from '../sync-capability-docs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Anchors for each of the 3 health blocks (exactly as defined in CAPABILITY_MANIFEST_BLOCKS)
const HEALTH_QUERIES_ANCHOR = '<!-- CAPABILITY:health:queries:anchor -->';
const HEALTH_MAIN_ACTIVITY_ANCHOR = '<!-- CAPABILITY:health:mainActivity:anchor -->';
const HEALTH_APPLICATION_ANCHOR = '<!-- CAPABILITY:health:application:anchor -->';

// XML content for each block (exactly as defined in CAPABILITY_MANIFEST_BLOCKS)
const HEALTH_QUERIES_XML = `  <queries>\n    <package android:name="com.google.android.apps.healthdata"/>\n  </queries>`;
const HEALTH_MAIN_ACTIVITY_XML = `      <intent-filter>\n        <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE"/>\n      </intent-filter>`;
const HEALTH_APPLICATION_XML = `    <activity-alias android:name="ViewPermissionUsageActivity" android:exported="true" android:targetActivity=".MainActivity" android:permission="android.permission.START_VIEW_PERMISSION_USAGE">\n      <intent-filter>\n        <action android:name="android.intent.action.VIEW_PERMISSION_USAGE"/>\n        <category android:name="android.intent.category.HEALTH_PERMISSIONS"/>\n      </intent-filter>\n    </activity-alias>`;

// Full block strings produced by applyManifestBlocks when health is enabled
const HEALTH_QUERIES_BLOCK = `  <!-- CAPABILITY:health:start -->\n${HEALTH_QUERIES_XML}\n  <!-- CAPABILITY:health:end -->`;
const HEALTH_MAIN_ACTIVITY_BLOCK = `  <!-- CAPABILITY:health:start -->\n${HEALTH_MAIN_ACTIVITY_XML}\n  <!-- CAPABILITY:health:end -->`;
const HEALTH_APPLICATION_BLOCK = `  <!-- CAPABILITY:health:start -->\n${HEALTH_APPLICATION_XML}\n  <!-- CAPABILITY:health:end -->`;

/** Minimal manifest with all health anchors (capability disabled / collapsed state). */
function makeAnchorManifest(): string {
    return [
        '<manifest>',
        `  ${HEALTH_QUERIES_ANCHOR}`,
        '  <application>',
        `    <activity>`,
        `      ${HEALTH_MAIN_ACTIVITY_ANCHOR}`,
        `    </activity>`,
        `    ${HEALTH_APPLICATION_ANCHOR}`,
        '  </application>',
        '</manifest>',
    ].join('\n');
}

/** Minimal manifest with all health blocks expanded (capability enabled state). */
function makeBlockManifest(): string {
    return [
        '<manifest>',
        `  ${HEALTH_QUERIES_BLOCK}`,
        '  <application>',
        `    <activity>`,
        `      ${HEALTH_MAIN_ACTIVITY_BLOCK}`,
        `    </activity>`,
        `    ${HEALTH_APPLICATION_BLOCK}`,
        '  </application>',
        '</manifest>',
    ].join('\n');
}

/** Minimal manifest with CAPABILITY_PERMISSIONS markers. */
function makePermManifest(existingPerms: string[] = []): string {
    const permLines = existingPerms.map(p => `  <uses-permission android:name="${p}"/>`).join('\n');
    const inner = existingPerms.length ? `\n${permLines}\n` : '\n';
    return `<manifest>\n  <!-- CAPABILITY_PERMISSIONS:start -->${inner}  <!-- CAPABILITY_PERMISSIONS:end -->\n</manifest>`;
}

const HEALTH_BLOCKS = new Map<string, ManifestBlock[]>([
    ['health', [
        { anchor: HEALTH_QUERIES_ANCHOR, xml: HEALTH_QUERIES_XML },
        { anchor: HEALTH_MAIN_ACTIVITY_ANCHOR, xml: HEALTH_MAIN_ACTIVITY_XML },
        { anchor: HEALTH_APPLICATION_ANCHOR, xml: HEALTH_APPLICATION_XML },
    ]],
]);
const EMPTY_BLOCKS = new Map<string, ManifestBlock[]>();

const ENABLED = new Set<string>();
const HEALTH_DISABLED = new Set(['health']);

// ─── applyManifestBlocks ──────────────────────────────────────────────────────

describe('applyManifestBlocks', () => {
    describe('anchor → block (enable)', () => {
        it('replaces queries anchor with block when health enabled', () => {
            const input = `<manifest>\n  ${HEALTH_QUERIES_ANCHOR}\n</manifest>`;
            const result = applyManifestBlocks(input, ENABLED, HEALTH_BLOCKS);
            expect(result).toContain(HEALTH_QUERIES_BLOCK);
            expect(result).not.toContain(HEALTH_QUERIES_ANCHOR);
        });

        it('replaces mainActivity anchor with block when health enabled', () => {
            const input = `<manifest>\n  ${HEALTH_MAIN_ACTIVITY_ANCHOR}\n</manifest>`;
            const result = applyManifestBlocks(input, ENABLED, HEALTH_BLOCKS);
            expect(result).toContain(HEALTH_MAIN_ACTIVITY_BLOCK);
            expect(result).not.toContain(HEALTH_MAIN_ACTIVITY_ANCHOR);
        });

        it('replaces application anchor with block when health enabled', () => {
            const input = `<manifest>\n  ${HEALTH_APPLICATION_ANCHOR}\n</manifest>`;
            const result = applyManifestBlocks(input, ENABLED, HEALTH_BLOCKS);
            expect(result).toContain(HEALTH_APPLICATION_BLOCK);
            expect(result).not.toContain(HEALTH_APPLICATION_ANCHOR);
        });

        it('replaces all 3 anchors independently without cross-contamination', () => {
            const result = applyManifestBlocks(makeAnchorManifest(), ENABLED, HEALTH_BLOCKS);

            expect(result).toContain(HEALTH_QUERIES_BLOCK);
            expect(result).toContain(HEALTH_MAIN_ACTIVITY_BLOCK);
            expect(result).toContain(HEALTH_APPLICATION_BLOCK);

            // Each anchor must be gone
            expect(result).not.toContain(HEALTH_QUERIES_ANCHOR);
            expect(result).not.toContain(HEALTH_MAIN_ACTIVITY_ANCHOR);
            expect(result).not.toContain(HEALTH_APPLICATION_ANCHOR);

            // Each block's XML must appear exactly once (no cross-contamination)
            const queriesXmlCount = (result.match(/com\.google\.android\.apps\.healthdata/g) ?? []).length;
            const mainActivityXmlCount = (result.match(/ACTION_SHOW_PERMISSIONS_RATIONALE/g) ?? []).length;
            const applicationXmlCount = (result.match(/ViewPermissionUsageActivity/g) ?? []).length;
            expect(queriesXmlCount).toBe(1);
            expect(mainActivityXmlCount).toBe(1);
            expect(applicationXmlCount).toBe(1);
        });
    });

    describe('block → anchor (disable)', () => {
        it('replaces queries block with anchor when health disabled', () => {
            const input = `<manifest>\n  ${HEALTH_QUERIES_BLOCK}\n</manifest>`;
            const result = applyManifestBlocks(input, HEALTH_DISABLED, HEALTH_BLOCKS);
            expect(result).toContain(HEALTH_QUERIES_ANCHOR);
            expect(result).not.toContain('<!-- CAPABILITY:health:start -->');
        });

        it('replaces all 3 blocks with anchors when health disabled', () => {
            const result = applyManifestBlocks(makeBlockManifest(), HEALTH_DISABLED, HEALTH_BLOCKS);

            expect(result).toContain(HEALTH_QUERIES_ANCHOR);
            expect(result).toContain(HEALTH_MAIN_ACTIVITY_ANCHOR);
            expect(result).toContain(HEALTH_APPLICATION_ANCHOR);

            expect(result).not.toContain('<!-- CAPABILITY:health:start -->');
            expect(result).not.toContain('<!-- CAPABILITY:health:end -->');
        });
    });

    describe('idempotence', () => {
        it('is idempotent: enabled→sync→sync gives same result', () => {
            const once = applyManifestBlocks(makeAnchorManifest(), ENABLED, HEALTH_BLOCKS);
            const twice = applyManifestBlocks(once, ENABLED, HEALTH_BLOCKS);
            expect(twice).toBe(once);
        });

        it('is idempotent: disabled→sync→sync gives same result', () => {
            const once = applyManifestBlocks(makeBlockManifest(), HEALTH_DISABLED, HEALTH_BLOCKS);
            const twice = applyManifestBlocks(once, HEALTH_DISABLED, HEALTH_BLOCKS);
            expect(twice).toBe(once);
        });
    });

    describe('no-op cases', () => {
        it('does nothing when capability is active and blocks are already present', () => {
            const blockManifest = makeBlockManifest();
            const result = applyManifestBlocks(blockManifest, ENABLED, HEALTH_BLOCKS);
            expect(result).toBe(blockManifest);
        });

        it('does nothing when capability is disabled and anchors are already present', () => {
            const anchorManifest = makeAnchorManifest();
            const result = applyManifestBlocks(anchorManifest, HEALTH_DISABLED, HEALTH_BLOCKS);
            expect(result).toBe(anchorManifest);
        });
    });
});

// ─── applyPermissionsBlock ────────────────────────────────────────────────────

describe('applyPermissionsBlock', () => {
    it('inserts sorted permissions between start/end markers', () => {
        const result = applyPermissionsBlock(
            makePermManifest(),
            ['android.permission.CAMERA', 'android.permission.ACTIVITY_RECOGNITION'],
        );
        expect(result).toContain('android.permission.ACTIVITY_RECOGNITION');
        expect(result).toContain('android.permission.CAMERA');
        // Must be sorted: ACTIVITY_RECOGNITION before CAMERA
        const arIdx = result.indexOf('ACTIVITY_RECOGNITION');
        const camIdx = result.indexOf('CAMERA');
        expect(arIdx).toBeLessThan(camIdx);
    });

    it('removes permissions when list is empty', () => {
        const input = makePermManifest(['android.permission.CAMERA']);
        const result = applyPermissionsBlock(input, []);
        expect(result).not.toContain('android.permission.CAMERA');
        expect(result).toContain('<!-- CAPABILITY_PERMISSIONS:start -->');
        expect(result).toContain('<!-- CAPABILITY_PERMISSIONS:end -->');
    });

    it('replaces existing permission list with new one', () => {
        const input = makePermManifest(['android.permission.OLD_PERM']);
        const result = applyPermissionsBlock(input, ['android.permission.NEW_PERM']);
        expect(result).not.toContain('android.permission.OLD_PERM');
        expect(result).toContain('android.permission.NEW_PERM');
    });

    it('is idempotent', () => {
        const perms = ['android.permission.CAMERA', 'android.permission.ACTIVITY_RECOGNITION'];
        const once = applyPermissionsBlock(makePermManifest(), perms);
        const twice = applyPermissionsBlock(once, perms);
        expect(twice).toBe(once);
    });
});

// ─── parseManifestBlocks ──────────────────────────────────────────────────────

describe('parseManifestBlocks', () => {
    it('returns [] for source without manifestBlocks', () => {
        const src = `export const fooCapability = { id: 'foo', androidPermissions: ['android.permission.CAMERA'] };`;
        expect(parseManifestBlocks(src)).toEqual([]);
    });

    it('extracts all 3 health blocks in order', () => {
        const src = `
export const healthCapability = {
    manifestBlocks: [
        {
            anchor: '<!-- CAPABILITY:health:queries:anchor -->',
            xml: \`  <queries>\\n    <package android:name="com.google.android.apps.healthdata"/>\\n  </queries>\`,
        },
        {
            anchor: '<!-- CAPABILITY:health:mainActivity:anchor -->',
            xml: \`      <intent-filter>\\n        <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE"/>\\n      </intent-filter>\`,
        },
        {
            anchor: '<!-- CAPABILITY:health:application:anchor -->',
            xml: \`    <activity-alias android:name="ViewPermissionUsageActivity" android:exported="true" android:targetActivity=".MainActivity" android:permission="android.permission.START_VIEW_PERMISSION_USAGE">\\n      <intent-filter>\\n        <action android:name="android.intent.action.VIEW_PERMISSION_USAGE"/>\\n        <category android:name="android.intent.category.HEALTH_PERMISSIONS"/>\\n      </intent-filter>\\n    </activity-alias>\`,
        },
    ],
};`;
        const result = parseManifestBlocks(src);
        expect(result).toHaveLength(3);
        expect(result[0].anchor).toBe(HEALTH_QUERIES_ANCHOR);
        expect(result[1].anchor).toBe(HEALTH_MAIN_ACTIVITY_ANCHOR);
        expect(result[2].anchor).toBe(HEALTH_APPLICATION_ANCHOR);
    });

    it('processes \\n in xml template literals as real newlines', () => {
        const src = `
const cap = {
    manifestBlocks: [
        { anchor: '<!-- test:anchor -->', xml: \`line1\\nline2\` },
    ],
};`;
        const result = parseManifestBlocks(src);
        expect(result).toHaveLength(1);
        expect(result[0].xml).toBe('line1\nline2');
    });

    it('extracts multiple blocks maintaining order', () => {
        const src = `
const cap = {
    manifestBlocks: [
        { anchor: '<!-- cap:alpha:anchor -->', xml: \`alpha-xml\` },
        { anchor: '<!-- cap:beta:anchor -->', xml: \`beta-xml\` },
        { anchor: '<!-- cap:gamma:anchor -->', xml: \`gamma-xml\` },
    ],
};`;
        const result = parseManifestBlocks(src);
        expect(result).toHaveLength(3);
        expect(result[0].anchor).toBe('<!-- cap:alpha:anchor -->');
        expect(result[1].anchor).toBe('<!-- cap:beta:anchor -->');
        expect(result[2].anchor).toBe('<!-- cap:gamma:anchor -->');
        expect(result[0].xml).toBe('alpha-xml');
        expect(result[1].xml).toBe('beta-xml');
        expect(result[2].xml).toBe('gamma-xml');
    });
});

// ─── parseDisabledCapabilities ────────────────────────────────────────────────

describe('parseDisabledCapabilities', () => {
    it('returns empty set when no entries are uncommented', () => {
        const src = `
const DISABLED_CAPABILITIES = new Set<string>([
    // 'health',
    // 'clipboard',
]);`;
        expect(parseDisabledCapabilities(src).size).toBe(0);
    });

    it('parses uncommented capability ids', () => {
        const src = `
const DISABLED_CAPABILITIES = new Set<string>([
    'health',
    'clipboard',
]);`;
        const result = parseDisabledCapabilities(src);
        expect(result.has('health')).toBe(true);
        expect(result.has('clipboard')).toBe(true);
        expect(result.size).toBe(2);
    });

    it('ignores commented entries', () => {
        const src = `
const DISABLED_CAPABILITIES = new Set<string>([
    'health',
    // 'clipboard',
]);`;
        const result = parseDisabledCapabilities(src);
        expect(result.has('health')).toBe(true);
        expect(result.has('clipboard')).toBe(false);
        expect(result.size).toBe(1);
    });
});
