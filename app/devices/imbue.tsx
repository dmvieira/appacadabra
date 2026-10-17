/**
 * Imbuir num Familiar — a forja em tela: transmuta a spell (capabilities →
 * permissionamento, relíquias do app_storage, prompt de voz via IA BYOK) e
 * encanta o dispositivo conectado (ENCHANT → ENCHANT_ACK).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';
import { deviceManager } from '../../lib/devices/deviceManager';
import { generateVoicePrompt } from '../../lib/devices/voicePrompt';
import { CAPABILITY_MAP } from '../../lib/devices/capabilityMap';
import type { TransmuteAppResult } from '../../lib/devices/transmute';

type Phase = { kind: 'review' } | { kind: 'imbuing' } | { kind: 'done'; encId: string; version: number };

export default function ImbueScreen() {
    const router = useRouter();
    const { appId } = useLocalSearchParams<{ appId: string }>();
    const app = useAppStore((s) => s.apps.find((a) => a.id === parseInt(appId, 10)));
    const session = deviceManager.getSession();
    const [result, setResult] = useState<TransmuteAppResult | null>(null);
    const [transmuting, setTransmuting] = useState(true);
    const [transmuteError, setTransmuteError] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'review' });

    useEffect(() => {
        let alive = true;
        if (!app) return;
        // Revisão prévia: transmuta sem encantar (a forja roda de novo no
        // confirmar, contra o device conectado).
        (async () => {
            try {
                const { transmuteApp } = await import('../../lib/devices/transmute');
                const { getStorageForApp } = await import('../../lib/database/db');
                const r = await transmuteApp(
                    { id: app.id, name: app.name, code: app.code, requiredCapabilities: app.requiredCapabilities },
                    { getStorage: getStorageForApp, generatePrompt: generateVoicePrompt },
                );
                if (alive) {
                    setResult(r);
                    setTransmuting(false);
                }
            } catch (e) {
                if (alive) {
                    setTransmuteError(e instanceof Error ? e.message : String(e));
                    setTransmuting(false);
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [app?.id]);

    const confirm = useCallback(async () => {
        if (!app || !result) return;
        setPhase({ kind: 'imbuing' });
        try {
            const r = await deviceManager.imbueSpell(
                { id: app.id, name: app.name, code: app.code, requiredCapabilities: app.requiredCapabilities },
                {},
            );
            setPhase({ kind: 'done', encId: r.ack.id, version: r.ack.version });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const unsupported = msg.startsWith('devicesUnsupported:');
            const ids = unsupported ? msg.slice('devicesUnsupported:'.length).split(',') : [];
            Alert.alert(
                t('devicesError'),
                unsupported
                    ? t('devicesUnsupportedList', { list: ids.map((i) => CAPABILITY_MAP[i]?.displayName ?? i).join(', ') })
                    : msg === 'devicesNoConnection'
                      ? t('devicesNoConnection')
                      : msg,
            );
            setPhase({ kind: 'review' });
        }
    }, [app, result]);

    if (!app) {
        return (
            <SafeAreaView style={styles.root}>
                <Stack.Screen options={{ title: t('devicesImbueTitle') }} />
                <Text style={styles.empty}>{t('devicesSpellNotFound')}</Text>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.root} edges={['bottom']}>
            <Stack.Screen options={{ title: t('devicesImbueTitle') }} />
            <ScrollView contentContainerStyle={styles.content}>
                <Text style={styles.appName}>{app.name}</Text>

                {!session && <Text style={styles.warn}>{t('devicesNoConnection')}</Text>}

                {transmuting && (
                    <View style={styles.center}>
                        <ActivityIndicator color={colors.primary} />
                        <Text style={styles.empty}>{t('devicesTransmuting')}</Text>
                    </View>
                )}

                {transmuteError && <Text style={styles.error}>{transmuteError}</Text>}

                {result && !transmuting && phase.kind !== 'done' && (
                    <View style={styles.card}>
                        <Text style={styles.sectionTitle}>{t('devicesCapabilitiesGranted')}</Text>
                        {result.mapping.entries
                            .filter((e) => e.status === 'granted')
                            .map((e) => (
                                <Text key={e.id} style={styles.item}>
                                    {CAPABILITY_MAP[e.id]?.displayName ?? e.id} → {e.powers.join(', ') || '—'}
                                </Text>
                            ))}
                        {result.mapping.entries.filter((e) => e.status === 'granted').length === 0 && (
                            <Text style={styles.empty}>{t('devicesNoCapabilities')}</Text>
                        )}

                        {result.mapping.unsupported.length > 0 && (
                            <View>
                                <Text style={styles.sectionTitle}>{t('devicesCapabilitiesUnsupported')}</Text>
                                {result.mapping.unsupported.map((u) => (
                                    <Text key={u.id} style={styles.itemOff}>
                                        {u.displayName} — {t(`devicesReason_${u.reason ?? 'phoneOnly'}`)}
                                    </Text>
                                ))}
                            </View>
                        )}

                        <Text style={styles.sectionTitle}>{t('devicesRelics')}</Text>
                        {Object.keys(result.bundle.data).length === 0 ? (
                            <Text style={styles.empty}>{t('devicesNoRelics')}</Text>
                        ) : (
                            Object.keys(result.bundle.data).map((k) => (
                                <Text key={k} style={styles.itemMono}>
                                    {k}
                                </Text>
                            ))
                        )}

                        <Text style={styles.sectionTitle}>{t('devicesPromptPreview')}</Text>
                        <Text style={styles.prompt}>{result.bundle.prompt.slice(0, 320)}</Text>
                        {!result.promptGeneratedByAI && <Text style={styles.hint}>{t('devicesPromptFallback')}</Text>}

                        <TouchableOpacity
                            style={[styles.button, (!session || phase.kind === 'imbuing') && styles.buttonDisabled]}
                            onPress={confirm}
                            disabled={!session || phase.kind === 'imbuing'}
                        >
                            {phase.kind === 'imbuing' ? (
                                <ActivityIndicator color={colors.onPrimary} />
                            ) : (
                                <Text style={styles.buttonText}>{t('devicesImbueConfirm')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}

                {phase.kind === 'done' && (
                    <View style={styles.card}>
                        <Text style={styles.doneTitle}>{t('devicesImbued')}</Text>
                        <Text style={styles.itemMono}>
                            {phase.encId} · v{phase.version}
                        </Text>
                        <Text style={styles.hint}>{t('devicesImbuedHint')}</Text>
                        <TouchableOpacity
                            style={[styles.button, styles.buttonPrimary]}
                            onPress={() => router.back()}
                        >
                            <Text style={styles.buttonText}>{t('devicesDone')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.md, gap: spacing.sm },
    appName: { color: colors.onBackground, fontSize: 20, fontWeight: '700' },
    warn: { color: colors.error },
    error: { color: colors.error },
    empty: { color: colors.onSurfaceVariant, fontStyle: 'italic' },
    center: { alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        gap: spacing.xs,
    },
    sectionTitle: {
        color: colors.onSurfaceVariant,
        fontWeight: '700',
        textTransform: 'uppercase',
        fontSize: 11,
        marginTop: spacing.sm,
    },
    item: { color: colors.onBackground },
    itemOff: { color: colors.onSurfaceVariant },
    itemMono: { color: colors.onBackground, fontFamily: 'monospace' },
    prompt: { color: colors.onSurfaceVariant },
    hint: { color: colors.onSurfaceVariant, fontSize: 12 },
    button: { backgroundColor: colors.primary, borderRadius: borderRadius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.onPrimary, fontWeight: '600' },
    doneTitle: { color: colors.success, fontSize: 18, fontWeight: '700' },
});
