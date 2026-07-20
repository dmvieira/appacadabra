import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, FlatList, Image, AppState, Platform, Animated, Alert } from 'react-native';

import { useRouter, useGlobalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../lib/store';
import { GeneratedApp } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { peekBackupMetadata } from '../lib/backup';
import { markBackupDirty } from '../lib/backupSync';
import { readContentUriAsBase64 } from '../lib/shareRead';

const AVATAR_COLORS = [
    '#7B2EFF', '#00B4D8', '#FF2EAB', '#00C853', '#FF6D00',
    '#448AFF', '#FF1744', '#00BFA5', '#AA00FF', '#FFD600',
];

function getAvatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

function getFileIcon(fileName: string, mimeType?: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext === 'spell') return '✨';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '▶️';
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'opus', 'm4a', 'wma'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📄';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
    if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return '📝';
    // Fallback to mime type when extension is not recognized
    const mime = (mimeType || '').toLowerCase();
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.startsWith('video/')) return '▶️';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('text/')) return '📝';
    return '📎';
}

function getFileTypeLabel(fileName: string, mimeType?: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext === 'spell') return ''; // Spells without desc will just be perfectly centered

    // Check mime type first for generic but friendly names
    const mime = (mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return t('typeImage');
    if (mime.startsWith('video/')) return t('typeVideo');
    if (mime.startsWith('audio/')) return t('typeAudio');
    if (mime.startsWith('text/')) return t('typeText');
    if (mime === 'application/pdf') return t('typePdf');
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('compressed')) return t('typeArchive');

    // Fallback to extension if known
    if (ext && !['bin', 'dat', 'tmp', 'octet-stream'].includes(ext)) {
        return `.${ext.toUpperCase()}`;
    }

    return t('typeFile'); // generic "File" instead of octet-stream
}

type ShareContentType = 'text' | 'image' | 'file';

function detectContentType(mimeType?: string, hasUri?: boolean, hasText?: boolean): ShareContentType {
    const mime = (mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('text/') || (!hasUri && hasText)) return 'text';
    return 'file';
}

/** Check if a spell's HTML/JS code can receive the given content type.
 *  Mirrors the injection logic in injectedJS.ts handleSharedContent(). */
