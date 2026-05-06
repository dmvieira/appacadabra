import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { t } from '../lib/i18n';
import { useManaStore } from '../lib/manaStore';

interface SignOutModalProps {
    visible: boolean;
    onClose: () => void;
    onSelectKeep: () => Promise<void>;
    onSelectClear: () => Promise<void>;
}

const SignOutModal: React.FC<SignOutModalProps> = ({ visible, onClose, onSelectKeep, onSelectClear }) => {
    const { balance } = useManaStore();
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (!visible) setIsLoading(false);
    }, [visible]);

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="slide"
            onRequestClose={isLoading ? undefined : onClose}
        >
            <Pressable style={styles.overlay} onPress={isLoading ? undefined : onClose}>
                <View style={styles.sheetContainer}>
                    <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
                        <View style={styles.header}>
                            <View style={styles.dragHandle} />
                            <View style={styles.titleRow}>
                                <Text style={styles.titleIcon}>🚪</Text>
                                <Text style={styles.titleText}>{t('signOut')}</Text>
                            </View>
                            <Text style={styles.subtitle}>{t('signOutTitle')}</Text>
                        </View>

                        <View style={styles.options}>
                            {/* Keep Locally Option */}
                            <TouchableOpacity
                                style={styles.optionCard}
                                disabled={isLoading}
                                onPress={async () => {
                                    setIsLoading(true);
                                    try { await onSelectKeep(); } finally { setIsLoading(false); }
                                    onClose();
                                }}
                            >
                                <View style={styles.optionIconContainer}>
                                    <Text style={styles.optionIcon}>📱</Text>
                                </View>
                                <View style={styles.optionTextContainer}>
                                    <Text style={styles.optionTitle}>{t('keepLocal')}</Text>
                                    <Text style={styles.optionDescription}>{t('keepLocalDesc')}</Text>
                                </View>
                            </TouchableOpacity>

                            {/* Clear All Option */}
                            <TouchableOpacity
                                style={[styles.optionCard, styles.clearCard]}
                                disabled={isLoading}
                                onPress={async () => {
                                    onClose();
                                    await onSelectClear();
                                }}
                            >
                                <View style={[styles.optionIconContainer, styles.clearIconContainer]}>
                                    <Text style={styles.optionIcon}>🗑️</Text>
                                </View>
                                <View style={styles.optionTextContainer}>
                                    <Text style={[styles.optionTitle, styles.clearTitle]}>{t('clearAll')}</Text>
                                    <Text style={styles.optionDescription}>{t('clearAllDesc')}</Text>
                                </View>
                            </TouchableOpacity>
                        </View>

                        <View style={styles.footerNote}>
                            <Text style={styles.footerNoteText}>
                                {t('manaCloudNote', { amount: balance.toFixed(2) })}
                            </Text>
                        </View>

                        <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={isLoading}>
                            <Text style={styles.cancelButtonText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        {isLoading && (
                            <View style={styles.loadingOverlay}>
                                <ActivityIndicator size="large" color="#8b5cf6" />
                            </View>
                        )}
                    </Pressable>
                </View>
            </Pressable>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    sheetContainer: {
        width: '100%',
    },
    sheet: {
        backgroundColor: '#13132a', // colors.surface
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        padding: 24,
        paddingBottom: 40,
    },
    dragHandle: {
        width: 40,
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 2,
        alignSelf: 'center',
        marginBottom: 20,
    },
    header: {
        marginBottom: 24,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    titleIcon: {
        fontSize: 20,
        marginRight: 10,
    },
    titleText: {
        fontSize: 20,
        fontWeight: '700',
        color: '#e8e8f0', // colors.onSurface
    },
    subtitle: {
        fontSize: 14,
        color: '#6b6b8a', // colors.onSurfaceVariant
    },
    options: {
        gap: 12,
        marginBottom: 24,
    },
    optionCard: {
        flexDirection: 'row',
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 16,
        padding: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        alignItems: 'center',
    },
    clearCard: {
        backgroundColor: 'rgba(239, 68, 68, 0.05)',
        borderColor: 'rgba(239, 68, 68, 0.1)',
    },
    optionIconContainer: {
        width: 48,
        height: 48,
        borderRadius: 12,
        backgroundColor: 'rgba(255,255,255,0.05)',
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 16,
    },
    clearIconContainer: {
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
    optionIcon: {
        fontSize: 20,
    },
    optionTextContainer: {
        flex: 1,
    },
    optionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#e8e8f0',
        marginBottom: 4,
    },
    clearTitle: {
        color: '#ef4444',
    },
    optionDescription: {
        fontSize: 12,
        color: '#6b6b8a',
        lineHeight: 16,
    },
    footerNote: {
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        borderRadius: 12,
        padding: 12,
        marginBottom: 24,
    },
    footerNoteText: {
        fontSize: 12,
        color: '#6b6b8a',
        textAlign: 'center',
        lineHeight: 18,
    },
    cancelButton: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    cancelButtonText: {
        fontSize: 16,
        color: '#6b6b8a',
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.4)',
        borderRadius: 24,
        justifyContent: 'center',
        alignItems: 'center',
    },
});

export default SignOutModal;
