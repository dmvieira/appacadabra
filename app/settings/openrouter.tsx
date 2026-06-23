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
 *   D — Usage this month (placeholder for SQLite spell-level USD sum)
 *
 * Security:
 *   - Key written through `keyStorage.setOpenRouterKey` (Keystore-backed).
 *   - Screen captures disabled while focused via `expo-screen-capture`.
 *   - Key never logged or copied to clipboard from this screen.
 */

import React, { useCallback, useEffect, useState } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
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
import { formatUsd, MODELS } from '../../lib/api/pricing';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';

const OPERATION_LABELS: { key: keyof typeof MODELS; label: string }[] = [
    { key: 'SPELL_S', label: 'Spell create / edit' },
    { key: 'SUGGEST', label: 'Suggestions' },
    { key: 'WEBVIEW', label: 'In-spell AI (text)' },
    { key: 'IMAGE', label: 'Image generation' },
    { key: 'IMAGE_EDIT', label: 'Image editing' },
    { key: 'TTS', label: 'Text-to-speech' },
    { key: 'EMBED', label: 'Embeddings / similarity' },
    { key: 'VIDEO_FAST', label: 'Video (fast)' },
    { key: 'VIDEO_STD', label: 'Video (with reference)' },
];

type TestState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'valid'; label?: string; remaining?: number; isFreeTier?: boolean }
    | { kind: 'invalid'; message: string }
    | { kind: 'network'; message: string };

export default function OpenRouterSettings() {
    const router = useRouter();
    const bumpAiKeyVersion = useAppStore(s => s.bumpAiKeyVersion);
    const [existingKey, setExistingKey] = useState<string | null>(null);
    const [keyDraft, setKeyDraft] = useState('');
    const [test, setTest] = useState<TestState>({ kind: 'idle' });
    const [saving, setSaving] = useState(false);

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
        <SafeAreaView style={styles.container} edges={['top']}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                    <Text style={styles.backText}>←</Text>
                </TouchableOpacity>
                <Text style={styles.title}>{t('openrouterScreenTitle')}</Text>
                <View style={{ width: 40 }} />
            </View>

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
                    <Text style={styles.sectionTitle}>{t('openrouterUsageTitle')}</Text>
                    <Text style={styles.sectionBody}>{t('openrouterUsageDisclaimer')}</Text>
                    <Text style={styles.placeholder}>{t('openrouterUsageEmpty')}</Text>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('openrouterModelsTitle')}</Text>
                    <Text style={styles.sectionBody}>{t('openrouterModelsBody')}</Text>
                    {OPERATION_LABELS.map(({ key, label }) => (
                        <View key={key} style={styles.modelRow}>
                            <Text style={styles.modelOp}>{label}</Text>
                            <Text style={styles.modelId}>{MODELS[key]}</Text>
                        </View>
                    ))}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.surfaceVariant,
    },
    backBtn: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    backText: {
        color: colors.primary,
        fontSize: 24,
    },
    title: {
        color: colors.onBackground,
        fontSize: 18,
        fontWeight: '700',
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
    placeholder: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        fontStyle: 'italic',
    },
    modelRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: spacing.xs,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.surfaceVariant,
    },
    modelOp: {
        color: colors.onSurface,
        fontSize: 13,
        flex: 1,
    },
    modelId: {
        color: colors.onSurfaceVariant,
        fontSize: 11,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        marginStart: spacing.sm,
    },
});
