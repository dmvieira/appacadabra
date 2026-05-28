// Web/fallback stub — Metro resolves health.android.ts and health.ios.ts first.
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const healthCapability: CapabilityModule = {
    id: 'health',
    displayName: 'Health',
    minVersion: '2.0.0',
    description: 'Health data access.',
    androidPermissions: [],
    manifestBlocks: [],
    docs: '',
    validationMock: '    window.AppacadabraHealth = apiProxy;',
    getInjectedJS: () => '',
    handleMessage: async (_type: string, _data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        return { success: false, result: 'Health not available on this platform' };
    },
};
