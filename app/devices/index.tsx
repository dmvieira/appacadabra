/**
 * Familiares — dispositivos appa vinculados ao Appacadabra.
 *
 * A tela prioriza o essencial para leigos (conectar por Bluetooth, ativar a
 * IA, informar o Wi-Fi). Os detalhes técnicos (TCP host:porta do sim, modelo/
 * firmware, capabilities, wake, encantamentos, write-back) ficam atrás de
 * "Avançado".
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect } from 'expo-router';

import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { deviceManager, nativeTcpTransport, type FamiliarSession } from '../../lib/devices/deviceManager';
import { bleScan, bleTransport, APPA_STATE_CONFIGURED, type BleDevice } from '../../lib/devices/bleTransport';
import { getOpenRouterKey } from '../../lib/api/keyStorage';
import { CAPABILITY_MAP } from '../../lib/devices/capabilityMap';
import { getCurrentWifiSsid } from '../../lib/devices/wifiInfo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function DevicesScreen() {
    const [session, setSession] = useState<FamiliarSession | null>(deviceManager.getSession());
    const [host, setHost] = useState('10.0.2.2');
    const [port, setPort] = useState('7788');
    const [connecting, setConnecting] = useState(false);
    const [bleScanning, setBleScanning] = useState(false);
    const [bleDevices, setBleDevices] = useState<BleDevice[]>([]);
    const [bleConnectingId, setBleConnectingId] = useState<string | null>(null);
    const [wifiSsid, setWifiSsid] = useState('');
    const [wifiPass, setWifiPass] = useState('');
    const [wifiShowPass, setWifiShowPass] = useState(false);
    const [wifiSending, setWifiSending] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [advanced, setAdvanced] = useState(false);

    useEffect(() => {
        return deviceManager.subscribe(() => setSession(deviceManager.getSession()));
    }, []);

    // Mantém o campo de nome sincronizado com o retrato atual do Familiar.
    useEffect(() => {
        const n = session?.portrait?.name;
        if (n) setNameDraft(n);
    }, [session?.portrait?.name]);

    // Ao abrir a tela, sugere o Wi-Fi ATUAL do celular (não a rede antiga) e,
    // se já tiver a senha daquela rede, preenche.
    useFocusEffect(
        useCallback(() => {
            let alive = true;
            (async () => {
                const ssid = await getCurrentWifiSsid();
                if (!alive || !ssid) return;
                setWifiSsid(ssid);
                const pass = await deviceManager.wifiPasswordFor(ssid).catch(() => '');
                if (alive) setWifiPass(pass || '');
            })();
            return () => {
                alive = false;
            };
        }, []),
    );

    const connect = useCallback(async () => {
        setConnecting(true);
        try {
            await deviceManager.connect(nativeTcpTransport(host.trim(), parseInt(port, 10) || 7788));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            Alert.alert(t('devicesError'), msg.startsWith('devices') ? t(msg) : msg);
        } finally {
            setConnecting(false);
        }
    }, [host, port]);

    const scanBle = useCallback(async () => {
        setBleScanning(true);
        setBleDevices([]);
        try {
            const devices = await bleScan(6000);
            const sorted = [...devices].sort((a, b) => b.rssi - a.rssi);
            setBleDevices(sorted);
            if (sorted.length === 0) {
                Alert.alert(t('devicesTitle'), t('devicesBleNone'));
            }
        } catch (e) {
            const err = e as { code?: string; message?: string };
            console.warn('[devices] BLE falhou', err?.code, err?.message);
            const detail = `${err?.code ?? ''} ${err?.message ?? ''}`.trim() || 'devicesNoNativeBle';
            // chaves i18n conhecidas sao traduzidas; mensagens cruas vao como estao
            const body = detail.startsWith('devices') ? t(detail) : detail;
            Alert.alert(t('devicesError'), body);
        } finally {
            setBleScanning(false);
        }
    }, []);

    const connectBleDevice = useCallback(async (device: BleDevice) => {
        setBleConnectingId(device.id);
        try {
            await deviceManager.connect(bleTransport(device.id));
            setBleDevices([]);
        } catch (e) {
            const err = e as { code?: string; message?: string };
            console.warn('[devices] BLE connect falhou', err?.code, err?.message);
            const detail = `${err?.code ?? ''} ${err?.message ?? ''}`.trim() || 'devicesNoNativeBle';
            Alert.alert(t('devicesError'), detail.startsWith('devices') ? t(detail) : detail);
        } finally {
            setBleConnectingId(null);
        }
    }, []);

    const grantOpenrouter = useCallback(async () => {
        try {
            const key = await getOpenRouterKey();
            if (!key) {
                Alert.alert(t('devicesError'), t('devicesGrantNeedsKey'));
                return;
            }
            await deviceManager.grantPower('openrouter', key);
            await deviceManager.pullPortrait().catch(() => {});
            Alert.alert(t('devicesTitle'), t('devicesAiGranted'));
        } catch (e) {
            Alert.alert(t('devicesError'), e instanceof Error ? e.message : String(e));
        }
    }, []);

    const disconnect = useCallback(() => {
        deviceManager.disconnect();
    }, []);

    const grantWifi = useCallback(async () => {
        const target = wifiSsid.trim();
        setWifiSending(true);
        try {
            await deviceManager.provisionWifi(target, wifiPass);
            // Valida a conexao: o device tenta conectar (status 3 = conectado) e
            // reporta ssid/ip no HELLO. Faz polling do retrato por ate ~15s.
            let connected = false;
            let lastStatus = -1;
            for (let i = 0; i < 10 && !connected; i++) {
                await sleep(1500);
                const portrait = await deviceManager.pullPortrait().catch(() => null);
                const net = portrait?.device?.net;
                if (net) lastStatus = net.status ?? -1;
                if (net && net.status === 3 && (net.ssid ?? '').toLowerCase() === target.toLowerCase()) {
                    connected = true;
                }
            }
            if (connected) {
                await deviceManager.rememberWifi(target, wifiPass);
                Alert.alert(t('devicesTitle'), t('devicesWifiConnected', { ssid: target }));
                setWifiPass('');
            } else if (lastStatus === 4) {
                Alert.alert(t('devicesError'), t('devicesWifiWrongPass', { ssid: target }));
            } else if (lastStatus === 1) {
                Alert.alert(t('devicesError'), t('devicesWifiNotFound', { ssid: target }));
            } else {
                Alert.alert(t('devicesError'), t('devicesWifiFailed', { ssid: target }));
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            Alert.alert(t('devicesError'), msg.startsWith('devices') ? t(msg) : msg);
        } finally {
            setWifiSending(false);
        }
    }, [wifiSsid, wifiPass]);

    const renameFamiliar = useCallback(async () => {
        const name = nameDraft.trim();
        if (!name) return;
        setRenaming(true);
        try {
            await deviceManager.renameFamiliar(name);
            Alert.alert(t('devicesTitle'), t('devicesNameSaved', { name }));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            Alert.alert(t('devicesError'), msg.startsWith('devices') ? t(msg) : msg);
        } finally {
            setRenaming(false);
        }
    }, [nameDraft]);

    const p = session?.portrait;

    return (
        <SafeAreaView style={styles.root} edges={['bottom']}>
            <Stack.Screen options={{ title: t('devicesTitle') }} />
            <ScrollView contentContainerStyle={styles.content}>
                {!session ? (
                    <View>
                        <Text style={styles.subtitle}>{t('devicesSubtitle')}</Text>
                        <TouchableOpacity
                            style={[styles.button, styles.buttonPrimary]}
                            onPress={scanBle}
                            disabled={bleScanning}
                        >
                            {bleScanning ? (
                                <ActivityIndicator color={colors.onPrimary} />
                            ) : (
                                <Text style={styles.buttonText}>{t('devicesConnectBle')}</Text>
                            )}
                        </TouchableOpacity>
                        <Text style={styles.hint}>{t('devicesConnectBleHint')}</Text>

                        {bleDevices.length > 0 && (
                            <View style={styles.card}>
                                <Text style={styles.sectionTitle}>{t('devicesFound')}</Text>
                                {bleDevices.map((d) => (
                                    <TouchableOpacity
                                        key={d.id}
                                        style={styles.deviceRow}
                                        onPress={() => connectBleDevice(d)}
                                        disabled={bleConnectingId !== null}
                                    >
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.deviceRowName}>{d.name}</Text>
                                            <Text style={styles.deviceRowMeta}>
                                                {d.state === APPA_STATE_CONFIGURED
                                                    ? t('devicesStateConfigured')
                                                    : t('devicesStateNew')}
                                                {'  ·  '}
                                                {d.rssi} dBm
                                            </Text>
                                        </View>
                                        {bleConnectingId === d.id ? (
                                            <ActivityIndicator color={colors.primary} />
                                        ) : (
                                            <Text style={styles.deviceRowAction}>{t('devicesConnect')}</Text>
                                        )}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}

                        <TouchableOpacity onPress={() => setAdvanced((v) => !v)}>
                            <Text style={styles.advancedLink}>
                                {advanced ? '▾ ' : '▸ '}
                                {t('advanced')}
                            </Text>
                        </TouchableOpacity>
                        {advanced && (
                            <View style={styles.card}>
                                <Text style={styles.label}>host</Text>
                                <TextInput
                                    style={styles.input}
                                    value={host}
                                    onChangeText={setHost}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    placeholder="10.0.2.2"
                                    placeholderTextColor={colors.onSurfaceVariant}
                                />
                                <Text style={styles.label}>porta</Text>
                                <TextInput
                                    style={styles.input}
                                    value={port}
                                    onChangeText={setPort}
                                    keyboardType="number-pad"
                                    placeholder="7788"
                                    placeholderTextColor={colors.onSurfaceVariant}
                                />
                                <TouchableOpacity
                                    style={[styles.button, styles.buttonSmall]}
                                    onPress={connect}
                                    disabled={connecting}
                                >
                                    {connecting ? (
                                        <ActivityIndicator color={colors.primary} />
                                    ) : (
                                        <Text style={styles.buttonSmallText}>{t('devicesConnect')}</Text>
                                    )}
                                </TouchableOpacity>
                                <Text style={styles.hint}>{t('devicesTcpHint')}</Text>
                            </View>
                        )}
                    </View>
                ) : (
                    p && (
                        <View>
                            <View style={styles.card}>
                                <Text style={styles.deviceName}>{p.name}</Text>
                                <View style={styles.statusRow}>
                                    <View style={styles.dot} />
                                    <Text style={styles.statusText}>{t('devicesConnected')}</Text>
                                </View>
                                <Text style={styles.deviceMeta}>
                                    {p.device.net?.ssid
                                        ? `${t('devicesWifi')}: ${p.device.net.ssid}`
                                        : t('devicesNoNet')}
                                </Text>

                                <Text style={styles.label}>{t('devicesNameLabel')}</Text>
                                <View style={styles.inlineRow}>
                                    <TextInput
                                        style={[styles.input, styles.inputFlex]}
                                        value={nameDraft}
                                        onChangeText={setNameDraft}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        placeholder={t('devicesNameLabel')}
                                        placeholderTextColor={colors.onSurfaceVariant}
                                    />
                                    <TouchableOpacity
                                        style={[styles.inlineBtn, (!nameDraft.trim() || renaming || nameDraft.trim() === p.name) && styles.buttonDisabled]}
                                        onPress={renameFamiliar}
                                        disabled={!nameDraft.trim() || renaming || nameDraft.trim() === p.name}
                                    >
                                        {renaming ? (
                                            <ActivityIndicator color={colors.primary} />
                                        ) : (
                                            <Text style={styles.inlineBtnText}>{t('devicesNameSave')}</Text>
                                        )}
                                    </TouchableOpacity>
                                </View>

                                <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={grantOpenrouter}>
                                    <Text style={styles.buttonText}>{t('devicesGrantOpenrouter')}</Text>
                                </TouchableOpacity>
                            </View>

                            <View style={styles.card}>
                                <Text style={styles.sectionTitle}>{t('devicesWifiTitle')}</Text>
                                <Text style={styles.deviceMeta}>{t('devicesWifiHint')}</Text>
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
                                <TouchableOpacity
                                    style={[styles.button, styles.buttonSmall, (!wifiSsid.trim() || wifiSending) && styles.buttonDisabled]}
                                    onPress={grantWifi}
                                    disabled={!wifiSsid.trim() || wifiSending}
                                >
                                    {wifiSending ? (
                                        <View style={styles.sendingRow}>
                                            <ActivityIndicator color={colors.primary} />
                                            <Text style={styles.buttonSmallText}>{t('devicesWifiConnecting')}</Text>
                                        </View>
                                    ) : (
                                        <Text style={styles.buttonSmallText}>{t('devicesGrantWifi')}</Text>
                                    )}
                                </TouchableOpacity>
                            </View>

                            <TouchableOpacity style={[styles.button, styles.buttonDanger]} onPress={disconnect}>
                                <Text style={styles.buttonText}>{t('devicesDisconnect')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity onPress={() => setAdvanced((v) => !v)}>
                                <Text style={styles.advancedLink}>
                                    {advanced ? '▾ ' : '▸ '}
                                    {t('advanced')}
                                </Text>
                            </TouchableOpacity>
                            {advanced && (
                                <View style={styles.card}>
                                    <Text style={styles.deviceMeta}>
                                        {p.device.model} · fw {p.fw} · proto {p.proto}
                                    </Text>
                                    {p.device.net?.ip ? (
                                        <Text style={styles.deviceMeta}>{t('devicesNet')}: {p.device.net.ip}</Text>
                                    ) : null}

                                    <Text style={styles.sectionTitle}>{t('devicesPowers')}</Text>
                                    {p.device.powers.length === 0 ? (
                                        <Text style={styles.empty}>{t('devicesNoPowers')}</Text>
                                    ) : (
                                        <View style={styles.chipRow}>
                                            {p.device.powers.map((pw) => (
                                                <View key={pw} style={styles.chip}>
                                                    <Text style={styles.chipText}>{pw}</Text>
                                                </View>
                                            ))}
                                        </View>
                                    )}
                                    <TouchableOpacity
                                        style={[styles.button, styles.buttonSmall]}
                                        onPress={() => deviceManager.revokePower('openrouter').catch(() => {})}
                                    >
                                        <Text style={styles.buttonSmallText}>{t('devicesRevokeOpenrouter')}</Text>
                                    </TouchableOpacity>

                                    <Text style={styles.sectionTitle}>{t('devicesCapabilities')}</Text>
                                    <View style={styles.chipRow}>
                                        {(p.device.capabilities ?? []).map((c) => (
                                            <View key={c} style={[styles.chip, styles.chipOk]}>
                                                <Text style={styles.chipText}>
                                                    {CAPABILITY_MAP[c]?.displayName ?? c}
                                                </Text>
                                            </View>
                                        ))}
                                    </View>

                                    <Text style={styles.sectionTitle}>{t('devicesWake')}</Text>
                                    <Text style={styles.deviceMeta}>
                                        {t('devicesWakePhrase')}: {p.wake?.phrase ?? '—'} · {t('devicesWakeMode')}: {p.wake?.active ?? '—'}
                                    </Text>

                                    <Text style={styles.sectionTitle}>{t('devicesEncantamentos')}</Text>
                                    {p.encantamentos.length === 0 ? (
                                        <Text style={styles.empty}>{t('devicesEmpty')}</Text>
                                    ) : (
                                        p.encantamentos.map((e) => (
                                            <Text key={e.id} style={styles.encItem}>
                                                {e.id} · v{e.version}
                                            </Text>
                                        ))
                                    )}

                                    <Text style={styles.sectionTitle}>{t('devicesWriteback')}</Text>
                                    <Text style={styles.deviceMeta}>
                                        {session.lastWritebackAt
                                            ? `${session.lastWritebackCount} ${t('devicesWritebackCount')}`
                                            : t('devicesWritebackNone')}
                                    </Text>
                                </View>
                            )}
                        </View>
                    )
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.md, gap: spacing.sm },
    subtitle: { color: colors.onSurfaceVariant, marginBottom: spacing.md, lineHeight: 20 },
    label: { color: colors.onSurfaceVariant, marginBottom: spacing.xs, marginTop: spacing.sm },
    input: {
        backgroundColor: colors.background,
        color: colors.onBackground,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        marginBottom: spacing.sm,
    },
    button: {
        borderRadius: borderRadius.md,
        padding: spacing.md,
        alignItems: 'center',
        marginTop: spacing.sm,
    },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonDanger: { backgroundColor: colors.error },
    buttonSmall: { backgroundColor: colors.surfaceVariant, padding: spacing.sm, marginTop: spacing.xs },
    buttonSmallText: { color: colors.primary, fontWeight: '600' },
    buttonText: { color: colors.onPrimary, fontWeight: '600' },
    buttonDisabled: { opacity: 0.5 },
    sendingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
        marginBottom: spacing.sm,
    },
    inlineBtnText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
    deviceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.onSurfaceVariant + '33',
        gap: spacing.sm,
    },
    deviceRowName: { color: colors.onBackground, fontSize: 16, fontWeight: '600' },
    deviceRowMeta: { color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 },
    deviceRowAction: { color: colors.primary, fontWeight: '600' },
    hint: { color: colors.onSurfaceVariant, fontSize: 12, marginTop: spacing.md, lineHeight: 17 },
    advancedLink: { color: colors.onSurfaceVariant, fontSize: 13, marginTop: spacing.lg, paddingVertical: spacing.sm },
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        gap: spacing.xs,
        marginTop: spacing.sm,
    },
    deviceName: { color: colors.onBackground, fontSize: 22, fontWeight: '700' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
    statusText: { color: colors.success, fontWeight: '600' },
    deviceMeta: { color: colors.onSurfaceVariant, marginTop: spacing.xs },
    sectionTitle: {
        color: colors.onSurfaceVariant,
        fontWeight: '700',
        textTransform: 'uppercase',
        fontSize: 11,
        marginTop: spacing.sm,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    chip: { backgroundColor: colors.surfaceVariant, borderRadius: borderRadius.sm, paddingHorizontal: 8, paddingVertical: 4 },
    chipOk: { backgroundColor: colors.success + '22' },
    chipText: { color: colors.onBackground, fontSize: 12 },
    empty: { color: colors.onSurfaceVariant, fontStyle: 'italic' },
    encItem: { color: colors.onBackground, fontFamily: 'monospace' },
});
