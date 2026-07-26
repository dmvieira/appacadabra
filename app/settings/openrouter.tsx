/**
 * Settings > AI Provider — manages the user's OpenRouter API key.
 *
 * Phase 1 deliverable: the screen exists and can read/write/test/clear the
 * key. Nothing in the app navigates here yet (`useByokAi` flag is still off,
 * mana flow stays live). Phase 2 wires gating in Create/Edit/Webview AI.
 *
 * Sections (per plan, "Tela 'AI Provider' (Settings)"):
 *   A — What is OpenRouter? (link out)
 *   B — Key input (secure entry, paste, masked preview if already set)
 *   C — Test Key (`GET /auth/key`) with idle/loading/valid/invalid states
 *
 * Security:
 *   - Key written through `keyStorage.setOpenRouterKey` (Keystore-backed).
 *   - Screen captures disabled while focused via `expo-screen-capture`.
 *   - Key never logged or copied to clipboard from this screen.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    Linking,
    Platform,
    Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import { colors, spacing, borderRadius } from '../../lib/theme';
import {
    getOpenRouterKey,
    setOpenRouterKey,
    clearOpenRouterKey,
    maskKey,
} from '../../lib/api/keyStorage';
import { checkAuth, OpenRouterError } from '../../lib/api/openrouter';
import { formatUsd, MODELS, AI_TIERS, DEFAULT_AI_TIER, type AiTier } from '../../lib/api/pricing';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';
import {
    getAllPreferredModels,
    clearPreferredModel,
    getAiTier,
    setAiTier,
    clearAllModelPreferences,
} from '../../lib/api/modelPreferences';
import {
    getModelCatalog,
    TASK_LABEL_KEYS,
    type TaskKey,
} from '../../lib/api/modelCatalog';
import { ModelPicker } from '../../components/ModelPicker';

const TASK_KEYS: TaskKey[] = [
    'SPELL_S', 'WEBVIEW', 'IMAGE', 'IMAGE_EDIT',
    'TTS', 'MUSIC', 'EMBED', 'VIDEO_FAST', 'VIDEO_STD',
];

const TIER_LABEL_KEYS: Record<AiTier, string> = {
    apprentice: 'openrouterTierApprenticeLabel',
    sorcerer: 'openrouterTierSorcererLabel',
    archmage: 'openrouterTierArchmageLabel',
};

const TIER_DESC_KEYS: Record<AiTier, string> = {
    apprentice: 'openrouterTierApprenticeDescription',
    sorcerer: 'openrouterTierSorcererDescription',
    archmage: 'openrouterTierArchmageDescription',
};

type TestState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'valid'; label?: string; remaining?: number; isFreeTier?: boolean }
    | { kind: 'invalid'; message: string }
    | { kind: 'network'; message: string };

export default function OpenRouterSettings() {
    const bumpAiKeyVersion = useAppStore(s => s.bumpAiKeyVersion);
    const missingModelTasks = useAppStore(s => s.missingModelTasks);
    const refreshMissingModelTasks = useAppStore(s => s.refreshMissingModelTasks);
    const params = useLocalSearchParams<{ openPicker?: string }>();
    const [existingKey, setExistingKey] = useState<string | null>(null);
    const [keyDraft, setKeyDraft] = useState('');
    const [test, setTest] = useState<TestState>({ kind: 'idle' });
    const [saving, setSaving] = useState(false);
    const [preferredIds, setPreferredIds] = useState<Record<TaskKey, string> | null>(null);
    const [catalogIds, setCatalogIds] = useState<Set<string> | null>(null);
    const [pickerFor, setPickerFor] = useState<TaskKey | null>(null);
    // Tracks the last `openPicker` value we already acted on, so the effect
    // re-fires when a *new* deep-link value arrives while this screen is
    // still mounted (e.g. modal → picker → dismiss → modal fires again).
    const lastHandledOpenPicker = useRef<string | null>(null);
    const [tier, setTier] = useState<AiTier>(DEFAULT_AI_TIER);

    const loadPreferences = useCallback(async () => {
        try {
            const [prefs, catalog, currentTier] = await Promise.all([
                getAllPreferredModels(),
                getModelCatalog().catch(() => []),
                getAiTier(),
            ]);
            setPreferredIds(prefs);
            setCatalogIds(new Set(catalog.map(m => m.id)));
            setTier(currentTier);
        } catch {
            // Non-fatal — screen still renders defaults.
        }
    }, []);

    useEffect(() => {
        void loadPreferences();
    }, [loadPreferences]);

    // Router param handoff from ModelUnavailableModal.
    // Re-fires whenever a *distinct* openPicker value arrives so the picker
    // opens even when Settings is already mounted (fixes the boolean-latch
    // regression where the modal → picker path only worked on cold nav).
    useEffect(() => {
        const target = params.openPicker;
        if (!target || !TASK_KEYS.includes(target as TaskKey)) return;
        if (lastHandledOpenPicker.current === target) return;
        lastHandledOpenPicker.current = target;
        setPickerFor(target as TaskKey);
    }, [params.openPicker]);

    const handlePickerClose = () => {
        setPickerFor(null);
        // Clear the ref so the same task key can re-open the picker later
        // (e.g. user dismisses, tries the same model again, and it fails again).
        lastHandledOpenPicker.current = null;
        void loadPreferences();
        void refreshMissingModelTasks();
    };

    const handleResetAll = async () => {
        await Promise.all(TASK_KEYS.map(k => clearPreferredModel(k)));
        await loadPreferences();
        await refreshMissingModelTasks();
    };

    const applyTierChange = useCallback(async (newTier: AiTier) => {
        await setAiTier(newTier);
        await clearAllModelPreferences();
        await loadPreferences();
        await refreshMissingModelTasks();
        bumpAiKeyVersion();
    }, [loadPreferences, refreshMissingModelTasks, bumpAiKeyVersion]);

    const handleTierPress = useCallback((next: AiTier) => {
        if (next === tier) return;
        Alert.alert(
            t('openrouterTierChangeConfirmTitle'),
            t('openrouterTierChangeConfirmBody'),
            [
                { text: t('openrouterTierChangeConfirmCancel'), style: 'cancel' },
                {
                    text: t('openrouterTierChangeConfirmCta'),
                    style: 'destructive',
                    onPress: () => { void applyTierChange(next); },
                },
            ],
        );
    }, [tier, applyTierChange]);

    useFocusEffect(
        useCallback(() => {
            if (Platform.OS === 'android') {
                ScreenCapture.preventScreenCaptureAsync('byok-settings').catch(() => {});
            }
            return () => {
                if (Platform.OS === 'android') {
                    ScreenCapture.allowScreenCaptureAsync('byok-settings').catch(() => {});
                }
            };
        }, []),
    );

    useEffect(() => {
        getOpenRouterKey().then(setExistingKey).catch(() => setExistingKey(null));
    }, []);

    const openOpenRouter = () => {
        Linking.openURL('https://openrouter.ai/keys').catch(() => {});
    };

    const handlePaste = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (text) setKeyDraft(text.trim());
        } catch {
            // Clipboard may be empty or restricted; silently ignore.
        }
    };

    const handleSave = async () => {
        if (!keyDraft.trim()) return;
        setSaving(true);
        try {
            await setOpenRouterKey(keyDraft.trim());
            const fresh = await getOpenRouterKey();
            setExistingKey(fresh);
            setKeyDraft('');
            setTest({ kind: 'idle' });
            bumpAiKeyVersion();
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to save key';
            setTest({ kind: 'invalid', message: msg });
        } finally {
            setSaving(false);
        }
    };

    const handleClear = async () => {
        await clearOpenRouterKey();
        setExistingKey(null);
        setTest({ kind: 'idle' });
        bumpAiKeyVersion();
    };

    const handleTest = async () => {
        setTest({ kind: 'loading' });
        try {
            const result = await checkAuth();
            if (!result.valid) {
                setTest({ kind: 'invalid', message: t('openrouterTestInvalid') });
                return;
            }
            const remaining =
                typeof result.creditLimit === 'number' && typeof result.usage === 'number'
                    ? Math.max(0, result.creditLimit - result.usage)
                    : undefined;
            setTest({ kind: 'valid', label: result.label, remaining, isFreeTier: result.isFreeTier });
        } catch (err) {
            if (err instanceof OpenRouterError) {
                if (err.code === 'byok.error.invalidKey') {
                    setTest({ kind: 'invalid', message: t('openrouterTestInvalid') });
                } else if (err.code === 'byok.error.network') {
                    setTest({ kind: 'network', message: t('openrouterTestNetwork') });
                } else {
                    setTest({ kind: 'invalid', message: err.message });
                }
            } else {
                setTest({ kind: 'invalid', message: err instanceof Error ? err.message : t('openrouterTestInvalid') });
            }
        }
    };

    const hasKey = existingKey !== null;

    return (
        <SafeAreaView style={styles.container} edges={['bottom']}>
            <Stack.Screen options={{ title: t('openrouterScreenTitle'), headerShown: true }} />
            <ScrollView contentContainerStyle={styles.scroll}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterWhatTitle')}</Text>
                    <Text style={styles.sectionBody}>{t('openrouterWhatBody')}</Text>
                    <TouchableOpacity onPress={openOpenRouter} style={styles.linkBtn}>
                        <Text style={styles.linkText}>openrouter.ai →</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterKeyLabel')}</Text>
                    {hasKey && (
                        <View style={styles.maskBox}>
                            <Text style={styles.maskText}>{maskKey(existingKey ?? '')}</Text>
                            <TouchableOpacity onPress={handleClear} style={styles.smallBtn}>
                                <Text style={styles.smallBtnText}>{t('openrouterRemoveBtn')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    <View style={styles.inputRow}>
                        <TextInput
                            style={styles.input}
                            placeholder={t('openrouterKeyPlaceholder')}
                            placeholderTextColor={colors.onSurfaceVariant}
                            value={keyDraft}
                            onChangeText={setKeyDraft}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                        />
                        <TouchableOpacity onPress={handlePaste} style={styles.pasteBtn}>
                            <Text style={styles.pasteText}>{t('openrouterKeyPaste')}</Text>
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.note}>{t('openrouterKeyHint')}</Text>
                    <TouchableOpacity
                        onPress={handleSave}
                        style={[styles.primaryBtn, (!keyDraft.trim() || saving) && styles.disabledBtn]}
                        disabled={!keyDraft.trim() || saving}
                    >
                        {saving ? (
                            <ActivityIndicator color={colors.onPrimary} />
                        ) : (
                            <Text style={styles.primaryBtnText}>{t('openrouterSaveBtn')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterTestBtn')}</Text>
                    <TouchableOpacity
                        onPress={handleTest}
                        style={[styles.secondaryBtn, !hasKey && styles.disabledBtn]}
                        disabled={!hasKey || test.kind === 'loading'}
                    >
                        {test.kind === 'loading' ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.secondaryBtnText}>{t('openrouterTestBtn')}</Text>
                        )}
                    </TouchableOpacity>
                    {test.kind === 'valid' && (
                        <View style={[styles.statusBox, styles.statusOk]}>
                            <Text style={styles.statusBody}>
                                {typeof test.remaining === 'number'
                                    ? t('openrouterTestValid').replace('${remaining}', formatUsd(test.remaining))
                                    : t('openrouterTestValid').replace('${remaining}', '—')}
                            </Text>
                            {test.label ? <Text style={styles.statusBody}>{test.label}</Text> : null}
                            {test.isFreeTier && (
                                <Text style={styles.statusBody}>{t('openrouterTestNoCredit')}</Text>
                            )}
                        </View>
                    )}
                    {test.kind === 'invalid' && (
                        <View style={[styles.statusBox, styles.statusErr]}>
                            <Text style={styles.statusBody}>{test.message}</Text>
                        </View>
                    )}
                    {test.kind === 'network' && (
                        <View style={[styles.statusBox, styles.statusErr]}>
                            <Text style={styles.statusBody}>{test.message}</Text>
                        </View>
                    )}
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterTierSectionTitle')}</Text>
                    <Text style={styles.sectionBody}>{t('openrouterTierSectionDescription')}</Text>
                    <View style={styles.tierRow}>
                        {AI_TIERS.map((entry) => {
                            const selected = entry === tier;
                            return (
                                <TouchableOpacity
                                    key={entry}
                                    style={[styles.tierPill, selected && styles.tierPillSelected]}
                                    onPress={() => handleTierPress(entry)}
                                    activeOpacity={0.8}
                                >
                                    <Text style={[styles.tierPillLabel, selected && styles.tierPillLabelSelected]}>
                                        {t(TIER_LABEL_KEYS[entry])}
                                    </Text>
                                    <Text style={[styles.tierPillDesc, selected && styles.tierPillDescSelected]}>
                                        {t(TIER_DESC_KEYS[entry])}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterAdvancedModelsTitle')}</Text>
                    <Text style={styles.sectionBody}>{t('openrouterAdvancedModelsHint')}</Text>
                    {TASK_KEYS.map((key) => {
                        const label = t(TASK_LABEL_KEYS[key]);
                        const chosen = preferredIds?.[key] ?? MODELS[key];
                        const missing = missingModelTasks.includes(key)
                            || (catalogIds !== null && !catalogIds.has(chosen));
                        return (
                            <TouchableOpacity
                                key={key}
                                style={[styles.modelRow, missing && styles.modelRowMissing]}
                                onPress={() => setPickerFor(key)}
                                activeOpacity={0.7}
                            >
                                <View style={styles.modelRowMain}>
                                    <Text style={styles.modelOp}>
                                        {missing ? '⚠️  ' : ''}{label}
                                    </Text>
                                    <Text style={styles.modelId}>{chosen}</Text>
                                    {missing && (
                                        <Text style={styles.modelWarning}>
                                            {t('openrouterModelUnavailableInlineWarning')}
                                        </Text>
                                    )}
                                </View>
                                <Text style={styles.modelChevron}>›</Text>
                            </TouchableOpacity>
                        );
                    })}
                    <TouchableOpacity onPress={handleResetAll} style={styles.resetAllBtn}>
                        <Text style={styles.resetAllText}>{t('openrouterModelResetAll')}</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>
            <ModelPicker
                taskKey={pickerFor}
                taskLabel={pickerFor ? t(TASK_LABEL_KEYS[pickerFor]) : ''}
                onClose={handlePickerClose}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    scroll: {
        padding: spacing.md,
        paddingBottom: spacing.xl * 2,
    },
    section: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginBottom: spacing.md,
    },
    sectionTitle: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '700',
        marginBottom: spacing.sm,
    },
    sectionBody: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        lineHeight: 20,
        marginBottom: spacing.sm,
    },
    linkBtn: {
        paddingVertical: spacing.sm,
    },
    linkText: {
        color: colors.secondary,
        fontSize: 14,
        fontWeight: '600',
    },
    maskBox: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surfaceVariant,
        padding: spacing.sm,
        borderRadius: borderRadius.md,
        marginBottom: spacing.sm,
    },
    maskText: {
        color: colors.onSurfaceVariant,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: spacing.xs,
    },
    input: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        color: colors.onSurface,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: borderRadius.md,
        fontSize: 14,
    },
    pasteBtn: {
        marginLeft: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
    },
    pasteText: {
        color: colors.primary,
        fontWeight: '600',
    },
    note: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: spacing.xs,
        marginBottom: spacing.md,
    },
    primaryBtn: {
        backgroundColor: colors.primary,
        padding: spacing.md,
        borderRadius: borderRadius.md,
        alignItems: 'center',
    },
    primaryBtnText: {
        color: colors.onPrimary,
        fontWeight: '700',
    },
    secondaryBtn: {
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.md,
        alignItems: 'center',
    },
    secondaryBtnText: {
        color: colors.primary,
        fontWeight: '700',
    },
    disabledBtn: {
        opacity: 0.5,
    },
    smallBtn: {
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.sm,
        borderRadius: borderRadius.sm,
        backgroundColor: colors.error,
    },
    smallBtnText: {
        color: colors.onError,
        fontWeight: '600',
        fontSize: 12,
    },
    statusBox: {
        marginTop: spacing.md,
        padding: spacing.sm,
        borderRadius: borderRadius.md,
    },
    statusOk: {
        backgroundColor: 'rgba(16,185,129,0.15)',
        borderWidth: 1,
        borderColor: colors.success,
    },
    statusErr: {
        backgroundColor: 'rgba(255,75,110,0.15)',
        borderWidth: 1,
        borderColor: colors.error,
    },
    statusTitle: {
        color: colors.onSurface,
        fontWeight: '700',
        marginBottom: spacing.xs,
    },
    statusBody: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
    },
    modelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.xs,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.surfaceVariant,
    },
    modelRowMissing: {
        backgroundColor: 'rgba(255,75,110,0.12)',
        borderRadius: borderRadius.sm,
    },
    modelRowMain: {
        flex: 1,
    },
    modelOp: {
        color: colors.onSurface,
        fontSize: 13,
        fontWeight: '600',
    },
    modelId: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        marginTop: 2,
    },
    modelWarning: {
        color: colors.error,
        fontSize: 11,
        marginTop: 2,
    },
    modelChevron: {
        color: colors.onSurfaceVariant,
        fontSize: 20,
        marginLeft: spacing.sm,
    },
    resetAllBtn: {
        marginTop: spacing.md,
        alignSelf: 'flex-end',
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.sm,
    },
    resetAllText: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    tierRow: {
        flexDirection: 'row',
        gap: spacing.xs,
        marginTop: spacing.xs,
    },
    tierPill: {
        flex: 1,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.xs,
        borderRadius: borderRadius.md,
        backgroundColor: colors.surfaceVariant,
        alignItems: 'center',
    },
    tierPillSelected: {
        backgroundColor: colors.primary,
    },
    tierPillLabel: {
        color: colors.onSurface,
        fontSize: 13,
        fontWeight: '700',
    },
    tierPillLabelSelected: {
        color: colors.onPrimary,
    },
    tierPillDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        marginTop: 2,
        textAlign: 'center',
    },
    tierPillDescSelected: {
        color: colors.onPrimary,
        opacity: 0.9,
    },
});
