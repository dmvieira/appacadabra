import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import { colors, spacing, borderRadius } from '../lib/theme';

export default function ShareReceiver() {
    const [sharedContent, setSharedContent] = useState<ShareIntent.SharedContent | null>(null);
    const router = useRouter();
    const { apps, setSharedContent: storeSharedContent, clearSharedContent: storeClearSharedContent } = useAppStore();

    useEffect(() => {
        // Check for initial shared content
        const initialContent = ShareIntent.getSharedContent();
        if (initialContent) {
            setSharedContent(initialContent);
        }

        // Listen for new shared content
        const subscription = ShareIntent.addShareListener((event) => {
            setSharedContent(event);
        });

        return () => {
            subscription.remove();
        };
    }, []);

    const handleSelectApp = async (app: GeneratedApp) => {
        if (!sharedContent) return;

        console.log('ShareReceiver: Storing shared content:', JSON.stringify(sharedContent));

        // Store the shared content in global state
        storeSharedContent({
            mimeType: sharedContent.mimeType || 'text/plain',
            text: sharedContent.text,
            uri: sharedContent.uri,
        });

        console.log('ShareReceiver: Navigating to runner with share=true');

        // Navigate to the runner with share indicator
        setSharedContent(null); // Close modal
        ShareIntent.clearSharedContent();
        router.push({ pathname: '/runner/[id]', params: { id: app.id, share: 'true' } });
    };

    const handleClose = () => {
        ShareIntent.clearSharedContent();
        storeClearSharedContent();
        setSharedContent(null);
    };

    if (!sharedContent) return null;

    return (
        <Modal visible={true} animationType="slide" transparent>
            <View style={styles.container}>
                <View style={styles.content}>
                    <Text style={styles.title}>Compartilhar com Appacadabra</Text>
                    <Text style={styles.subtitle}>
                        {sharedContent.mimeType} {sharedContent.uri ? '(Arquivo)' : '(Texto)'}
                    </Text>

                    <Text style={styles.sectionHeader}>Escolha um App:</Text>

                    <FlatList
                        data={apps}
                        keyExtractor={(item) => item.id.toString()}
                        renderItem={({ item }) => (
                            <TouchableOpacity style={styles.appItem} onPress={() => handleSelectApp(item)}>
                                {item.iconPath ? (
                                    <Image source={{ uri: item.iconPath }} style={styles.appIcon} />
                                ) : (
                                    <View style={[styles.appIcon, styles.appIconPlaceholder]}>
                                        <Text style={styles.appIconText}>📱</Text>
                                    </View>
                                )}
                                <Text style={styles.appName}>{item.name}</Text>
                            </TouchableOpacity>
                        )}
                        style={styles.list}
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>Nenhum app criado ainda</Text>
                        }
                    />

                    <TouchableOpacity style={styles.cancelButton} onPress={handleClose}>
                        <Text style={styles.cancelText}>Cancelar</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    content: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        padding: spacing.lg,
        maxHeight: '80%',
    },
    title: {
        color: colors.onSurface,
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: spacing.xs,
        textAlign: 'center',
    },
    subtitle: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginBottom: spacing.lg,
        textAlign: 'center',
    },
    sectionHeader: {
        color: colors.onSurface,
        fontSize: 16,
        marginBottom: spacing.sm,
    },
    list: {
        marginBottom: spacing.md,
    },
    appItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        marginBottom: spacing.sm,
    },
    appIcon: {
        width: 40,
        height: 40,
        borderRadius: borderRadius.sm,
        marginRight: spacing.md,
    },
    appIconPlaceholder: {
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    appIconText: {
        fontSize: 20,
    },
    appName: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '600',
        flex: 1,
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        padding: spacing.lg,
        fontStyle: 'italic',
    },
    cancelButton: {
        padding: spacing.md,
        backgroundColor: colors.error,
        borderRadius: borderRadius.md,
        alignItems: 'center',
    },
    cancelText: {
        color: colors.onError,
        fontSize: 16,
        fontWeight: 'bold',
    },
});
