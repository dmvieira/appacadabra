/**
 * Encantar num Familiar — a forja em tela: transmuta a spell (capabilities →
 * permissionamento, relíquias do app_storage, encantamento via IA BYOK) e
 * encanta o dispositivo conectado (ENCHANT → ENCHANT_ACK).
 *
 * O encantamento (prompt de voz) e as palavras-chave são EDITÁVEIS aqui; o
 * envio ao Familiar roda em primeiro plano (BLE exige o app vivo).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    AppState,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';
import { deviceManager, deviceErrorKey, type KnownFamiliar } from '../../lib/devices/deviceManager';
import { bleTransport } from '../../lib/devices/bleTransport';
import { generateVoiceEnchantment } from '../../lib/devices/voicePrompt';
import { normalizeKeywords, KEYWORDS_MAX, KEYWORD_MAX_LEN, type TransmuteAppResult } from '../../lib/devices/transmute';
import { CAPABILITY_MAP, requiresNet } from '../../lib/devices/capabilityMap';
import { getCurrentWifiSsid, resolveSuggestedSsid } from '../../lib/devices/wifiInfo';
import { getLastWifiSsid } from '../../lib/devices/wifiCredentials';
import { getSetting, setSetting } from '../../lib/database/db';

type Phase = { kind: 'review' } | { kind: 'imbuing' } | { kind: 'done'; encId: string; version: number };

/** Cache do transmute por spell — evita re-gerar com IA ao voltar/background. */
const transmuteCache = new Map<number, { result: TransmuteAppResult; codeLen: number }>();

/** Notifica (local) que o encantamento está pronto — abre a tela p/ encantar. */
async function notifyEnchantReady(appId: number, appName: string): Promise<void> {
    try {
        const channelId = 'appa-enchant';
        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync(channelId, {
                name: t('devicesImbueTitle'),
                importance: Notifications.AndroidImportance.HIGH,
            }).catch(() => {});
        }
        await Notifications.scheduleNotificationAsync({
            content: {
                title: t('devicesEnchantReadyTitle'),
                body: t('devicesEnchantReadyBody', { name: appName }),
                data: { appId, kind: 'enchant-ready' },
            },
            trigger: Platform.OS === 'android' ? ({ channelId } as unknown as null) : null,
        });
    } catch {
        // best-effort
    }
}

