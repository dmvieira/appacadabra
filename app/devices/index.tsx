/**
 * Familiares — dispositivos appa vinculados ao Appacadabra.
 *
 * Dev/QA: conexão TCP ao appa-sim (host:porta) via módulo nativo; produção:
 * BLE (chegando na mesma interface). A tela mostra o retrato (HELLO), o
 * Cofre (poderes concedidos) e os encantamentos instalados; write-backs
 * chegam sozinhos e são aplicados no app_storage da spell de origem.
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
import { Stack } from 'expo-router';

import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { deviceManager, nativeTcpTransport, type FamiliarSession } from '../../lib/devices/deviceManager';
import { bleScan, bleTransport } from '../../lib/devices/bleTransport';
import { getOpenRouterKey } from '../../lib/api/keyStorage';
import { CAPABILITY_MAP } from '../../lib/devices/capabilityMap';

export default function DevicesScreen() {
    const [session, setSession] = useState<FamiliarSession | null>(deviceManager.getSession());
    const [host, setHost] = useState('10.0.2.2');
    const [port, setPort] = useState('7788');
    const [connecting, setConnecting] = useState(false);
    const [bleScanning, setBleScanning] = useState(false);

    useEffect(() => {
        return deviceManager.subscribe(() => setSession(deviceManager.getSession()));
    }, []);

    const connect = useCallback(async () => {
        setConnecting(true);
        try {
            await deviceManager.connect(nativeTcpTransport(host.trim(), parseInt(port, 10) || 7788));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            Alert.alert(t('devicesError'), msg === 'devicesNoNativeTcp' ? t('devicesNoNativeTcp') : msg);
        } finally {
            setConnecting(false);
        }
    }, [host, port]);

    const scanBle = useCallback(async () => {
        setBleScanning(true);
        try {
            const devices = await bleScan(6000);
            if (devices.length === 0) {
                Alert.alert(t('devicesTitle'), t('devicesBleNone'));
                return;
            }
            // Prioriza dispositivos com nome de Familiar (fofura/appa); senao o mais forte.
            const preferred = devices.filter((d) => /fofura|appa/i.test(d.name));
            const pool = preferred.length > 0 ? preferred : devices;
            const best = [...pool].sort((a, b) => b.rssi - a.rssi)[0];
            await deviceManager.connect(bleTransport(best.id));
        } catch (e) {
            const err = e as { code?: string; message?: string };
            console.warn('[devices] BLE falhou', err?.code, err?.message);
            const detail = `${err?.code ?? ''} ${err?.message ?? ''}`.trim() || t('devicesNoNativeBle');
            Alert.alert(t('devicesError'), t(detail) === detail ? detail : t(detail));
        } finally {
            setBleScanning(false);
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
        } catch (e) {
            Alert.alert(t('devicesError'), e instanceof Error ? e.message : String(e));
        }
    }, []);

    const disconnect = useCallback(() => {
        deviceManager.disconnect();
    }, []);

    const p = session?.portrait;

    return (
        <SafeAreaView style={styles.root} edges={['bottom']}>
            <Stack.Screen options={{ title: t('devicesTitle') }} />
            <ScrollView contentContainerStyle={styles.content}>
                {!session ? (
                    <View>
                        <Text style={styles.subtitle}>{t('devicesSubtitle')}</Text>
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
                            style={[styles.button, styles.buttonPrimary]}
                            onPress={connect}
                            disabled={connecting}
                        >
                            {connecting ? (
                                <ActivityIndicator color={colors.onPrimary} />
                            ) : (
                                <Text style={styles.buttonText}>{t('devicesConnect')}</Text>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.button, styles.buttonBle]}
                            onPress={scanBle}
                            disabled={bleScanning}
                        >
                            {bleScanning ? (
                                <ActivityIndicator color={colors.primary} />
                            ) : (
                                <Text style={styles.buttonSmallText}>{t('devicesBleScan')}</Text>
                            )}
                        </TouchableOpacity>
                        <Text style={styles.hint}>{t('devicesTcpHint')}</Text>
                    </View>
                ) : (
                    p && (
                        <View>
                            <View style={styles.card}>
                                <Text style={styles.deviceName}>{p.name}</Text>
                                <Text style={styles.deviceMeta}>
                                    {p.device.model} · fw {p.fw} · proto {p.proto}
                                </Text>

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
                                <TouchableOpacity style={[styles.button, styles.buttonSmall]} onPress={grantOpenrouter}>
                                    <Text style={styles.buttonSmallText}>{t('devicesGrantOpenrouter')}</Text>
                                </TouchableOpacity>
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
                                    {t('devicesWakePhrase')}: {p.wake.phrase} · {t('devicesWakeMode')}: {p.wake.active}
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

                            <TouchableOpacity style={[styles.button, styles.buttonDanger]} onPress={disconnect}>
                                <Text style={styles.buttonText}>{t('devicesDisconnect')}</Text>
                            </TouchableOpacity>
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
    subtitle: { color: colors.onSurfaceVariant, marginBottom: spacing.md },
    label: { color: colors.onSurfaceVariant, marginBottom: spacing.xs, marginTop: spacing.sm },
    input: {
        backgroundColor: colors.surface,
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
    buttonSmall: { backgroundColor: colors.surface, padding: spacing.sm, marginTop: spacing.xs },
    buttonBle: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary },
    buttonSmallText: { color: colors.primary, fontWeight: '600' },
    buttonText: { color: colors.onPrimary, fontWeight: '600' },
    hint: { color: colors.onSurfaceVariant, fontSize: 12, marginTop: spacing.md },
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        gap: spacing.xs,
    },
    deviceName: { color: colors.onBackground, fontSize: 20, fontWeight: '700' },
    deviceMeta: { color: colors.onSurfaceVariant },
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
