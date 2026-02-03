
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../lib/store';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import * as FileSystem from 'expo-file-system';

export default function ImportSpellScreen() {
    const router = useRouter();
    const { uri } = useLocalSearchParams<{ uri: string }>();
    const { importBackup, isImporting, statusMessage, error, clearError } = useAppStore();
    const [fileName, setFileName] = useState<string>('Unknown Spell');
    const [fileSize, setFileSize] = useState<string>('');

    useEffect(() => {
        if (uri) {
            const name = decodeURIComponent(uri).split('/').pop();
            setFileName(name || 'Unknown Spell');

            // Get file info
            FileSystem.getInfoAsync(uri).then(info => {
                if (info.exists) {
                    setFileSize(`${(info.size / 1024).toFixed(1)} KB`);
                }
            }).catch(() => { });
        }
    }, [uri]);

    const handleImport = async () => {
        if (!uri) return;

        clearError();
        // importBackup handles state (isImporting, statusMessage)
        await importBackup(uri);

        // Explicitly check for success via store state after async operation
        const state = useAppStore.getState();
        if (!state.error) {
            // Success!
            // Wait a brief moment to show "Success" message, then redirect
            setTimeout(() => {
                clearError(); // Cleanup
                // Use replace to reset stack to home (Home is index)
                router.replace('/');
            }, 800);
        }
    };

    const handleClose = () => {
        clearError();
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/');
        }
    };

    // Remove auto-close effect to prevent fighting with handleImport logic
    /* 
    useEffect(() => {
        if (statusMessage && statusMessage.includes('Success')) {
            const timer = setTimeout(() => {
                handleClose();
            }, 1500);
            return () => clearTimeout(timer);
        }
    }, [statusMessage]);
    */

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.card}>
                <Text style={styles.icon}>✨</Text>
                <Text style={styles.title}>{t('importSpell')}</Text>

                <View style={styles.fileInfo}>
                    <Text style={styles.fileName}>{fileName}</Text>
                    {!!fileSize && <Text style={styles.fileSize}>{fileSize}</Text>}
                </View>

                {error ? (
                    <View style={styles.errorContainer}>
                        <Text style={styles.errorText}>{error}</Text>
                    </View>
                ) : (
                    <Text style={styles.description}>
                        {t('importSpellConfirm')}
                    </Text>
                )}

                {isImporting && (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator color={colors.primary} size="large" />
                        <Text style={styles.statusText}>{statusMessage || t('processing')}</Text>
                    </View>
                )}

                <View style={styles.actions}>
                    <TouchableOpacity
                        style={[styles.btn, styles.cancelBtn]}
                        onPress={handleClose}
                        disabled={isImporting}
                    >
                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.btn, styles.confirmBtn, isImporting && styles.disabledBtn]}
                        onPress={handleImport}
                        disabled={isImporting}
                    >
                        <Text style={styles.confirmText}>
                            {isImporting ? t('importing') : t('confirm')}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.8)', // Semi-transparent background
        justifyContent: 'center',
        padding: spacing.lg,
    },
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.xl,
        padding: spacing.xl,
        alignItems: 'center',
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    icon: {
        fontSize: 48,
        marginBottom: spacing.md,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.lg,
        textAlign: 'center',
    },
    fileInfo: {
        backgroundColor: colors.surfaceVariant,
        padding: spacing.md,
        borderRadius: borderRadius.lg,
        width: '100%',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    fileName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.primary,
        marginBottom: 4,
        textAlign: 'center',
    },
    fileSize: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
    },
    description: {
        fontSize: 16,
        color: colors.onSurface,
        textAlign: 'center',
        marginBottom: spacing.xl,
        lineHeight: 22,
    },
    actions: {
        flexDirection: 'row',
        width: '100%',
        justifyContent: 'space-between',
        marginTop: spacing.sm,
    },
    btn: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.lg,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelBtn: {
        backgroundColor: colors.surfaceVariant, // fallback
        marginRight: spacing.md,
    },
    confirmBtn: {
        backgroundColor: colors.primary,
    },
    disabledBtn: {
        opacity: 0.7,
    },
    cancelText: {
        color: colors.onSurfaceVariant, // fallback
        fontWeight: 'bold',
        fontSize: 16,
    },
    confirmText: {
        color: colors.onPrimary,
        fontWeight: 'bold',
        fontSize: 16,
    },
    loadingContainer: {
        marginBottom: spacing.lg,
        alignItems: 'center',
    },
    statusText: {
        marginTop: spacing.sm,
        color: colors.primary,
        fontWeight: '600',
    },
    errorContainer: {
        backgroundColor: colors.error, // use error color
        padding: spacing.md,
        borderRadius: borderRadius.md,
        marginBottom: spacing.lg,
        width: '100%',
    },
    errorText: {
        color: colors.onError, // use onError color
        textAlign: 'center',
    },
});
