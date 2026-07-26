/**
 * ModelUnavailableModal — covers the two exit paths:
 *   • "Choose another" → dismiss + router.push to Settings with openPicker param.
 *   • "Use default" → dismiss + clearPreferredModel + refreshMissingModelTasks
 *     + bumpAiKeyVersion, in that order.
 *
 * When no request is active the modal renders nothing (used to gate visibility
 * off the bridge store).
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockRouterPush = jest.fn();
const mockDismissModelUnavailable = jest.fn();
const mockBumpAiKeyVersion = jest.fn();
const mockRefreshMissingModelTasks = jest.fn();
const mockClearPreferredModel = jest.fn(async () => {});

let mockBridgeSelector: (s: any) => any;
let mockAppSelector: (s: any) => any;
let mockBridgeState: any = {
    modelUnavailableRequest: null,
    dismissModelUnavailable: mockDismissModelUnavailable,
};
const mockAppState = {
    bumpAiKeyVersion: mockBumpAiKeyVersion,
    refreshMissingModelTasks: mockRefreshMissingModelTasks,
};

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('../../lib/bridgeUIStore', () => ({
    useBridgeUIStore: (selector: any) => {
        mockBridgeSelector = selector;
        return selector(mockBridgeState);
    },
}));

jest.mock('../../lib/store', () => ({
    useAppStore: (selector: any) => {
        mockAppSelector = selector;
        return selector(mockAppState);
    },
}));

jest.mock('../../lib/api/modelPreferences', () => ({
    clearPreferredModel: (...a: any[]) => mockClearPreferredModel(...a),
}));

jest.mock('../../lib/api/modelCatalog', () => ({
    TASK_LABEL_KEYS: {
        SPELL_S: 'openrouterTaskSpellS',
        WEBVIEW: 'openrouterTaskWebview',
        TTS: 'openrouterTaskTts',
    },
}));

jest.mock('../../lib/i18n', () => ({
    t: (key: string) => key,
}));

import { ModelUnavailableModal } from '../ModelUnavailableModal';

beforeEach(() => {
    jest.clearAllMocks();
    mockBridgeState = {
        modelUnavailableRequest: null,
        dismissModelUnavailable: mockDismissModelUnavailable,
    };
});

describe('ModelUnavailableModal', () => {
    it('renders nothing when there is no active request', async () => {
        const { toJSON } = await render(<ModelUnavailableModal />);
        expect(toJSON()).toBeNull();
    });

    it('renders the dialog when a request is active', async () => {
        mockBridgeState = {
            modelUnavailableRequest: { appId: null, taskKey: 'SPELL_S', modelId: 'dead/model' },
            dismissModelUnavailable: mockDismissModelUnavailable,
        };
        const { getByText } = await render(<ModelUnavailableModal />);
        expect(getByText(/openrouterModelUnavailableTitle/)).toBeTruthy();
        expect(getByText('openrouterModelUnavailableChooseAnother')).toBeTruthy();
        expect(getByText('openrouterModelUnavailableUseDefault')).toBeTruthy();
    });

    it('"Choose another" dismisses the modal and pushes Settings with openPicker=<TaskKey>', async () => {
        mockBridgeState = {
            modelUnavailableRequest: { appId: 7, taskKey: 'WEBVIEW', modelId: 'dead/model' },
            dismissModelUnavailable: mockDismissModelUnavailable,
        };
        const { getByText } = await render(<ModelUnavailableModal />);

        fireEvent.press(getByText('openrouterModelUnavailableChooseAnother'));

        expect(mockDismissModelUnavailable).toHaveBeenCalledTimes(1);
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/settings/openrouter',
            params: { openPicker: 'WEBVIEW' },
        });
    });

    it('"Use default" clears the pref, refreshes missing tasks, bumps key version', async () => {
        mockBridgeState = {
            modelUnavailableRequest: { appId: null, taskKey: 'TTS', modelId: 'gone/tts' },
            dismissModelUnavailable: mockDismissModelUnavailable,
        };
        const order: string[] = [];
        mockClearPreferredModel.mockImplementation(async () => { order.push('clear'); });
        mockRefreshMissingModelTasks.mockImplementation(async () => { order.push('refresh'); });
        mockBumpAiKeyVersion.mockImplementation(() => { order.push('bump'); });
        mockDismissModelUnavailable.mockImplementation(() => { order.push('dismiss'); });

        const { getByText } = await render(<ModelUnavailableModal />);

        await act(async () => {
            fireEvent.press(getByText('openrouterModelUnavailableUseDefault'));
        });

        expect(mockClearPreferredModel).toHaveBeenCalledWith('TTS');
        // Dismiss fires synchronously first, then clear → refresh → bump.
        expect(order).toEqual(['dismiss', 'clear', 'refresh', 'bump']);
    });
});
