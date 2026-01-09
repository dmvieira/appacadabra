import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, borderRadius } from '../lib/theme';

export default function ShareReceiver() {
    const [sharedContent, setSharedContent] = useState<ShareIntent.SharedContent | null>(null);
    const router = useRouter();
    const { apps, setSharedContent: storeSharedContent, clearSharedContent: storeClearSharedContent } = useAppStore();

    useEffect(() => {
        // Check for initial shared content
        const initialContent = ShareIntent.getSharedContent();
        if (initialContent) {
            console.log('ShareReceiver: Initial content found:', JSON.stringify(initialContent));
            setSharedContent(initialContent);
            // We DO NOT clear immediately here anymore in this simplified logic,
            // or we do? If we clear here, and component remounts...
            // Actually for Initial Content, we SHOULD clear it so it doesn't persist on reload without intent.
            // But if we clear it, and user rotates device... on Android config change handles it.
            // Let's clear it ONLY when handled.
        }

        // Listen for new shared content (when app is already open)
        const subscription = ShareIntent.addShareListener((event) => {
            console.log('ShareReceiver: Event received:', JSON.stringify(event));
            setSharedContent(event);
            // DO NOT clear here. Wait for user action.
        });

        return () => {
            subscription.remove();
        };
    }, []);

    const handleSelectApp = async (app: GeneratedApp) => {
        if (!sharedContent) return;

        console.log('ShareReceiver: Processing shared content:', JSON.stringify(sharedContent));

        let base64Data: string | undefined;

        // If there's a URI, read it as base64
        if (sharedContent.uri) {
            try {
                console.log('ShareReceiver: Reading file from URI:', sharedContent.uri);

                // content:// URIs need to be copied to local cache first
                const fileName = sharedContent.uri.split('/').pop() || 'shared_file';
                const cacheUri = FileSystem.cacheDirectory + fileName;

                // Copy to cache
                await FileSystem.copyAsync({
                    from: sharedContent.uri,
                    to: cacheUri,
                });
                console.log('ShareReceiver: File copied to:', cacheUri);

                // Now read from cache
                const fileContent = await FileSystem.readAsStringAsync(cacheUri, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                base64Data = fileContent;
                console.log('ShareReceiver: File read successfully, base64 length:', base64Data?.length || 0);

                // Clean up cache file
                await FileSystem.deleteAsync(cacheUri, { idempotent: true });
            } catch (error) {
                console.error('ShareReceiver: Failed to read file:', error);
            }
        }

        const shareId = Date.now().toString();
        const contentToStore = {
            mimeType: sharedContent.mimeType || 'text/plain',
            text: sharedContent.text,
            uri: sharedContent.uri,
            base64: base64Data,
            fileName: sharedContent.fileName || sharedContent.uri?.split('/').pop() || 'shared_file',
            shareId: shareId,
        };

        console.log('ShareReceiver: Storing content for app:', app.id, 'shareId:', shareId, 'size:', contentToStore.base64?.length || 0);

        // Store the shared content in global state
        storeSharedContent(contentToStore);

        console.log('ShareReceiver: Clearing native content and closing modal');
        // Close modal and clear native
        setSharedContent(null);
        ShareIntent.clearSharedContent();

        console.log('ShareReceiver: Navigating to runner', app.id, 'shareId:', shareId);

        router.push({
            pathname: '/runner/[id]',
            params: {
                id: app.id,
                share: 'true',
                shareId: shareId
            }
        });
    };

    const handleClose = () => {
        // Clear everything to prevent the modal from coming back
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
