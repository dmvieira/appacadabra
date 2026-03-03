import React, { useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    Modal,
    StyleSheet,
    ActivityIndicator,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { useBackupStore } from '../lib/backupStore';
import { pickLocalFolder, performBackup, performRestore } from '../lib/backupSync';

interface BackupSyncModalProps {
    visible: boolean;
    mode: 'choose' | 'reconnect';
    onClose: () => void;
}

export default function BackupSyncModal({ visible, mode, onClose }: BackupSyncModalProps) {
    const { setBackupMode, setLocalFolderUri } = useBackupStore();
    const [selected, setSelected] = useState<'google_drive' | 'local_folder'>('google_drive');
    const [loading, setLoading] = useState(false);

    const handleConfirm = async () => {
        setLoading(true);
        try {
            if (selected === 'google_drive') {
                setBackupMode('google_drive');
                // Try to restore from Drive first
                await performRestore();
                // Then do initial backup
                await performBackup();
            } else {
                const uri = await pickLocalFolder();
                if (!uri) {
                    setLoading(false);
                    return;
                }
                setLocalFolderUri(uri);
                setBackupMode('local_folder');
                await performRestore();
                await performBackup();
            }
            onClose();
        } catch (e) {
            console.error('[BackupSyncModal] Error:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleSkip = () => {
        setBackupMode('none');
        onClose();
    };

    const handleReconnectPickFolder = async () => {
        setLoading(true);
        try {
            const uri = await pickLocalFolder();
            if (!uri) {
                setLoading(false);
                return;
            }
            setLocalFolderUri(uri);
            setBackupMode('local_folder');
            await performRestore();
            onClose();
        } catch (e) {
            console.error('[BackupSyncModal] Reconnect pick error:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleReconnectSwitchToDrive = async () => {
        setLoading(true);
        try {
            setBackupMode('google_drive');
            setLocalFolderUri(null);
            await performRestore();
            await performBackup();
            onClose();
        } catch (e) {
            console.error('[BackupSyncModal] Switch to drive error:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleStartFresh = () => {
        setBackupMode('google_drive');
        setLocalFolderUri(null);
        performBackup().catch(() => { });
        onClose();
    };

    if (mode === 'reconnect') {
        return (
            <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
                <SafeAreaView style={s.container}>
                    <View style={s.content}>
                        <View style={s.handle} />
                        <Text style={s.title}>📁 {t('backupReconnectTitle')}</Text>

                        {/* Warning card */}
                        <View style={s.warningCard}>
                            <Text style={s.warningIcon}>⚠️</Text>
                            <View style={{ flex: 1 }}>
                                <Text style={s.warningTitle}>{t('backupLocalFolder')}</Text>
                                <Text style={s.warningText}>{t('backupReconnectWarning')}</Text>
                            </View>
                        </View>

                        {/* Actions */}
                        <TouchableOpacity
                            style={s.primaryBtn}
                            onPress={handleReconnectPickFolder}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color="#fff" size="small" />
                            ) : (
                                <Text style={s.primaryBtnText}>📁 {t('backupChooseFolder')}</Text>
                            )}
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={s.secondaryBtn}
                            onPress={handleReconnectSwitchToDrive}
                            disabled={loading}
                        >
                            <Text style={s.secondaryBtnText}>☁️ {t('backupSwitchToDrive')}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={s.linkBtn}
                            onPress={handleStartFresh}
                            disabled={loading}
                        >
                            <Text style={s.linkBtnText}>{t('backupStartFresh')}</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </Modal>
        );
    }

    // Mode: 'choose' — initial backup choice
    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <SafeAreaView style={s.container}>
                <View style={s.content}>
                    <View style={s.handle} />
                    <Text style={s.title}>☁️ {t('backupTitle')}</Text>
                    <Text style={s.subtitle}>{t('backupSubtitle')}</Text>

                    {/* Google Drive option */}
                    <TouchableOpacity
                        style={[s.optionCard, selected === 'google_drive' && s.optionCardSelected]}
                        onPress={() => setSelected('google_drive')}
                        activeOpacity={0.8}
                    >
                        <View style={s.optionIconWrap}>
                            <Text style={s.optionIcon}>☁️</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <View style={s.optionTitleRow}>
                                <Text style={s.optionTitle}>{t('backupGoogleDrive')}</Text>
                                <View style={s.defaultBadge}>
                                    <Text style={s.defaultBadgeText}>{t('backupGoogleDriveDefault')}</Text>
                                </View>
                            </View>
                            <Text style={s.optionDesc}>{t('backupGoogleDriveDesc')}</Text>
                        </View>
                        <View style={[s.radio, selected === 'google_drive' && s.radioSelected]}>
                            {selected === 'google_drive' && <View style={s.radioDot} />}
                        </View>
                    </TouchableOpacity>

                    {/* Local folder option (Android only) */}
                    {Platform.OS === 'android' && (
                        <TouchableOpacity
                            style={[s.optionCard, selected === 'local_folder' && s.optionCardSelected]}
                            onPress={() => setSelected('local_folder')}
                            activeOpacity={0.8}
                        >
                            <View style={[s.optionIconWrap, { backgroundColor: 'rgba(251,191,36,0.15)' }]}>
                                <Text style={s.optionIcon}>📁</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={s.optionTitle}>{t('backupLocalFolder')}</Text>
                                <Text style={s.optionDesc}>{t('backupLocalFolderDesc')}</Text>
                            </View>
                            <View style={[s.radio, selected === 'local_folder' && s.radioSelected]}>
                                {selected === 'local_folder' && <View style={s.radioDot} />}
                            </View>
                        </TouchableOpacity>
                    )}

                    {/* Confirm button */}
                    <TouchableOpacity
                        style={s.primaryBtn}
                        onPress={handleConfirm}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <Text style={s.primaryBtnText}>{t('backupConfirm')}</Text>
                        )}
                    </TouchableOpacity>

                    {/* Skip */}
                    <TouchableOpacity
                        style={s.linkBtn}
                        onPress={handleSkip}
                        disabled={loading}
                    >
                        <Text style={s.linkBtnText}>{t('backupSkip')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        </Modal>
    );
}

const s = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
        justifyContent: 'center',
    },
    content: {
        marginHorizontal: spacing.lg,
        alignItems: 'center',
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        color: colors.onBackground,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    subtitle: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        marginBottom: spacing.lg,
    },

    // Option cards
    optionCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.06)',
        padding: spacing.md,
        marginBottom: spacing.sm,
        width: '100%',
        gap: spacing.md,
    },
    optionCardSelected: {
        borderColor: colors.primary,
        backgroundColor: 'rgba(123,46,255,0.08)',
    },
    optionIconWrap: {
        width: 44,
        height: 44,
        borderRadius: 12,
        backgroundColor: 'rgba(123,46,255,0.15)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    optionIcon: {
        fontSize: 22,
    },
    optionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    optionTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.onSurface,
    },
    optionDesc: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginTop: 2,
    },
    defaultBadge: {
        backgroundColor: colors.primary,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    defaultBadgeText: {
        fontSize: 10,
        fontWeight: '800',
        color: '#fff',
        letterSpacing: 0.5,
    },

    // Radio
    radio: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.2)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    radioSelected: {
        borderColor: colors.primary,
    },
    radioDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: colors.primary,
    },

    // Buttons
    primaryBtn: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.full,
        paddingVertical: 16,
        paddingHorizontal: spacing.xl,
        width: '100%',
        alignItems: 'center',
        marginTop: spacing.md,
    },
    primaryBtnText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
    },
    secondaryBtn: {
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: borderRadius.full,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        paddingVertical: 14,
        paddingHorizontal: spacing.xl,
        width: '100%',
        alignItems: 'center',
        marginTop: spacing.sm,
    },
    secondaryBtnText: {
        color: colors.onSurface,
        fontSize: 14,
        fontWeight: '600',
    },
    linkBtn: {
        paddingVertical: spacing.md,
        alignItems: 'center',
    },
    linkBtnText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        fontWeight: '500',
    },

    // Warning card (reconnect mode)
    warningCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: 'rgba(251,191,36,0.08)',
        borderRadius: borderRadius.md,
        borderWidth: 1,
        borderColor: 'rgba(251,191,36,0.25)',
        padding: spacing.md,
        marginBottom: spacing.lg,
        width: '100%',
        gap: spacing.sm,
    },
    warningIcon: {
        fontSize: 20,
        marginTop: 2,
    },
    warningTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: '#fbbf24',
        marginBottom: 4,
    },
    warningText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        lineHeight: 18,
    },
});
