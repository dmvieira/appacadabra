/**
 * Capability Registry — app side.
 *
 * ALL_CAPABILITIES is the ordered list of capability modules.
 * Add a new module here after creating its file in lib/capabilities/.
 *
 * Phase 1: empty — all injectedJS and message handling still in the legacy files.
 * Phase 2+: migrate capabilities one by one.
 */

import { CapabilityModule } from './types';

/**
 * Capabilities disabled for this release.
 * The sync script removes their permissions from app.json and AndroidManifest.xml.
 * Re-enable by uncommenting the id.
 */
export const DISABLED_CAPABILITIES = new Set<string>([]);
import { clipboardCapability } from './clipboard';
import { shareCapability } from './share';
import { screenCapability } from './screen';
import { deviceCapability } from './device';
import { calendarCapability } from './calendar';
import { notifyCapability } from './notify';
import { healthCapability } from './health';
import { contactsCapability } from './contacts';
import { sensorsCapability } from './sensors';
import { uiCapability } from './ui';
import { cameraCapability } from './camera';
import { audioCapability } from './audio';
import { formsCapability } from './forms';
import { docsCapability } from './docs';
import { sheetsCapability } from './sheets';
import { aiCapability } from './ai';

export const ALL_CAPABILITIES: CapabilityModule[] = [
    clipboardCapability,
    shareCapability,
    screenCapability,
    deviceCapability,
    calendarCapability,
    notifyCapability,
    healthCapability,
    contactsCapability,
    sensorsCapability,
    uiCapability,
    cameraCapability,
    audioCapability,
    formsCapability,
    docsCapability,
    sheetsCapability,
    aiCapability,
].filter(cap => !DISABLED_CAPABILITIES.has(cap.id));

/**
 * Assembles the injected JavaScript for all registered capabilities.
 * Called by getInjectedJavaScript() — empty array = empty string (no-op in Phase 1).
 */
export function buildInjectedJSFromCapabilities(appId: number, isEditMode: boolean): string {
    return ALL_CAPABILITIES.map(cap => cap.getInjectedJS(appId, isEditMode)).join('\n');
}
