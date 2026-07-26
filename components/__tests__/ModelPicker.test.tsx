/**
 * ModelPicker — covers the three visual states (loading / error / list),
 * confirmation ordering (`snapshotPricing` → `setPreferredModel` →
 * `refreshMissingModelTasks`), and the search-filter narrowing.
 *
 * The picker's data flow is:
 *   Promise.all([getModelCatalog, getPreferredModel, getTierDefaultModel])
 * → filterModelsForTask → render → user taps → snapshotPricing → setPreferredModel
 * → refreshMissingModelTasks → onClose.
 *
 * All external deps are mocked so we can assert both render output and the
 * exact call ordering of the confirmation side-effects.
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockGetModelCatalog = jest.fn();
const mockFilterModelsForTask = jest.fn();
const mockSnapshotPricing = jest.fn();
const mockParsePricingFromModel = jest.fn();
const mockGetPreferredModel = jest.fn();
const mockSetPreferredModel = jest.fn();
const mockClearPreferredModel = jest.fn();
const mockGetTierDefaultModel = jest.fn();
const mockRefreshMissingModelTasks = jest.fn();
const mockUseAppStore = jest.fn();

jest.mock('../../lib/api/modelCatalog', () => ({
    getModelCatalog: (...a: any[]) => mockGetModelCatalog(...a),
    filterModelsForTask: (...a: any[]) => mockFilterModelsForTask(...a),
    snapshotPricing: (...a: any[]) => mockSnapshotPricing(...a),
    parsePricingFromModel: (...a: any[]) => mockParsePricingFromModel(...a),
}));

jest.mock('../../lib/api/modelPreferences', () => ({
    getPreferredModel: (...a: any[]) => mockGetPreferredModel(...a),
    setPreferredModel: (...a: any[]) => mockSetPreferredModel(...a),
    clearPreferredModel: (...a: any[]) => mockClearPreferredModel(...a),
    getTierDefaultModel: (...a: any[]) => mockGetTierDefaultModel(...a),
}));

jest.mock('../../lib/store', () => ({
    useAppStore: (selector: any) => mockUseAppStore(selector),
}));

jest.mock('../../lib/i18n', () => ({
    // Return the key back so assertions can match on it.
    t: (key: string) => key,
}));

import { ModelPicker } from '../ModelPicker';

const modelA = {
    id: 'anthropic/claude-3-opus',
    name: 'Claude 3 Opus',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000015', completion: '0.000075' },
    supported_parameters: ['reasoning'],
};
const modelB = {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000005', completion: '0.000015' },
    supported_parameters: ['reasoning'],
};

beforeEach(() => {
    jest.clearAllMocks();
    mockUseAppStore.mockImplementation(() => mockRefreshMissingModelTasks);
    mockGetPreferredModel.mockResolvedValue('deepseek/deepseek-v4-flash');
    mockGetTierDefaultModel.mockResolvedValue('deepseek/deepseek-v4-flash');
    mockParsePricingFromModel.mockReturnValue({ inputPerMToken: 5, outputPerMToken: 15 });
    mockFilterModelsForTask.mockImplementation((_key, catalog) => catalog);
});

describe('ModelPicker', () => {
    it('renders the loading state before the catalog resolves', async () => {
        let resolveCatalog: (v: any) => void = () => {};
        mockGetModelCatalog.mockReturnValue(
            new Promise(res => { resolveCatalog = res; }),
        );

        const { getByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={jest.fn()} />,
        );

        expect(getByText('openrouterModelPickerLoading')).toBeTruthy();
        await act(async () => { resolveCatalog([]); });
    });

    it('renders the error state when getModelCatalog rejects', async () => {
        mockGetModelCatalog.mockRejectedValueOnce(new Error('offline'));

        const { findByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={jest.fn()} />,
        );

        expect(await findByText('openrouterModelPickerError')).toBeTruthy();
        expect(await findByText('offline')).toBeTruthy();
    });

    it('renders the model list once the catalog resolves', async () => {
        mockGetModelCatalog.mockResolvedValueOnce([modelA, modelB]);

        const { findByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={jest.fn()} />,
        );

        expect(await findByText('Claude 3 Opus')).toBeTruthy();
        expect(await findByText('GPT-4o')).toBeTruthy();
    });

    it('renders empty-state copy when the search filter matches nothing', async () => {
        mockGetModelCatalog.mockResolvedValueOnce([modelA, modelB]);

        const { findByText, getByPlaceholderText, queryByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={jest.fn()} />,
        );

        await findByText('Claude 3 Opus');
        fireEvent.changeText(getByPlaceholderText('openrouterModelPickerSearch'), 'zzzzz');

        await waitFor(() => {
            expect(queryByText('Claude 3 Opus')).toBeNull();
        });
        expect(await findByText('openrouterModelPickerEmpty')).toBeTruthy();
    });

    it('invokes snapshotPricing → setPreferredModel → refreshMissingModelTasks → onClose on confirm', async () => {
        mockGetModelCatalog.mockResolvedValueOnce([modelA]);
        const order: string[] = [];
        mockSnapshotPricing.mockImplementation(async () => { order.push('snapshot'); });
        mockSetPreferredModel.mockImplementation(async () => { order.push('setPref'); });
        mockRefreshMissingModelTasks.mockImplementation(async () => { order.push('refresh'); });
        const onClose = jest.fn(() => { order.push('close'); });

        const { findByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={onClose} />,
        );

        const row = await findByText('Claude 3 Opus');
        await act(async () => { fireEvent.press(row); });

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(order).toEqual(['snapshot', 'setPref', 'refresh', 'close']);
        expect(mockSnapshotPricing).toHaveBeenCalledWith(modelA.id, modelA);
        expect(mockSetPreferredModel).toHaveBeenCalledWith('SPELL_S', modelA.id);
    });

    it('reset button clears the preference and closes without touching snapshotPricing', async () => {
        mockGetModelCatalog.mockResolvedValueOnce([modelA]);
        const onClose = jest.fn();

        const { findByText, getByText } = await render(
            <ModelPicker taskKey="SPELL_S" taskLabel="Spell" onClose={onClose} />,
        );

        await findByText('Claude 3 Opus');
        await act(async () => { fireEvent.press(getByText('openrouterModelResetBtn')); });

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(mockClearPreferredModel).toHaveBeenCalledWith('SPELL_S');
        expect(mockRefreshMissingModelTasks).toHaveBeenCalled();
        expect(mockSnapshotPricing).not.toHaveBeenCalled();
    });
});
