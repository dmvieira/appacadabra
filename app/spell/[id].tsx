import React, { useState, useCallback, useEffect, ReactNode } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    Modal,
    Alert,
    DeviceEventEmitter,
    Platform,
    Linking,
    Share,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAppStore } from '../../lib/store';
import { migrateStorageBlobsToFiles } from '../../lib/bridges/messageHandlers';
import * as db from '../../lib/database/db';
import { colors, spacing, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';

type MediaType = 'text' | 'image' | 'video' | 'audio';
type FilterType = 'all' | 'text' | 'image' | 'video' | 'audio';

type RelicEntry = {
    id: number;
    callbackName: string;
    action: string;
    requestData: string | null;
    result: string;
    mediaLocalPath: string | null;
    creditsUsed: number;
    success: number;
    delivered: number;
    createdAt: number;
};

type StorageEntry = {
    key: string;
    value: string;
};

function getMediaType(entry: RelicEntry): MediaType {
    if (entry.mediaLocalPath) {
        const ext = entry.mediaLocalPath.split('.').pop()?.toLowerCase() ?? '';
        if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
    }
    // Fallback: infer from action
    if (['AI_GENERATE_VIDEO', 'CAMERA_RECORD_VIDEO'].includes(entry.action)) return 'video';
    if (['AI_GENERATE_IMAGE', 'CAMERA_TAKE_PHOTO'].includes(entry.action)) return 'image';
    if (['AUDIO_RECORD_STOP', 'AUDIO_SPEAK_AI'].includes(entry.action)) return 'audio';
    return 'text';
}

function isRelicActive(entry: RelicEntry, storageItems: StorageEntry[]): boolean {
    const callback = entry.callbackName;
    return storageItems.some(item => {
        // Skip searching in massive values (probably raw base64) to avoid freezing JS thread
        if (item.value.length > 5000) return false;
        return item.value.includes(callback);
    });
}

function getActionLabel(mediaType: MediaType): string {
    if (mediaType === 'image') return t('relicActionView');
    if (mediaType === 'video') return t('relicActionView');
    if (mediaType === 'audio') return t('relicActionListen');
    return t('relicActionRead');
}

function mediaTypeEmoji(mediaType: MediaType): string {
    if (mediaType === 'image') return '🖼️';
    if (mediaType === 'video') return '🎬';
    if (mediaType === 'audio') return '🎙️';
    return '📝';
}

const RELIC_FRIENDLY_NAMES: Record<string, string> = {
    CAMERA_TAKE_PHOTO: t('relicFilterImage'),
    CAMERA_RECORD_VIDEO: t('relicFilterVideo'),
    AI_GENERATE_IMAGE: t('relicFilterImage') + ' AI',
    AI_GENERATE_VIDEO: t('relicFilterVideo') + ' AI',
    AI_GENERATE: t('relicFilterText') + ' AI',
    AUDIO_RECORD_STOP: t('relicFilterAudio'),
    AUDIO_SPEAK_AI: t('relicFilterAudio') + ' AI',
};

function getRelicDisplayName(entry: RelicEntry): string {
    if (entry.action === 'FILESYSTEM') {
        const type = getMediaType(entry);
        if (type === 'video') return t('relicFilterVideo');
        if (type === 'audio') return t('relicFilterAudio');
        if (type === 'image') return t('relicFilterImage');
        return t('relicFilterText');
    }
    return RELIC_FRIENDLY_NAMES[entry.action] ?? entry.callbackName;
}

function formatShortDate(ts: number): string {
    const d = new Date(ts);
    const day = d.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[d.getMonth()]}`;
}

export default function SpellDataScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const appId = Number(id);
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const apps = useAppStore(s => s.apps);
    const app = apps.find(a => a.id === appId) ?? null;

    const [relics, setRelics] = useState<RelicEntry[]>([]);
    const [storageItems, setStorageItems] = useState<StorageEntry[]>([]);
    const [filter, setFilter] = useState<FilterType>('all');
    const [textModal, setTextModal] = useState<{ visible: boolean; content: string }>({ visible: false, content: '' });
    const [cleanModal, setCleanModal] = useState(false);

    const loadData = useCallback(async () => {
        try {
            // Migrate any raw base64 blobs (e.g. from Android camera with \n) to files first
            await migrateStorageBlobsToFiles(appId);

            const [dbRelics, s] = await Promise.all([
                db.getAllWebviewAiCacheForApp(appId),
                db.getStorageForApp(appId),
            ]);

            // Use documentDirectory (with file:// prefix) to match what RunnerApp uses
            const docDir = (FileSystem.documentDirectory ?? '').replace(/\/$/, '');
            const mediaDir = `${docDir}/appacadabra_media/${appId}`;
            // Bare path for comparison (without file://)
            const mediaDirBare = mediaDir.replace('file://', '');

            let fsFiles: string[] = [];
            try {
                fsFiles = await FileSystem.readDirectoryAsync(mediaDir);
            } catch { /* directory doesn't exist yet */ }

            // Normalize dbPaths — strip file:// for consistent comparison
            const dbPaths = new Set(
                (dbRelics as RelicEntry[]).map(r => r.mediaLocalPath?.replace('file://', '')).filter(Boolean)
            );

            const fsRelics: RelicEntry[] = fsFiles
                .filter(f => !dbPaths.has(`${mediaDirBare}/${f}`))
                .map((f, i) => ({
                    id: -(i + 1),
                    callbackName: f,
                    action: 'FILESYSTEM',
                    requestData: null,
                    result: `${mediaDirBare}/${f}`,
                    mediaLocalPath: `${mediaDirBare}/${f}`,
                    creditsUsed: 0,
                    success: 1,
                    delivered: 1,
                    createdAt: Date.now(),
                }));

            setRelics([...(dbRelics as RelicEntry[]), ...fsRelics]);
            setStorageItems(s as StorageEntry[]);
        } catch (err) {
            console.warn('[SpellData] Error loading data:', err);
        }
    }, [appId]);

    useFocusEffect(useCallback(() => {
        loadData();
    }, [loadData]));

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('APP_UPDATED', ({ appId: updId }: { appId: number }) => {
            if (updId === appId) loadData();
        });
        return () => sub.remove();
    }, [appId, loadData]);

    const filteredRelics = filter === 'all'
        ? relics
        : relics.filter(r => getMediaType(r) === filter);

    const handleOpenRelic = async (entry: RelicEntry) => {
        const mediaType = getMediaType(entry);
        if (mediaType === 'text') {
            setTextModal({ visible: true, content: entry.result });
        } else if (entry.mediaLocalPath) {
            try {
                const ext = entry.mediaLocalPath.split('.').pop()?.toLowerCase() ?? '';
                const mimeMap: Record<string, string> = {
                    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                    gif: 'image/gif', webp: 'image/webp',
                    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
                    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4',
                };
                const mimeType = mimeMap[ext] ?? '*/*';
                await Sharing.shareAsync('file://' + entry.mediaLocalPath, { mimeType });
            } catch {
                Alert.alert(t('errorTitle'), t('unknownError'));
            }
        } else if (entry.result?.startsWith('file://')) {
            try {
                await Sharing.shareAsync(entry.result);
            } catch {
                Alert.alert(t('errorTitle'), t('unknownError'));
            }
        } else if (entry.result?.startsWith('http')) {
            try {
                await Linking.openURL(entry.result);
            } catch {
                Alert.alert(t('errorTitle'), t('unknownError'));
            }
        } else {
            setTextModal({ visible: true, content: entry.result });
        }
    };

    const deleteStorageBlobFiles = async (items: StorageEntry[]) => {
        const MARKER = '__appblob__:';
        for (const item of items) {
            if (!item.value.startsWith(MARKER)) continue;
            const payload = item.value.slice(MARKER.length);
            const firstSep = payload.indexOf('|');
            if (firstSep < 0) continue;
            const rest = payload.slice(firstSep + 1);
            const secondSep = rest.indexOf('|');
            const barePath = secondSep >= 0 ? rest.slice(secondSep + 1) : rest;
            if (barePath) {
                await FileSystem.deleteAsync('file://' + barePath, { idempotent: true }).catch(() => {});
            }
        }
    };

    const handleCleanEssence = () => {
        Alert.alert(
            t('cleanEssence'),
            t('cleanEssenceDesc'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        await deleteStorageBlobFiles(storageItems);
                        await db.clearStorageForApp(appId);
                        await loadData();
                    },
                },
            ]
        );
    };

    const handlePurgeOldRelics = () => {
        Alert.alert(
            t('purgeOldRelics'),
            t('purgeOldRelicsDesc'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        const toDelete = relics.filter(r => !isRelicActive(r, storageItems));
                        for (const relic of toDelete) {
                            if (relic.mediaLocalPath) {
                                await FileSystem.deleteAsync(relic.mediaLocalPath, { idempotent: true }).catch(() => { });
                            }
                            if (relic.id > 0) await db.deleteWebviewAiCacheEntry(relic.id);
                        }
                        await loadData();
                    },
                },
            ]
        );
    };

    const handleResetTotal = () => {
        Alert.alert(
            t('resetTotal'),
            t('resetTotalDesc'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        await deleteStorageBlobFiles(storageItems);
                        await db.clearStorageForApp(appId);
                        for (const relic of relics) {
                            if (relic.mediaLocalPath) {
                                await FileSystem.deleteAsync(relic.mediaLocalPath, { idempotent: true }).catch(() => { });
                            }
                        }
                        await db.clearAllWebviewAiCacheForApp(appId);
                        await loadData();
                    },
                },
            ]
        );
    };

    // ── Recursive value renderer for localStorage ──
    const renderValue = (val: any, depth: number = 0): ReactNode => {
        if (Array.isArray(val)) {
            return (
                <View style={styles.indentLevel}>
                    {val.map((item, i) => (
                        <View key={i}>{renderValue(item, depth + 1)}</View>
                    ))}
                </View>
            );
        }
        if (typeof val === 'object' && val !== null) {
            return (
                <View style={styles.indentLevel}>
                    {Object.entries(val).map(([k, v]) => (
                        <View key={k} style={{ marginBottom: 4 }}>
                            <Text style={styles.dimKey}>{k}</Text>
                            {renderValue(v, depth + 1)}
                        </View>
                    ))}
                </View>
            );
        }
        // Primitive value — check if linked to a relic
        const valStr = typeof val === 'string' ? val : String(val);
        const isHuge = valStr.length > 5000;

        // Always run relic check (O(n relics), fast regardless of value size)
        const linked = relics.find(r =>
            valStr.includes(r.callbackName) || (r.result.length < 5000 && valStr === r.result)
        );

        // Detect blob markers — show [mimeType] and link via embedded callbackName
        if (typeof val === 'string' && val.startsWith('__appblob__:')) {
            const payload = val.slice('__appblob__:'.length);
            const firstSep = payload.indexOf('|');
            const mimeType = firstSep >= 0 ? payload.slice(0, firstSep) : payload;
            const rest = firstSep >= 0 ? payload.slice(firstSep + 1) : '';
            const secondSep = rest.indexOf('|');
            const embeddedCb = secondSep >= 0 ? rest.slice(0, secondSep) : '';
            const blobLinked = embeddedCb
                ? relics.find(r => r.callbackName === embeddedCb)
                : linked;
            return (
                <View style={styles.valueRow}>
                    <Text style={styles.valueText}>[{mimeType || 'blob'}]</Text>
                    {blobLinked && (
                        <View style={styles.linkedBadge}>
                            <Text style={styles.linkedBadgeText}>#{Math.abs(blobLinked.id)}</Text>
                        </View>
                    )}
                </View>
            );
        }

        // Belt-and-suspenders: large raw data that bypassed blob conversion
        if (isHuge) {
            const mimeLabel = valStr.startsWith('data:')
                ? valStr.slice(5, valStr.indexOf(';'))
                : 'data';
            return (
                <View style={styles.valueRow}>
                    <Text style={styles.valueText}>[{mimeLabel}]</Text>
                    {linked && (
                        <View style={styles.linkedBadge}>
                            <Text style={styles.linkedBadgeText}>#{Math.abs(linked.id)}</Text>
                        </View>
                    )}
                </View>
            );
        }

        return (
            <View style={styles.valueRow}>
                <Text style={styles.valueText}>
                    "{valStr}"
                </Text>
                {linked && (
                    <View style={styles.linkedBadge}>
                        <Text style={styles.linkedBadgeText}>#{Math.abs(linked.id)}</Text>
                    </View>
                )}
            </View>
        );
    };

    const renderStorageItem = (item: StorageEntry) => {
        let parsed: any = item.value;
        try { parsed = JSON.parse(item.value); } catch { /* keep string */ }

        return (
            <View key={item.key} style={styles.storageRow}>
                <View style={styles.storageRowHeader}>
                    <Text style={styles.storageKey}>{item.key}</Text>
                </View>
                {renderValue(parsed)}
            </View>
        );
    };

    const filters: { key: FilterType; label: string }[] = [
        { key: 'all', label: t('relicFilterAll') },
        { key: 'video', label: t('relicFilterVideo') },
        { key: 'audio', label: t('relicFilterAudio') },
        { key: 'text', label: t('relicFilterText') },
        { key: 'image', label: t('relicFilterImage') },
    ];

    return (
        <SafeAreaView style={styles.safeArea} edges={['top']}>
            {/* ── Header ── */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={styles.backText}>‹</Text>
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{t('spellDataTitle')}</Text>
                <View style={styles.backBtn} />
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
                {/* ═══════════ Section 1: Relics ═══════════ */}
                <View style={styles.sectionWrapper}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionLabel}>{t('relicsCreated')}</Text>
                        <TouchableOpacity onPress={() => setCleanModal(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.trashIcon}>🗑️</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Filter Pills */}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ paddingRight: 8 }}>
                        {filters.map(f => (
                            <TouchableOpacity
                                key={f.key}
                                onPress={() => setFilter(f.key)}
                                style={[styles.filterPill, filter === f.key && styles.filterPillActive]}
                            >
                                <Text style={[styles.filterPillText, filter === f.key && styles.filterPillTextActive]}>
                                    {f.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>

                    {/* Relics Card */}
                    <View style={styles.card}>
                        {filteredRelics.length === 0 ? (
                            <Text style={styles.emptyText}>{t('noRelics')}</Text>
                        ) : (
                            <ScrollView style={{ maxHeight: 340 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                                {filteredRelics.map((entry, idx) => {
                                    const mediaType = getMediaType(entry);
                                    const active = isRelicActive(entry, storageItems);
                                    return (
                                        <View
                                            key={entry.id ?? idx}
                                            style={[
                                                styles.relicRow,
                                                active && styles.relicRowActive,
                                                idx < filteredRelics.length - 1 && styles.relicRowBorder,
                                            ]}
                                        >
                                            <View style={styles.relicLeft}>
                                                <Text style={styles.relicEmoji}>{mediaTypeEmoji(mediaType)}</Text>
                                                <View style={styles.relicInfo}>
                                                    <Text style={styles.relicName} numberOfLines={1}>{getRelicDisplayName(entry)} #{Math.abs(entry.id)}</Text>
                                                    <View style={styles.relicMeta}>
                                                        {active && <Text style={styles.activeBadgeText}>{t('relicActive')}</Text>}
                                                        <Text style={styles.relicDate}>{formatShortDate(entry.createdAt)}</Text>
                                                        {entry.creditsUsed > 0 && (
                                                            <Text style={styles.relicMana}>⚡ {entry.creditsUsed.toFixed(2).replace('.', ',')}</Text>
                                                        )}
                                                    </View>
                                                </View>
                                            </View>
                                            <TouchableOpacity style={styles.relicActionBtn} onPress={() => handleOpenRelic(entry)}>
                                                <Text style={styles.relicActionText}>{getActionLabel(mediaType)}</Text>
                                            </TouchableOpacity>
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        )}
                    </View>
                </View>

                {/* ═══════════ Section 2: Essence (LocalStorage) ═══════════ */}
                <View style={styles.sectionWrapper}>
                    <Text style={styles.sectionLabel}>{t('spellEssence')}</Text>
                    <View style={[styles.card, { paddingHorizontal: spacing.sm }]}>
                        {storageItems.length === 0 ? (
                            <Text style={styles.emptyText}>{t('noEssence')}</Text>
                        ) : (
                            <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                                {storageItems.map(renderStorageItem)}
                            </ScrollView>
                        )}
                    </View>
                </View>

                {/* ═══════════ Purification Ritual ═══════════ */}
                <View style={styles.sectionWrapper}>
                    <TouchableOpacity style={styles.purifyMainBtn} onPress={() => setCleanModal(true)} activeOpacity={0.75}>
                        <Text style={styles.purifyMainIcon}>✦</Text>
                        <Text style={styles.purifyMainText}>{t('purificationRitual')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.purifyHint}>{t('purificationSubtitle')}</Text>
                </View>
            </ScrollView>

            {/* ── Cleanup Modal ── */}
            <Modal visible={cleanModal} transparent animationType="fade" onRequestClose={() => setCleanModal(false)}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalCard}>
                        <View style={styles.modalTopRow}>
                            <Text style={styles.modalTitle}>{t('purificationRitual')}</Text>
                            <TouchableOpacity onPress={() => setCleanModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                                <Text style={styles.modalCloseX}>✕</Text>
                            </TouchableOpacity>
                        </View>
                        <Text style={styles.modalDesc}>{t('purificationSubtitle')}</Text>

                        <View style={{ gap: 10, marginTop: 8 }}>
                            <TouchableOpacity style={styles.cleanOption} onPress={() => { setCleanModal(false); handleCleanEssence(); }}>
                                <Text style={styles.cleanOptionTitle}>{t('cleanEssence')}</Text>
                                <Text style={styles.cleanOptionDesc}>{t('cleanEssenceDesc')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.cleanOption} onPress={() => { setCleanModal(false); handlePurgeOldRelics(); }}>
                                <Text style={styles.cleanOptionTitle}>{t('purgeOldRelics')}</Text>
                                <Text style={styles.cleanOptionDesc}>{t('purgeOldRelicsDesc')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={[styles.cleanOption, styles.cleanOptionDanger]} onPress={() => { setCleanModal(false); handleResetTotal(); }}>
                                <Text style={[styles.cleanOptionTitle, { color: colors.error }]}>{t('resetTotal')}</Text>
                                <Text style={[styles.cleanOptionDesc, { color: 'rgba(255,75,110,0.6)' }]}>{t('resetTotalDesc')}</Text>
                            </TouchableOpacity>
                        </View>

                        <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setCleanModal(false)}>
                            <Text style={styles.modalCancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* ── Text Content Modal ── */}
            <Modal
                visible={textModal.visible}
                transparent
                animationType="slide"
                onRequestClose={() => setTextModal({ visible: false, content: '' })}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.textModalContent}>
                        <View style={styles.textModalHeader}>
                            <Text style={styles.textModalTitle}>{t('textViewerTitle')}</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                <TouchableOpacity onPress={() => Share.share({ message: textModal.content })}>
                                    <Text style={styles.textModalShare}>📤</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => setTextModal({ visible: false, content: '' })}>
                                    <Text style={styles.textModalClose}>{t('close')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        <ScrollView style={styles.textModalScroll}>
                            <Text style={styles.textModalBody} selectable>{textModal.content}</Text>
                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: {
        flex: 1,
        backgroundColor: colors.background,
    },

    // ── Header ──
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm + 2,
    },
    backBtn: {
        width: 36,
        alignItems: 'center',
    },
    backText: {
        fontSize: 30,
        color: colors.onSurfaceVariant,
        lineHeight: 34,
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
        fontSize: 17,
        fontWeight: '700',
        color: colors.onBackground,
        letterSpacing: -0.3,
    },

    // ── Scroll ──
    scroll: {
        flex: 1,
        paddingHorizontal: spacing.md,
    },

    // ── Section ──
    sectionWrapper: {
        marginBottom: spacing.lg,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
        paddingHorizontal: 2,
    },
    sectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: colors.primary,
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        marginBottom: 8,
    },
    trashIcon: {
        fontSize: 15,
        opacity: 0.5,
    },

    // ── Filter Pills ──
    filterRow: {
        marginBottom: spacing.sm,
        maxHeight: 36,
    },
    filterPill: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: borderRadius.full,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        marginRight: 6,
    },
    filterPillActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    filterPillText: {
        fontSize: 11,
        fontWeight: '600',
        color: colors.onSurfaceVariant,
    },
    filterPillTextActive: {
        color: '#fff',
    },

    // ── Card ──
    card: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.04)',
        overflow: 'hidden',
    },

    emptyText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        textAlign: 'center',
        paddingVertical: spacing.lg,
        fontStyle: 'italic',
    },

    // ── Relic Row ──
    relicRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: 12,
    },
    relicRowActive: {
        borderLeftWidth: 3,
        borderLeftColor: colors.primary,
        backgroundColor: 'rgba(123,46,255,0.04)',
    },
    relicRowBorder: {
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.04)',
    },
    relicLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flex: 1,
        marginRight: 8,
    },
    relicEmoji: {
        fontSize: 20,
    },
    relicInfo: {
        flex: 1,
    },
    relicName: {
        fontSize: 12,
        fontWeight: '600',
        color: colors.onBackground,
    },
    relicMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 2,
    },
    activeBadgeText: {
        fontSize: 8,
        fontWeight: '800',
        color: colors.success,
        textTransform: 'uppercase',
        letterSpacing: 1,
    },
    relicDate: {
        fontSize: 9,
        color: colors.onSurfaceVariant,
    },
    relicMana: {
        fontSize: 9,
        fontWeight: '700',
        color: '#ffcc00',
    },
    relicActionBtn: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: borderRadius.sm,
        borderWidth: 1,
        borderColor: 'rgba(123,46,255,0.3)',
    },
    relicActionText: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.primary,
    },

    // ── Storage / Essence ──
    storageRow: {
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.04)',
    },
    storageRowHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    storageKey: {
        fontSize: 10,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        color: colors.onSurfaceVariant,
    },
    storagePrimitiveValue: {
        fontSize: 10,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        color: '#c4a0ff',
        flexShrink: 1,
    },
    indentLevel: {
        paddingLeft: 12,
        borderLeftWidth: 1,
        borderLeftColor: 'rgba(123,46,255,0.25)',
        marginLeft: 8,
        marginTop: 6,
        gap: 4,
    },
    dimKey: {
        fontSize: 9,
        color: 'rgba(184,176,208,0.6)',
        fontStyle: 'italic',
    },
    valueRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 4,
    },
    valueText: {
        fontSize: 9,
        color: '#c4a0ff',
        flex: 1,
    },
    linkedBadge: {
        backgroundColor: 'rgba(16,185,129,0.1)',
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: borderRadius.full,
        borderWidth: 1,
        borderColor: 'rgba(16,185,129,0.2)',
    },
    linkedBadgeText: {
        fontSize: 8,
        color: colors.success,
        fontWeight: '500',
    },

    // ── Purification ──
    purifyMainBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 14,
        borderRadius: borderRadius.xl,
        backgroundColor: 'rgba(255,75,110,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,75,110,0.18)',
    },
    purifyMainIcon: {
        fontSize: 14,
        color: colors.error,
    },
    purifyMainText: {
        fontSize: 11,
        fontWeight: '800',
        color: colors.error,
        textTransform: 'uppercase',
        letterSpacing: 1.5,
    },
    purifyHint: {
        fontSize: 10,
        textAlign: 'center',
        color: colors.onSurfaceVariant,
        marginTop: 8,
        paddingHorizontal: spacing.xl,
        lineHeight: 16,
        fontStyle: 'italic',
    },

    // ── Cleanup Modal ──
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.9)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
    },
    modalCard: {
        backgroundColor: colors.surface,
        borderRadius: borderRadius.xl + 4,
        padding: spacing.lg,
        width: '100%',
        maxWidth: 360,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    modalTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: colors.onBackground,
    },
    modalCloseX: {
        fontSize: 16,
        color: colors.onSurfaceVariant,
    },
    modalDesc: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginBottom: 12,
    },
    cleanOption: {
        padding: spacing.md,
        borderRadius: borderRadius.xl,
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
    },
    cleanOptionDanger: {
        borderColor: 'rgba(255,75,110,0.15)',
    },
    cleanOptionTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: '#c4a0ff',
        marginBottom: 2,
    },
    cleanOptionDesc: {
        fontSize: 10,
        color: 'rgba(184,176,208,0.6)',
        lineHeight: 15,
    },
    modalCancelBtn: {
        marginTop: spacing.md,
        paddingVertical: 14,
        borderRadius: borderRadius.xl,
        backgroundColor: colors.surfaceVariant,
        alignItems: 'center',
    },
    modalCancelText: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.onBackground,
    },

    // ── Text Viewer Modal ──
    textModalContent: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        maxHeight: '80%',
        minHeight: 200,
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
    },
    textModalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.06)',
    },
    textModalTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.onBackground,
    },
    textModalShare: {
        fontSize: 18,
    },
    textModalClose: {
        fontSize: 14,
        color: colors.primary,
        fontWeight: '600',
    },
    textModalScroll: {
        padding: spacing.md,
    },
    textModalBody: {
        fontSize: 13,
        color: colors.onBackground,
        lineHeight: 20,
    },
});
