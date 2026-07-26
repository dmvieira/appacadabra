/**
 * ModelPicker — lets the user pick which OpenRouter model handles a task.
 *
 * Filters the live catalog by the task's I/O modality requirements
 * (`TASK_REQUIREMENTS` in `modelCatalog.ts`). Confirmation writes the
 * selection through `setPreferredModel` and snapshots the model's pricing
 * to Cache B so subsequent cost calculations resolve locally with no I/O.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    TextInput,
    FlatList,
    ActivityIndicator,
    Platform,
} from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { MODELS } from '../lib/api/pricing';
import {
    getModelCatalog,
    filterModelsForTask,
    snapshotPricing,
    parsePricingFromModel,
    type OpenRouterModel,
    type TaskKey,
} from '../lib/api/modelCatalog';
import {
    getPreferredModel,
    setPreferredModel,
    clearPreferredModel,
    getTierDefaultModel,
} from '../lib/api/modelPreferences';
import { useAppStore } from '../lib/store';

interface Props {
    taskKey: TaskKey | null;
    taskLabel: string;
    onClose: () => void;
}

type LoadState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; models: OpenRouterModel[] };

export function ModelPicker({ taskKey, taskLabel, onClose }: Props) {
    const refreshMissingModelTasks = useAppStore(s => s.refreshMissingModelTasks);
    const [state, setState] = useState<LoadState>({ kind: 'loading' });
    const [currentModelId, setCurrentModelId] = useState<string | null>(null);
    const [tierDefaultId, setTierDefaultId] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    const [confirmingId, setConfirmingId] = useState<string | null>(null);

    const load = useCallback(async (force: boolean) => {
        if (!taskKey) return;
        setState({ kind: 'loading' });
        try {
            const [catalog, chosen, tierDefault] = await Promise.all([
                getModelCatalog(force ? { force: true } : undefined),
                getPreferredModel(taskKey),
                getTierDefaultModel(taskKey),
            ]);
            const filtered = filterModelsForTask(taskKey, catalog);
            setCurrentModelId(chosen);
            setTierDefaultId(tierDefault);
            setState({ kind: 'ready', models: filtered });
        } catch (e) {
            setState({
                kind: 'error',
                message: e instanceof Error ? e.message : t('openrouterModelPickerError'),
            });
        }
    }, [taskKey]);

    useEffect(() => {
        if (taskKey) void load(false);
    }, [taskKey, load]);

    const handleSelect = async (model: OpenRouterModel) => {
        if (!taskKey) return;
        setConfirmingId(model.id);
        try {
            await snapshotPricing(model.id, model);
            await setPreferredModel(taskKey, model.id);
            await refreshMissingModelTasks();
            onClose();
        } finally {
            setConfirmingId(null);
        }
    };

    const handleReset = async () => {
        if (!taskKey) return;
        await clearPreferredModel(taskKey);
        await refreshMissingModelTasks();
        onClose();
    };

    const visibleModels = useMemo(() => {
        if (state.kind !== 'ready') return [];
        const q = filter.trim().toLowerCase();
        if (!q) return state.models;
        return state.models.filter(m => {
            const id = m.id.toLowerCase();
            const name = (m.name ?? '').toLowerCase();
            return id.includes(q) || name.includes(q);
        });
    }, [state, filter]);

    if (!taskKey) return null;

    const defaultId = tierDefaultId ?? MODELS[taskKey];

    return (
        <Modal visible={true} transparent animationType="slide" onRequestClose={onClose}>
            <View style={styles.overlay}>
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <Text style={styles.title}>
                            {t('openrouterModelPickerTitle').replace('{task}', taskLabel)}
                        </Text>
                        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                            <Text style={styles.closeText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <View style={styles.defaultRow}>
                        <View style={styles.defaultLabel}>
                            <Text style={styles.defaultText}>{t('openrouterModelDefault')}</Text>
                            <Text style={styles.defaultId}>{defaultId}</Text>
                        </View>
                        <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
                            <Text style={styles.resetText}>{t('openrouterModelResetBtn')}</Text>
                        </TouchableOpacity>
                    </View>

                    <View style={styles.searchRow}>
                        <TextInput
                            style={styles.search}
                            placeholder={t('openrouterModelPickerSearch')}
                            placeholderTextColor={colors.onSurfaceVariant}
                            value={filter}
                            onChangeText={setFilter}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity onPress={() => load(true)} style={styles.refreshBtn}>
                            <Text style={styles.refreshText}>{t('openrouterModelPickerRefresh')}</Text>
                        </TouchableOpacity>
                    </View>

                    {state.kind === 'loading' && (
                        <View style={styles.centered}>
                            <ActivityIndicator color={colors.primary} />
                            <Text style={styles.dim}>{t('openrouterModelPickerLoading')}</Text>
                        </View>
                    )}

                    {state.kind === 'error' && (
                        <View style={styles.centered}>
                            <Text style={styles.errorText}>{t('openrouterModelPickerError')}</Text>
                            <Text style={styles.dim}>{state.message}</Text>
                        </View>
                    )}

                    {state.kind === 'ready' && visibleModels.length === 0 && (
                        <View style={styles.centered}>
                            <Text style={styles.dim}>{t('openrouterModelPickerEmpty')}</Text>
                        </View>
                    )}

                    {state.kind === 'ready' && visibleModels.length > 0 && (
                        <FlatList
                            data={visibleModels}
                            keyExtractor={m => m.id}
                            renderItem={({ item }) => (
                                <ModelRow
                                    model={item}
                                    isChosen={item.id === currentModelId}
                                    isConfirming={item.id === confirmingId}
                                    onPress={() => handleSelect(item)}
                                />
                            )}
                            keyboardShouldPersistTaps="handled"
                        />
                    )}
                </View>
            </View>
        </Modal>
    );
}

interface RowProps {
    model: OpenRouterModel;
    isChosen: boolean;
    isConfirming: boolean;
    onPress: () => void;
}

function ModelRow({ model, isChosen, isConfirming, onPress }: RowProps) {
    const pricing = parsePricingFromModel(model);
    const priceLine = pricing
        ? t('openrouterPricePerM')
              .replace('${in}', formatDollarsPerM(pricing.inputPerMToken))
              .replace('${out}', formatDollarsPerM(pricing.outputPerMToken))
        : '—';
    const inMods = model.architecture?.input_modalities ?? [];
    const outMods = model.architecture?.output_modalities ?? [];

    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={isConfirming}
            style={[styles.row, isChosen && styles.rowChosen, isConfirming && styles.rowDisabled]}
        >
            <View style={styles.rowMain}>
                <Text style={styles.rowName} numberOfLines={1}>
                    {model.name ?? model.id}
                </Text>
                <Text style={styles.rowId} numberOfLines={1}>
                    {model.id}
                </Text>
                <View style={styles.badges}>
                    {inMods.map(m => (
                        <Badge key={`in-${m}`} label={`in:${m}`} tone="in" />
                    ))}
                    {outMods.map(m => (
                        <Badge key={`out-${m}`} label={`out:${m}`} tone="out" />
                    ))}
                </View>
                <Text style={styles.rowPrice}>{priceLine}</Text>
            </View>
            {isConfirming && <ActivityIndicator color={colors.primary} />}
            {isChosen && !isConfirming && <Text style={styles.chosenMark}>✓</Text>}
        </TouchableOpacity>
    );
}

function Badge({ label, tone }: { label: string; tone: 'in' | 'out' }) {
    return (
        <View style={[styles.badge, tone === 'out' ? styles.badgeOut : styles.badgeIn]}>
            <Text style={styles.badgeText}>{label}</Text>
        </View>
    );
}

function formatDollarsPerM(perM: number): string {
    if (!Number.isFinite(perM) || perM <= 0) return '$0';
    if (perM < 0.01) return '<$0.01';
    return `$${perM.toFixed(2)}`;
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    sheet: {
        maxHeight: '90%',
        minHeight: '60%',
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.lg,
        borderTopRightRadius: borderRadius.lg,
        padding: spacing.md,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.sm,
    },
    title: {
        flex: 1,
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '700',
    },
    closeBtn: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
    },
    closeText: {
        color: colors.onSurfaceVariant,
        fontSize: 18,
    },
    defaultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        marginBottom: spacing.sm,
    },
    defaultLabel: {
        flex: 1,
    },
    defaultText: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
    },
    defaultId: {
        color: colors.onSurface,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 12,
    },
    resetBtn: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
    },
    resetText: {
        color: colors.primary,
        fontWeight: '600',
        fontSize: 12,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    search: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        color: colors.onSurface,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: borderRadius.md,
        fontSize: 14,
    },
    refreshBtn: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
    },
    refreshText: {
        color: colors.primary,
        fontWeight: '600',
        fontSize: 13,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.lg,
        gap: spacing.sm,
    },
    dim: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
    },
    errorText: {
        color: colors.error,
        fontSize: 14,
        fontWeight: '600',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.surfaceVariant,
    },
    rowChosen: {
        backgroundColor: 'rgba(123,46,255,0.08)',
    },
    rowDisabled: {
        opacity: 0.5,
    },
    rowMain: {
        flex: 1,
    },
    rowName: {
        color: colors.onSurface,
        fontSize: 14,
        fontWeight: '600',
    },
    rowId: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        marginTop: 2,
    },
    badges: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 4,
    },
    badge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: borderRadius.sm,
    },
    badgeIn: {
        backgroundColor: 'rgba(0,245,255,0.15)',
    },
    badgeOut: {
        backgroundColor: 'rgba(255,46,171,0.15)',
    },
    badgeText: {
        color: colors.onSurface,
        fontSize: 10,
        fontWeight: '500',
    },
    rowPrice: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 4,
    },
    chosenMark: {
        color: colors.primary,
        fontSize: 18,
        fontWeight: '700',
        marginLeft: spacing.sm,
    },
});