function canSpellReceive(code: string, contentType: ShareContentType): boolean {
    // Spell explicitly handles shared content via JS events — accepts anything
    if (/sharedFile|sharedContent/i.test(code)) return true;

    switch (contentType) {
        case 'text':
            return /<textarea/i.test(code)
                || /type\s*=\s*["']text["']/i.test(code)
                || /contenteditable/i.test(code);
        case 'image':
        case 'file':
            return /type\s*=\s*["']file["']/i.test(code);
    }
}

// Module-level variables to sync across initial setup
let appSelectionInProgress = false;
let isHandlingAction = false;
let lastRouteOpenUri: string | null = null;
let lastRouteOpenUriAt: number = 0;
const ROUTE_URI_DEDUPE_MS = 500;
// Track the currently displayed content ID outside React closures
// so that listener callbacks always have the freshest value.
let currentContentId: string = '';
let dismissedContentIds = new Set<string>();

function dismissContent(id: string) {
    if (id) dismissedContentIds.add(id);
    // Keep the set small to prevent memory leaks
    if (dismissedContentIds.size > 10) {
        const arr = Array.from(dismissedContentIds);
        dismissedContentIds = new Set(arr.slice(-5));
    }
}

export default function ShareReceiver() {
    const [sharedContent, setSharedContent] = useState<ShareIntent.SharedContent | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [resolvedSpellName, setResolvedSpellName] = useState<string>('');
    const [resolvedSpellDesc, setResolvedSpellDesc] = useState<string>('');
    const [resolvedSpellIcon, setResolvedSpellIcon] = useState<string | null>(null);
    const [openUriPriority, setOpenUriPriority] = useState(false);
    const router = useRouter();
    const { openUri } = useGlobalSearchParams<{ openUri?: string }>();
    const {
        apps,
        isLoading,
        clearSharedContent: storeClearSharedContent,
        importBackup
    } = useAppStore();
    const hasPendingOpenUri = openUriPriority;

    const safeReplaceHome = React.useCallback((attempt: number = 0) => {
        try {
            router.replace('/');
        } catch (e) {
            if (attempt < 5) {
                setTimeout(() => safeReplaceHome(attempt + 1), 120);
            } else {
                console.warn('ShareReceiver: safeReplaceHome skipped (router not ready yet)');
            }
        }
    }, [router]);

    // Helper to check and lock content - avoids updating state with exactly identical content in loop
    const tryLockContent = (content: ShareIntent.SharedContent): boolean => {
        if (!content) return false;
        // If content is strictly identical to what we already show, skip to avoid flicker
        if (sharedContent &&
            sharedContent.uri === content.uri &&
            sharedContent.text === content.text &&
            sharedContent.mimeType === content.mimeType) {
            return false;
        }

        // If the checking loop finds an OLDER or DIFFERENT intent but we already purposefully 
        // updated to a new one via the listener, do NOT let background polling overwrite it
        // unless the content is genuinely new from the system. 
        // React's closure might have an old `sharedContent` in `checkContent`, so we rely on 
        // the fact that we clear `ShareIntent` when handling, and new intents trigger `addShareListener` directly.

        return true;
    };

    // Polling-based check: ONLY used for initial detection when no content is showing.
    const checkContent = React.useCallback(() => {
        if (isLoading) return;
        if (hasPendingOpenUri) return;
        if (isHandlingAction) return;

        // If React state was reset by a remount but we had content before,
        // try to restore it from the native module.
        if (!sharedContent && currentContentId) {
            const content = ShareIntent.getSharedContent();
            const contentId = content?.uri || content?.text || '';
            if (content && contentId === currentContentId) {
                console.log('ShareReceiver: Restoring content after remount:', contentId);
                setSharedContent(content);
            } else {
                // Content was cleared natively, reset the module-level tracker
                console.log('ShareReceiver: Content lost after remount, resetting tracker');
                currentContentId = '';
            }
            return;
        }

        // If content is already showing, polling must NOT touch it.
        if (sharedContent) return;

        const content = ShareIntent.getSharedContent();
        const contentId = content?.uri || content?.text || '';
        if (content && contentId) {
            if (dismissedContentIds.has(contentId)) return;
            console.log('ShareReceiver: Content found via POLLING (initial):', content.uri || 'text content');
            currentContentId = contentId;
            setSharedContent(content);
        }
    }, [isLoading, hasPendingOpenUri, sharedContent]);

    // Initial check when store is ready
    useEffect(() => {
        if (!isLoading) {
            checkContent();
        }
    }, [isLoading, checkContent]);

    // Unified flow: ACTION_VIEW (open with) is routed to /?openUri=... via +native-intent
    // Convert it to the same sharedContent flow used by ACTION_SEND.
    useEffect(() => {
        if (!openUri || typeof openUri !== 'string') return;
        if (isLoading) return;
        if (appSelectionInProgress) return;

        let decodedUri = '';
        try {
            decodedUri = decodeURIComponent(openUri);
        } catch {
            decodedUri = openUri;
        }

        if (!decodedUri.startsWith('content://') && !decodedUri.startsWith('file://')) return;
        const now = Date.now();
        if (lastRouteOpenUri === decodedUri && now - lastRouteOpenUriAt < ROUTE_URI_DEDUPE_MS) return;

        const resolvedName = ShareIntent.getContentFileName(decodedUri)
            || decodedUri.split('/').pop()
            || 'file';

        const syntheticContent = {
            mimeType: 'application/octet-stream',
            uri: decodedUri,
            fileName: resolvedName,
        } as ShareIntent.SharedContent;

        console.log('ShareReceiver: [OPEN_WITH] Routed ACTION_VIEW into shared flow:', decodedUri);
        lastRouteOpenUri = decodedUri;
        lastRouteOpenUriAt = now;
        setOpenUriPriority(true);
        // Clear stale shared payload from previous ACTION_SEND before showing openUri content
        ShareIntent.clearSharedContent();
        storeClearSharedContent();
        // Clear any dismissed marker for this URI so it can be re-shared
        dismissedContentIds.delete(decodedUri);
        currentContentId = decodedUri;
        setSharedContent(syntheticContent);

        // Clean URL query to avoid retriggering on remounts.
        safeReplaceHome();

        // OpenUri gets temporary priority only to avoid stale overwrite; then normal shares resume.
        setTimeout(() => {
            setOpenUriPriority(false);
        }, 1200);
    }, [openUri, isLoading, safeReplaceHome, storeClearSharedContent]);

    // Resolve spell name by reading backup metadata from the file (same behavior as old import modal)
    useEffect(() => {
        let cancelled = false;

        const resolveName = async () => {
            if (!sharedContent?.uri) {
                setResolvedSpellName('');
                setResolvedSpellDesc('');
                setResolvedSpellIcon(null);
                return;
            }

            const fallbackName = sharedContent.fileName || sharedContent.uri.split('/').pop() || '';
            setResolvedSpellName(fallbackName);
            setResolvedSpellDesc('');
            setResolvedSpellIcon(null);

            try {
                const meta = await peekBackupMetadata(sharedContent.uri);
                if (!cancelled && meta?.name) {
                    setResolvedSpellName(meta.name);
                }
                if (!cancelled && meta?.shortDescription) {
                    setResolvedSpellDesc(meta.shortDescription);
                }
                if (!cancelled && meta?.iconBase64) {
                    setResolvedSpellIcon(meta.iconBase64);
                }
            } catch {
                // keep fallback name
            }
        };

        resolveName();

        return () => {
            cancelled = true;
        };
    }, [sharedContent?.uri, sharedContent?.fileName]);

    useEffect(() => {
        console.log('ShareReceiver: MOUNTED (Listeners Setup) ----------');

        // Listen for new shared content (when app is already open)
        const subscription = ShareIntent.addShareListener((event) => {
            const eventId = event.uri || event.text || '';
            console.log('ShareReceiver: [LISTENER] fired, eventId:', eventId, 'currentContentId:', currentContentId);
            if (isHandlingAction) return;
            if (hasPendingOpenUri) return;
            if (!eventId) return;
            // If this is already what we're showing, skip
            if (eventId === currentContentId) return;
            // If this was dismissed, skip
            if (dismissedContentIds.has(eventId)) return;
            console.log('ShareReceiver: [LISTENER] Accepting new content');
            // This is genuinely new content — allow re-sharing by clearing dismissed
            dismissedContentIds.delete(eventId);
            currentContentId = eventId;
            appSelectionInProgress = false;
            setSharedContent(event);
        });

        // Safety Monitor: Poll every 600ms
        const safetyInterval = setInterval(() => {
            if (isHandlingAction) return;
            if (hasPendingOpenUri) return;
            // Only poll for initial detection when nothing is showing
            if (!currentContentId) {
                ShareIntent.checkShareIntent();
                checkContent();
            }
        }, 600);

        // Listen for AppState changes to catch missed events
        const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                console.log('ShareReceiver: App active, checking immediately');
                if (isHandlingAction) return;
                if (hasPendingOpenUri) return;

                // Only do initial detection if nothing is showing
                if (!currentContentId) {
                    ShareIntent.checkShareIntent();
                    checkContent();
                }

                // Burst poll: only run if no content is showing
                let checks = 0;
                const burstInterval = setInterval(() => {
                    if (checks >= 6 || currentContentId) {
                        clearInterval(burstInterval);
                        return;
                    }
                    if (isHandlingAction) {
                        clearInterval(burstInterval);
                        return;
                    }
                    checks++;
                    console.log('ShareReceiver: Burst check', checks);
                    ShareIntent.checkShareIntent();
                    checkContent();
                }, 500);
            }
        });

        return () => {
            console.log('ShareReceiver: UNMOUNTED (Listeners Cleanup) -------');
            subscription.remove();
            appStateSubscription.remove();
            clearInterval(safetyInterval);
        };
    }, [checkContent, hasPendingOpenUri]);

    const handleSelectApp = async (app: GeneratedApp) => {
        if (!sharedContent || isHandlingAction) return;
        dismissContent(sharedContent.uri || sharedContent.text || '');
        currentContentId = '';
        isHandlingAction = true;
        setIsProcessing(true);
        appSelectionInProgress = true;

        console.log('ShareReceiver: Processing shared content:', JSON.stringify(sharedContent));

        let base64Data: string | undefined;

        // If there's a URI, read it as base64
        if (sharedContent.uri) {
            console.log('ShareReceiver: Reading file from URI:', sharedContent.uri);
            const result = await readContentUriAsBase64(
                sharedContent.uri,
                sharedContent.fileName || '',
            );
            if (result) {
                base64Data = result;
                console.log('ShareReceiver: File read successfully, base64 length:', base64Data.length);
            } else if (!sharedContent.text) {
                // Every read strategy failed and there's no text fallback —
                // don't ship an empty payload to the spell.
                console.error('ShareReceiver: All read strategies failed for', sharedContent.uri);
                Alert.alert(t('sharedFileReadFailedTitle'), t('sharedFileReadFailed'));
                appSelectionInProgress = false;
                isHandlingAction = false;
                setIsProcessing(false);
                return;
            }
        }

        const shareId = Date.now().toString();
        const contentToStore = {
            mimeType: sharedContent.mimeType || 'text/plain',
            text: sharedContent.text,
            uri: sharedContent.uri,
            base64: base64Data,
            fileName: sharedContent.fileName || sharedContent.uri?.split('/').pop() || 'file',
            shareId: shareId,
            targetAppId: app.id, // Include target app for routing
        };

        // FIXED DROP-BOX: Always use the same file name
        const payloadPath = FileSystem.cacheDirectory + 'pending_share.json';

        try {
            await FileSystem.writeAsStringAsync(payloadPath, JSON.stringify(contentToStore));
            console.log('ShareReceiver: Payload written to drop-box:', payloadPath);
        } catch (e) {
            console.error('ShareReceiver: Failed to write payload:', e);
            return;
        }

        // Close modal and clear native BEFORE navigating
        setSharedContent(null);
        ShareIntent.clearSharedContent();

        // Close only the RunnerActivity for THIS specific app (if open)
        console.log('ShareReceiver: Closing runner window for app', app.id);
        await ShareIntent.finishRunnerActivity(app.id);

        if (Platform.OS === 'android') {
            // On Android, open via RunnerActivity — it reads the drop-box on mount
            console.log('ShareReceiver: Opening RunnerActivity for app', app.id);
            // Small delay to let finishRunnerActivity broadcast be processed first
            await new Promise(resolve => setTimeout(resolve, 300));
            await ShareIntent.startRunnerActivity(app.id);
        } else {
            // On iOS, navigate inside expo-router
            console.log('ShareReceiver: Navigating to runner via expo-router', app.id);
            router.push({
                pathname: '/runner/[id]',
                params: { id: app.id.toString(), share: 'true' }
            });
        }

        // Reset guard after a short delay so future shares are still handled
        setTimeout(() => {
            ShareIntent.clearSharedContent();
            storeClearSharedContent();
            appSelectionInProgress = false;
            isHandlingAction = false;
            setIsProcessing(false);
        }, 2500);
    };

    const handleImportSpell = () => {
        if (!sharedContent || !sharedContent.uri || isHandlingAction) return;
        console.log('ShareReceiver: [IMPORT] handleImportSpell called, uri:', sharedContent.uri);
        isHandlingAction = true;
        appSelectionInProgress = true;

        const uri = sharedContent.uri;
        dismissContent(uri);
        currentContentId = '';

        // Close modal immediately
        setSharedContent(null);
        ShareIntent.clearSharedContent();
        storeClearSharedContent();

        // Import in background
        importBackup(uri, true).finally(() => {
            console.log('ShareReceiver: [IMPORT] importBackup finished, resetting guards');
            markBackupDirty();
            isHandlingAction = false;
            setTimeout(() => { appSelectionInProgress = false; }, 3000);
        });
    };

    const handleClose = () => {
        // Mark current content as dismissed so it won't be resurrected
        const contentId = sharedContent?.uri || sharedContent?.text || '';
        if (contentId) dismissContent(contentId);
        currentContentId = '';
        ShareIntent.clearSharedContent();
        storeClearSharedContent();
        setSharedContent(null);
        appSelectionInProgress = false;
        isHandlingAction = false;
        setIsProcessing(false);
    };

    if (!sharedContent) return null;

    const uri = sharedContent.uri?.toLowerCase() || '';
    const mime = sharedContent.mimeType?.toLowerCase() || '';
    const name = sharedContent.fileName?.toLowerCase() || uri.split('/').pop()?.toLowerCase() || '';
    const isSpell = name.endsWith('.spell') || uri.endsWith('.spell') || mime === 'application/octet-stream';
    const displaySpellName = resolvedSpellName || sharedContent.fileName || sharedContent.uri?.split('/').pop() || '';
    const displaySpellDescription = resolvedSpellDesc;
    const displaySpellIcon = resolvedSpellIcon;
    const displayFileName = sharedContent.text
        ? (sharedContent.text.length > 60 ? sharedContent.text.slice(0, 60) + '...' : sharedContent.text)
        : (sharedContent.fileName || sharedContent.uri?.split('/').pop() || t('typeFile'));
    const contentType = detectContentType(sharedContent.mimeType, !!sharedContent.uri, !!sharedContent.text);

    return (
        <ShareReceiverUI
            isSpell={isSpell}
            displaySpellName={displaySpellName}
            displaySpellDescription={displaySpellDescription}
            displaySpellIcon={displaySpellIcon}
            displayFileName={displayFileName}
            uri={uri}
            mimeType={sharedContent.mimeType}
            contentType={contentType}
            isProcessing={isProcessing}
            apps={apps}
            onImportSpell={handleImportSpell}
            onSelectApp={handleSelectApp}
            onClose={handleClose}
        />
    );
}

