import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Image } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../lib/store';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import * as FileSystem from 'expo-file-system';
import * as ShareIntent from 'share-intent';
import { peekBackupMetadata } from '../lib/backup';
import { readBackupFile } from '../lib/backup';
import { markBackupDirty } from '../lib/backupSync';

export default function ImportSpellScreen() {
    const router = useRouter();
    const { uri } = useLocalSearchParams<{ uri: string }>();
    const { importBackup, isImporting, statusMessage, error, clearError } = useAppStore();
    const [fileName, setFileName] = useState<string>('Unknown Spell');
    const [fileSize, setFileSize] = useState<string>('');
    const [spellIcon, setSpellIcon] = useState<string | null>(null);

    useEffect(() => {
        if (uri) {
            let name = decodeURIComponent(uri).split('/').pop() || 'Unknown Spell';

            // ATTEMPT TO GET REAL FILE NAME (Android content://)
            // 1. Try resolving directly from URI (works for Deep Links / Action View)
            const contentName = ShareIntent.getContentFileName(uri);
            if (contentName) {
                console.log('ImportSpell: Resolved content fileName:', contentName);
                name = contentName;
            } else {
                // 2. Fallback to Shared Content (Action Send)
                const shared = ShareIntent.getSharedContent();
                if (shared && shared.uri && shared.fileName) {
                    console.log('ImportSpell: Found shared content fileName:', shared.fileName);
                    name = shared.fileName;
                }
            }

            // 3. BEST OPTION: Read the file content to find the REAL name inside the JSON
            // This bypasses any weird OS filenames like "DOC-2024..."
            peekBackupMetadata(uri).then(meta => {
                if (meta) {
                    setFileName(meta.name);
                    if (name.endsWith('.spell')) {
                        readBackupFile(uri).then(json => {
                            try {
                                const backup = JSON.parse(json);
                                if (backup && backup.apps && backup.apps[0]) {
                                    const app = backup.apps[0];
                                    if (app.iconBase64) {
                                        setSpellIcon(app.iconBase64);
                                    } else if (app.iconPath) {
                                        setSpellIcon(app.iconPath);
                                    } else {
                                        setSpellIcon(null);
                                    }
                                } else {
                                    setSpellIcon(null);
                                    console.log('ImportSpell: No icon found in backup:', backup);
                                }
                            } catch (e) {
                                setSpellIcon(null);
                                console.log('ImportSpell: JSON parse error', e);
                            }
                        }).catch(e => {
                            setSpellIcon(null);
                            console.log('ImportSpell: readBackupFile error', e);
                        });
                    } else {
                        console.log('ImportSpell: Not a .spell file:', name);
                    }
                } else {
                    // If parsing failed (not a valid spell?), keep the filename we found earlier
                    setFileName(name);
                    console.log('ImportSpell: peekBackupMetadata failed');
                }
            }).catch(err => {
                console.warn('ImportSpell: Failed to peek file:', err);
                setFileName(name);
            });

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
        markBackupDirty();

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
                <View style={[styles.avatarWrap, { marginBottom: spacing.md }]}>
                    <View style={[styles.cardAvatar, { backgroundColor: '#222' }]}>
                        {spellIcon ? (
                            <Image
                                source={{ uri: spellIcon.startsWith('data:image') || spellIcon.length > 100 ? `data:image/png;base64,${spellIcon}` : spellIcon }}
                                style={styles.avatarImage}
                                resizeMode="cover"
                                onError={e => {
                                    console.log('ImportSpell: Falha ao renderizar imagem', e.nativeEvent);
                                }}
                            />
                        ) : (
                            <Text style={[styles.avatarInitials, { color: '#fff' }]}>✨</Text>
                        )}
                    </View>
                </View>
                {/* Fallback visual caso a imagem não carregue */}
                {spellIcon && (
                    <Text style={{ color: colors.secondary, fontSize: 12, marginTop: 4 }}>
                        Se a imagem não aparecer, verifique se o arquivo .spell está correto.
                    </Text>
                )}
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
    avatarWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardAvatar: {
        width: 64,
        height: 64,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#222',
        overflow: 'hidden',
    },
    avatarImage: {
        width: 64,
        height: 64,
        borderRadius: 16,
    },
    avatarInitials: {
        fontSize: 32,
        fontWeight: '900',
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
        marginEnd: spacing.md,
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