export default function ImbueScreen() {
    const router = useRouter();
    const { appId } = useLocalSearchParams<{ appId: string }>();
    const app = useAppStore((s) => s.apps.find((a) => a.id === parseInt(appId, 10)));
    const [session, setSession] = useState(deviceManager.getSession());
    const [known, setKnown] = useState<KnownFamiliar | null>(null);
    const [connectingKnown, setConnectingKnown] = useState(false);
    const [result, setResult] = useState<TransmuteAppResult | null>(null);
    const [transmuting, setTransmuting] = useState(true);
    const [transmuteError, setTransmuteError] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'review' });
    const [wifiSsid, setWifiSsid] = useState('');
    const [wifiPass, setWifiPass] = useState('');
    const [wifiShowPass, setWifiShowPass] = useState(false);
    const [promptDraft, setPromptDraft] = useState('');
    const [keywords, setKeywords] = useState<string[]>([]);
    const [newKeyword, setNewKeyword] = useState('');
    const [regenerating, setRegenerating] = useState(false);
    const [updating, setUpdating] = useState(false);
    const draftLoaded = useRef(false);

    // Sessão reativa (o connect é disparado daqui e precisa re-renderizar).
    useEffect(() => {
        return deviceManager.subscribe(() => {
            setSession(deviceManager.getSession());
        });
    }, []);

    // Último familiar conhecido (botão "Conectar {nome}" quando sem sessão).
    useEffect(() => {
        let alive = true;
        deviceManager
            .knownFamiliars()
            .then((all) => {
                if (!alive) return;
                const last = [...all].sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? null;
                setKnown(last);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, []);

    // Mesmo fluxo da lista (2 tentativas — o BLE do ESP32 falha 1x às vezes).
    const connectKnown = useCallback(async (): Promise<boolean> => {
        if (!known || connectingKnown) return false;
        setConnectingKnown(true);
        try {
            let lastErr: unknown = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    await deviceManager.connect(bleTransport(known.id), known.id);
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    await new Promise((r) => setTimeout(r, 700));
                }
            }
            return !lastErr;
        } catch {
            return false;
        } finally {
            setConnectingKnown(false);
        }
    }, [known, connectingKnown]);

    // Esta spell já tem encantamento neste Familiar? (rotula "Atualizar")
    useEffect(() => {
        let alive = true;
        const id = parseInt(appId, 10);
        deviceManager
            .enchantmentForApp(id)
            .then((e) => {
                if (alive) setUpdating(!!e);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [appId]);

    useEffect(() => {
        let alive = true;
        (async () => {
            const deviceSsid = deviceManager.getSession()?.portrait?.device?.net?.ssid ?? null;
            const ssid = resolveSuggestedSsid(
                deviceSsid,
                await getCurrentWifiSsid(),
                await getLastWifiSsid(),
            );
            if (!alive || !ssid) return;
            setWifiSsid((cur) => cur || ssid);
            const pass = await deviceManager.wifiPasswordFor(ssid).catch(() => '');
            if (alive && pass) setWifiPass((cur) => cur || pass);
        })();
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        let alive = true;
        if (!app) return;
        // Revisão prévia: transmuta sem encantar. Se houver rascunho salvo do
        // usuário (prompt/keywords editados), ele tem prioridade.
        const applyDraft = async (r: TransmuteAppResult) => {
            let draft: { prompt?: string; keywords?: string[] } | null = null;
            try {
                const raw = await getSetting(`devices.encDraft.${app.id}`);
                if (raw) draft = JSON.parse(raw) as { prompt?: string; keywords?: string[] };
            } catch {
                // rascunho corrompido: ignora
            }
            draftLoaded.current = !!draft;
            if (!alive) return;
            setPromptDraft(draft?.prompt ?? r.bundle.prompt);
            setKeywords(draft?.keywords ?? r.bundle.manifest.keywords ?? []);
        };
        (async () => {
            try {
                // Cache: se a spell não mudou, reaproveita o transmute (resiste a
                // ir pra background / voltar).
                const cached = transmuteCache.get(app.id);
                if (cached && cached.codeLen === (app.code?.length ?? 0)) {
                    setResult(cached.result);
                    await applyDraft(cached.result);
                    setTransmuting(false);
                    return;
                }
                const [{ transmuteApp }, { getStorageForApp }] = await Promise.all([
                    import('../../lib/devices/transmute'),
                    import('../../lib/database/db'),
                ]);
                const r = await transmuteApp(
                    { id: app.id, name: app.name, code: app.code, description: app.shortDescription, requiredCapabilities: app.requiredCapabilities },
                    { getStorage: getStorageForApp, generateEnchantment: generateVoiceEnchantment },
                );
                if (!alive) return;
                transmuteCache.set(app.id, { result: r, codeLen: app.code?.length ?? 0 });
                setResult(r);
                await applyDraft(r);
                setTransmuting(false);
                // Se o app foi pra background durante a geração, avisa por notificação.
                if (AppState.currentState !== 'active') void notifyEnchantReady(app.id, app.name);
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

    const persistDraft = useCallback(async () => {
        if (!app) return;
        try {
            await setSetting(
                `devices.encDraft.${app.id}`,
                JSON.stringify({ prompt: promptDraft, keywords }),
            );
        } catch {
            // best-effort
        }
    }, [app, promptDraft, keywords]);

    const regenerate = useCallback(async () => {
        if (!app) return;
        setRegenerating(true);
        try {
            const gen = await generateVoiceEnchantment(
                { id: app.id, name: app.name, code: app.code, description: app.shortDescription, requiredCapabilities: app.requiredCapabilities },
                Object.keys(result?.bundle.data ?? {}),
            );
            if (gen.prompt) setPromptDraft(gen.prompt);
            if (gen.keywords.length) setKeywords(normalizeKeywords(gen.keywords));
            draftLoaded.current = true;
        } catch (e) {
            Alert.alert(t('devicesError'), e instanceof Error ? e.message : String(e));
        } finally {
            setRegenerating(false);
        }
    }, [app, result]);

    const addKeyword = useCallback(() => {
        const k = newKeyword.trim();
        if (!k) return;
        setKeywords((prev) => normalizeKeywords([...prev, k]));
        setNewKeyword('');
    }, [newKeyword]);

    const removeKeyword = useCallback((k: string) => {
        setKeywords((prev) => prev.filter((x) => x !== k));
    }, []);

    const confirm = useCallback(async (forceReplace = false) => {
        if (!app || !result) return;
        setPhase({ kind: 'imbuing' });
        try {
            if (requiresNet(result.mapping.entries) && wifiSsid.trim()) {
                await deviceManager.provisionWifi(wifiSsid, wifiPass);
            }
            await persistDraft();
            const r = await deviceManager.imbueSpell(
                { id: app.id, name: app.name, code: app.code, description: app.shortDescription, requiredCapabilities: app.requiredCapabilities },
                { promptOverride: promptDraft, keywordsOverride: keywords, ...(forceReplace ? { forceReplace: true } : {}) },
            );
            setPhase({ kind: 'done', encId: r.ack.id, version: r.ack.version });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Slot do familiar ocupa­do por outra spell: pergunta antes de
            // substituir (o vínculo enc↔spell nunca muda calado).
            if (msg === 'devicesNoConnection') {
                setPhase({ kind: 'review' });
                const name = known?.name?.trim();
                Alert.alert(
                    t('devicesError'),
                    t('devicesNoConnection'),
                    [
                        { text: t('cancel'), style: 'cancel' },
                        name
                            ? { text: t('devicesConnectNamed', { name }), onPress: () => { void connectKnown(); } }
                            : { text: t('devicesTitle'), onPress: () => router.push('/devices') },
                    ],
                );
                return;
            }
            if (msg.startsWith('devicesEncSlotConflict:')) {
                const otherSpell = msg.split(':')[2] ?? '';
                setPhase({ kind: 'review' });
                Alert.alert(
                    t('devicesEncSlotConflictTitle'),
                    t('devicesEncSlotConflictBody', { spell: otherSpell.replace(/^app_/, '#') }),
                    [
                        { text: t('cancel'), style: 'cancel' },
                        {
                            text: t('devicesEncSlotConflictReplace'),
                            style: 'destructive',
                            onPress: () => { void confirm(true); },
                        },
                    ],
                );
                return;
            }
            const unsupported = msg.startsWith('devicesUnsupported:');
            const ids = unsupported ? msg.slice('devicesUnsupported:'.length).split(',') : [];
            const ek = deviceErrorKey(msg);
            Alert.alert(
                t('devicesError'),
                unsupported
                    ? `${t('devicesUnsupportedList')} ${ids.map((i) => CAPABILITY_MAP[i]?.displayName ?? i).join(', ')}`
                    : msg === 'devicesNoConnection'
                      ? t('devicesNoConnection')
                      : ek
                        ? t(ek)
                        : msg,
            );
            setPhase({ kind: 'review' });
        }
    }, [app, result, promptDraft, keywords, wifiSsid, wifiPass, persistDraft]);

    if (!app) {
        return (
            <SafeAreaView style={styles.root}>
                <Stack.Screen options={{ title: t('devicesImbueTitle') }} />
                <Text style={styles.empty}>{t('devicesSpellNotFound')}</Text>
            </SafeAreaView>
        );
    }

    const target = session?.portrait?.name;

    return (
        <SafeAreaView style={styles.root} edges={['bottom']}>
            <Stack.Screen options={{ title: t('devicesImbueTitle') }} />
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <Text style={styles.appName}>{app.name}</Text>
                {target && <Text style={styles.target}>{t('devicesEnchantTarget', { name: target })}</Text>}

                {!session && (
                    <View style={styles.noConnBox}>
                        <Text style={styles.warn}>{t('devicesNoConnection')}</Text>
                        {known && (
                            <TouchableOpacity
                                style={styles.connectKnownBtn}
                                onPress={() => { void connectKnown(); }}
                                disabled={connectingKnown}
                            >
                                {connectingKnown ? (
                                    <ActivityIndicator color={colors.primary} />
                                ) : (
                                    <Text style={styles.connectKnownText}>
                                        {t('devicesConnectNamed', { name: known.name?.trim() || 'Appa' })}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={() => router.push('/devices')}>
                            <Text style={styles.verFamiliares}>{t('devicesTitle')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

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
                                        {u.displayName} · {t(`devicesReason_${u.reason ?? 'phoneOnly'}`)}
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

                        {/* ── Encantamento (editável) ── */}
                        <View style={styles.editHeader}>
                            <Text style={styles.sectionTitle}>{t('devicesPromptPreview')}</Text>
                            <TouchableOpacity onPress={regenerate} disabled={regenerating} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                {regenerating ? (
                                    <ActivityIndicator color={colors.primary} />
                                ) : (
                                    <Text style={styles.editAction}>{t('devicesRegenerate')}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                        <TextInput
                            style={styles.promptInput}
                            value={promptDraft}
                            onChangeText={setPromptDraft}
                            multiline
                            textAlignVertical="top"
                            placeholder={t('devicesPromptPreview')}
                            placeholderTextColor={colors.onSurfaceVariant}
                        />
                        {!result.promptGeneratedByAI && !draftLoaded.current && (
                            <Text style={styles.hint}>{t('devicesPromptFallback')}</Text>
                        )}

                        {/* ── Palavras-chave (roteamento) ── */}
                        <Text style={styles.sectionTitle}>{t('devicesKeywords')}</Text>
                        <Text style={styles.hint}>{t('devicesKeywordsHint')}</Text>
                        <View style={styles.chipRow}>
                            {keywords.map((k) => (
                                <TouchableOpacity key={k} style={styles.chip} onPress={() => removeKeyword(k)}>
                                    <Text style={styles.chipText}>{k}  ✕</Text>
                                </TouchableOpacity>
                            ))}
                            {keywords.length === 0 && <Text style={styles.empty}>{t('devicesKeywordsNone')}</Text>}
                        </View>
                        <View style={styles.inlineRow}>
                            <TextInput
                                style={[styles.input, styles.inputFlex]}
                                value={newKeyword}
                                onChangeText={setNewKeyword}
                                autoCapitalize="none"
                                autoCorrect={false}
                                maxLength={KEYWORD_MAX_LEN}
                                placeholder={t('devicesKeywordAddPlaceholder')}
                                placeholderTextColor={colors.onSurfaceVariant}
                                onSubmitEditing={addKeyword}
                                returnKeyType="done"
                            />
                            <TouchableOpacity
                                style={[styles.inlineBtn, (!newKeyword.trim() || keywords.length >= KEYWORDS_MAX) && styles.buttonDisabled]}
                                onPress={addKeyword}
                                disabled={!newKeyword.trim() || keywords.length >= KEYWORDS_MAX}
                            >
                                <Text style={styles.inlineBtnText}>{t('devicesKeywordAdd')}</Text>
                            </TouchableOpacity>
                        </View>

                        {requiresNet(result.mapping.entries) && (
                            <View>
                                <Text style={styles.sectionTitle}>{t('devicesWifi')}</Text>
                                <Text style={styles.hint}>{t('devicesWifiHint')}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={wifiSsid}
                                    onChangeText={setWifiSsid}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    placeholder={t('devicesWifiSsid')}
                                    placeholderTextColor={colors.onSurfaceVariant}
                                />
                                <View style={styles.inlineRow}>
                                    <TextInput
                                        style={[styles.input, styles.inputFlex]}
                                        value={wifiPass}
                                        onChangeText={setWifiPass}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        secureTextEntry={!wifiShowPass}
                                        placeholder={t('devicesWifiPass')}
                                        placeholderTextColor={colors.onSurfaceVariant}
                                    />
                                    <TouchableOpacity
                                        style={styles.inlineBtn}
                                        onPress={() => setWifiShowPass((v) => !v)}
                                        accessibilityLabel={wifiShowPass ? t('devicesHidePassword') : t('devicesShowPassword')}
                                    >
                                        <Text style={styles.inlineBtnText}>
                                            {wifiShowPass ? t('devicesHidePassword') : t('devicesShowPassword')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        )}

                        <TouchableOpacity
                            style={[styles.button, (!session || phase.kind === 'imbuing') && styles.buttonDisabled]}
                            onPress={() => { void confirm(); }}
                            disabled={!session || phase.kind === 'imbuing'}
                        >
                            {phase.kind === 'imbuing' ? (
                                <View style={styles.inlineRow}>
                                    <ActivityIndicator color={colors.onPrimary} />
                                    <Text style={styles.buttonText}>{t('devicesEnchantSending')}</Text>
                                </View>
                            ) : (
                                <Text style={styles.buttonText}>
                                    {updating ? t('devicesUpdateEnchantment') : t('devicesImbueConfirm')}
                                </Text>
                            )}
                        </TouchableOpacity>
                        <Text style={styles.hint}>{t('devicesEnchantForegroundHint')}</Text>
                    </View>
                )}

                {phase.kind === 'done' && (
                    <View style={styles.card}>
                        <Text style={styles.doneTitle}>{t('devicesImbued')}</Text>
                        <Text style={styles.itemMono}>
                            {app.name} · v{phase.version}
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
    noConnBox: {
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
    },
    connectKnownBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderWidth: 1,
        borderColor: colors.primary,
        borderRadius: 10,
        paddingVertical: 10,
        paddingHorizontal: 18,
        minHeight: 42,
    },
    connectKnownText: {
        color: colors.primary,
        fontWeight: '600',
    },
    verFamiliares: {
        color: colors.onSurfaceVariant,
        textDecorationLine: 'underline',
        marginTop: 2,
    },
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.md, gap: spacing.sm },
    appName: { color: colors.onBackground, fontSize: 20, fontWeight: '700' },
    target: { color: colors.primary, fontSize: 13, fontWeight: '600' },
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
    editHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    editAction: { color: colors.primary, fontWeight: '600', fontSize: 13 },
    item: { color: colors.onBackground },
    itemOff: { color: colors.onSurfaceVariant },
    itemMono: { color: colors.onBackground, fontFamily: 'monospace' },
    promptInput: {
        color: colors.onBackground,
        backgroundColor: colors.background,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        minHeight: 96,
        marginTop: spacing.xs,
    },
    hint: { color: colors.onSurfaceVariant, fontSize: 12 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    chip: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.sm,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    chipText: { color: colors.onBackground, fontSize: 13 },
    input: {
        backgroundColor: colors.background,
        color: colors.onBackground,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        marginTop: spacing.xs,
    },
    button: { backgroundColor: colors.primary, borderRadius: borderRadius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonDisabled: { opacity: 0.5 },
    inlineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    inputFlex: { flex: 1 },
    inlineBtn: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        minWidth: 56,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.xs,
    },
    inlineBtnText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
    buttonText: { color: colors.onPrimary, fontWeight: '600' },
    doneTitle: { color: colors.success, fontSize: 18, fontWeight: '700' },
});