/** Visual bottom sheet UI — separated for clarity */
function ShareReceiverUI({
    isSpell,
    displaySpellName,
    displaySpellDescription,
    displaySpellIcon,
    displayFileName,
    uri,
    mimeType,
    contentType,
    isProcessing,
    apps,
    onImportSpell,
    onSelectApp,
    onClose,
}: {
    isSpell: boolean;
    displaySpellName: string;
    displaySpellDescription: string;
    displaySpellIcon: string | null;
    displayFileName: string;
    uri: string;
    mimeType?: string;
    contentType: ShareContentType;
    isProcessing: boolean;
    apps: GeneratedApp[];
    onImportSpell: () => void;
    onSelectApp: (app: GeneratedApp) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const slideAnim = useMemo(() => new Animated.Value(0), []);
    const compatibleApps = useMemo(
        () => apps.filter(app => canSpellReceive(app.code, contentType)),
        [apps, contentType],
    );

    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue: 1,
            useNativeDriver: true,
            damping: 20,
            stiffness: 200,
        }).start();
    }, [slideAnim]);

    const fileIcon = getFileIcon(displayFileName, mimeType);
    const fileType = getFileTypeLabel(displayFileName, mimeType);

    const renderSpellItem = ({ item }: { item: GeneratedApp }) => {
        const avatarColor = getAvatarColor(item.name);
        const initials = getInitials(item.name);

        return (
            <TouchableOpacity
                style={[styles.spellItem, { opacity: isProcessing ? 0.5 : 1 }]}
                onPress={() => onSelectApp(item)}
                disabled={isProcessing}
                activeOpacity={0.7}
            >
                {item.iconPath ? (
                    <Image source={{ uri: item.iconPath }} style={styles.spellAvatar} />
                ) : (
                    <View style={[styles.spellAvatar, { backgroundColor: avatarColor }]}>
                        <Text style={styles.spellAvatarText}>{initials}</Text>
                    </View>
                )}
                <View style={styles.spellInfo}>
                    <Text style={styles.spellName} numberOfLines={1}>{item.name}</Text>
                    {!!item.shortDescription && (
                        <Text style={styles.spellDesc} numberOfLines={1}>{item.shortDescription}</Text>
                    )}
                </View>
                <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
        );
    };

    return (
        <Modal visible={true} animationType="none" transparent statusBarTranslucent>
            <View style={styles.overlay}>
                <TouchableOpacity style={styles.overlayTouchable} activeOpacity={1} onPress={onClose} />

                <Animated.View style={[
                    styles.sheet,
                    { paddingBottom: Math.max(insets.bottom, 16) },
                    {
                        transform: [{
                            translateY: slideAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: [600, 0],
                            }),
                        }],
                    },
                ]}>
                    {/* Handle */}
                    <View style={styles.handleRow}>
                        <View style={styles.handle} />
                    </View>

                    {/* File preview card */}
                    <View style={styles.previewCard}>
                        {isSpell && displaySpellIcon ? (
                            <Image style={styles.previewIconImage} source={{ uri: `data:image/png;base64,${displaySpellIcon}` }} />
                        ) : contentType === 'image' && uri ? (
                            <Image style={styles.previewIconImage} source={{ uri: uri }} />
                        ) : (
                            <Text style={styles.previewIcon}>{fileIcon}</Text>
                        )}
                        <View style={styles.previewInfo}>
                            <Text style={styles.previewName} numberOfLines={1}>
                                {isSpell ? displaySpellName : displayFileName}
                            </Text>
                            {(isSpell && displaySpellDescription) || (!isSpell && fileType) ? (
                                <Text style={styles.previewDesc} numberOfLines={2}>
                                    {isSpell ? displaySpellDescription : fileType}
                                </Text>
                            ) : null}
                        </View>
                    </View>

                    {isSpell ? (
                        /* ——— Spell tab ——— */
                        <>
                            {/* Import button */}
                            <TouchableOpacity
                                style={[styles.importButton, { opacity: isProcessing ? 0.5 : 1 }]}
                                onPress={onImportSpell}
                                disabled={isProcessing}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.importButtonText}>✨ {t('shareImportSpell')}</Text>
                            </TouchableOpacity>

                            {/* Divider */}
                            {compatibleApps.length > 0 && (
                                <View style={styles.dividerRow}>
                                    <View style={styles.dividerLine} />
                                    <Text style={styles.dividerText}>{t('shareOrSendTo')}</Text>
                                    <View style={styles.dividerLine} />
                                </View>
                            )}

                            {/* Spell list */}
                            {compatibleApps.length > 0 && (
                                <FlatList
                                    data={compatibleApps}
                                    keyExtractor={(item) => item.id.toString()}
                                    renderItem={renderSpellItem}
                                    style={styles.spellList}
                                />
                            )}
                        </>
                    ) : (
                        /* ——— File tab ——— */
                        <>
                            {compatibleApps.length > 0 && (
                                <Text style={styles.sendToLabel}>{t('shareSendToWhich')}</Text>
                            )}

                            <FlatList
                                data={compatibleApps}
                                keyExtractor={(item) => item.id.toString()}
                                renderItem={renderSpellItem}
                                style={styles.spellList}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {apps.length === 0 ? t('shareNoSpells') : t('shareNoCompatible')}
                                    </Text>
                                }
                            />
                        </>
                    )}

                    {/* Cancel */}
                    <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.7}>
                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    overlayTouchable: {
        flex: 1,
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: '85%',
        paddingHorizontal: spacing.lg,
    },
    handleRow: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.onSurfaceVariant,
        opacity: 0.4,
    },

    // Preview card
    previewCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
    },
    previewIcon: {
        fontSize: 28,
        marginRight: spacing.md,
    },
    previewIconImage: {
        width: 36,
        height: 36,
        borderRadius: 8,
        marginRight: spacing.md,
    },
    previewInfo: {
        flex: 1,
    },
    previewName: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '600',
    },
    previewType: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    previewDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        marginTop: 2,
        lineHeight: 17,
    },

    // Import button
    importButton: {
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
        paddingVertical: 14,
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    importButtonText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: 'bold',
    },

    // Divider
    dividerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    dividerLine: {
        flex: 1,
        height: 1,
        backgroundColor: colors.surfaceVariant,
    },
    dividerText: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginHorizontal: spacing.sm,
    },

    // Send to label
    sendToLabel: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '600',
        marginBottom: spacing.sm,
    },

    // Spell list
    spellList: {
        maxHeight: 240,
        marginBottom: spacing.md,
    },
    spellItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: spacing.sm,
        borderRadius: borderRadius.sm,
        marginBottom: 2,
    },
    spellAvatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: spacing.md,
    },
    spellAvatarText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    spellInfo: {
        flex: 1,
        marginRight: spacing.sm,
    },
    spellName: {
        color: colors.onSurface,
        fontSize: 15,
        fontWeight: '500',
    },
    spellDesc: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 1,
    },
    chevron: {
        color: colors.onSurfaceVariant,
        fontSize: 22,
        fontWeight: '300',
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        padding: spacing.lg,
        fontStyle: 'italic',
    },

    // Cancel
    cancelButton: {
        paddingVertical: 14,
        borderRadius: borderRadius.md,
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        marginTop: spacing.xs,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 15,
        fontWeight: '600',
    },
});
