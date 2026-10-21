/**
 * Ensinar o nome ao Familiar — cadastro da wakeword por voz (PROTOCOL.md 3.6).
 *
 * O DEVICE grava com o próprio microfone; esta tela só conduz o ritual: mostra
 * quando falar, checa cada amostra, calibra o ambiente e commita. Sem nuvem
 * até acordar: o áudio do cadastro nunca sai do device.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { deviceManager } from '../../lib/devices/deviceManager';

type Phase =
    | { kind: 'idle' }
    | { kind: 'listen'; index: number; total: number; phrase: string }
    | { kind: 'calibrate' }
    | { kind: 'busy' }
    | { kind: 'done'; templates?: number; threshold?: number; samples: number }
    | { kind: 'error'; reason: string; samples: number };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function EnrollScreen() {
    const router = useRouter();
    const { back } = useLocalSearchParams<{ back?: string }>();
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const [phrase, setPhrase] = useState(
        deviceManager.refreshPortrait()?.wake?.phrase ?? 'Appa',
    );
    const skipRef = useRef(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const ack = await deviceManager.enrollWakeWord(
                    {
                        required: 3,
                        optional: 2,
                        onCommitFail: (a) => {
                            if (!alive) return;
                            setPhase({
                                kind: 'error',
                                reason: a.reason ?? 'commit',
                                samples: 0,
                            });
                        },
                    },
                    {
                        onSampleStart: async (index, total) => {
                            if (!alive) return;
                            setPhase({ kind: 'listen', index, total, phrase });
                            // tempo de o usuario se preparar; a gravacao comeca
                            // assim que esta promise resolver
                            await wait(2200);
                        },
                        onCalibrateStart: async () => {
                            if (!alive) return;
                            setPhase({ kind: 'calibrate' });
                            await wait(1800);
                        },
                    },
                );
                if (!alive) return;
                if (ack.enrolled) {
                    setPhase({
                        kind: 'done',
                        templates: ack.templates,
                        threshold: ack.threshold,
                        samples: ack.samples,
                    });
                } else if (!['samples', 'calibrate'].includes(ack.reason ?? '')) {
                    setPhase({ kind: 'error', reason: ack.reason ?? 'commit', samples: ack.samples });
                }
            } catch (e) {
                if (alive) {
                    setPhase({ kind: 'error', reason: e instanceof Error ? e.message : String(e), samples: 0 });
                }
            }
        })();
        return () => {
            alive = false;
            skipRef.current = true;
            void deviceManager.cancelEnroll();
        };
    }, []);

    const cancel = useCallback(() => {
        void deviceManager.cancelEnroll();
        if (back) router.back();
        else router.replace('/devices');
    }, [back, router]);

    const title =
        phase.kind === 'listen'
            ? t('devicesEnrollListenTitle', { phrase })
            : phase.kind === 'calibrate'
              ? t('devicesEnrollCalibTitle')
              : phase.kind === 'done'
                ? t('devicesEnrollDoneTitle')
                : phase.kind === 'error'
                  ? t('devicesEnrollErrorTitle')
                  : t('devicesEnrollTitle');

    return (
        <SafeAreaView style={styles.safe} edges={['top']}>
            <Stack.Screen options={{ title: t('devicesEnrollTitle') }} />
            <ScrollView contentContainerStyle={styles.body}>
                <Text style={styles.title}>{title}</Text>

                {phase.kind === 'listen' && (
                    <>
                        <Text style={styles.big}>{phrase}</Text>
                        <Text style={styles.sub}>
                            {t('devicesEnrollSampleOf', { index: phase.index, total: phase.total })}
                        </Text>
                        <ActivityIndicator style={styles.spin} />
                        <Text style={styles.hint}>{t('devicesEnrollListenHint')}</Text>
                    </>
                )}

                {phase.kind === 'calibrate' && (
                    <>
                        <Text style={styles.sub}>{t('devicesEnrollCalibBody')}</Text>
                        <ActivityIndicator style={styles.spin} />
                    </>
                )}

                {phase.kind === 'done' && (
                    <>
                        <Text style={styles.sub}>{t('devicesEnrollDoneBody')}</Text>
                        {phase.threshold != null && (
                            <Text style={styles.hint}>
                                {t('devicesEnrollDoneMeta', {
                                    templates: phase.templates ?? 0,
                                    threshold: Math.round(phase.threshold),
                                })}
                            </Text>
                        )}
                        <TouchableOpacity style={styles.btn} onPress={cancel}>
                            <Text style={styles.btnText}>{t('devicesEnrollFinish')}</Text>
                        </TouchableOpacity>
                    </>
                )}

                {phase.kind === 'error' && (
                    <>
                        <Text style={styles.sub}>{t('devicesEnrollErrorBody')}</Text>
                        <Text style={styles.errText}>{phase.reason}</Text>
                        <TouchableOpacity style={styles.btn} onPress={cancel}>
                            <Text style={styles.btnText}>{t('devicesEnrollClose')}</Text>
                        </TouchableOpacity>
                    </>
                )}

                {(phase.kind === 'idle' || phase.kind === 'busy') && <ActivityIndicator style={styles.spin} />}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    body: { padding: spacing.lg, alignItems: 'center', gap: spacing.md },
    title: { color: colors.onBackground, fontSize: 20, fontWeight: '700', textAlign: 'center' },
    big: { color: colors.primary, fontSize: 44, fontWeight: '800' },
    sub: { color: colors.onBackground, fontSize: 16, textAlign: 'center', lineHeight: 24 },
    hint: { color: colors.onSurfaceVariant, fontSize: 13, textAlign: 'center' },
    errText: { color: colors.error, fontSize: 13 },
    spin: { marginTop: spacing.md },
    btn: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        marginTop: spacing.lg,
    },
    btnText: { color: '#fff', fontWeight: '700' },
    btnGhost: {
        borderRadius: borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.surfaceVariant,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        marginTop: spacing.sm,
    },
    btnGhostText: { color: colors.onBackground },
});
