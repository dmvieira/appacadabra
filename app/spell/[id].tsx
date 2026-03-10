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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAppStore } from '../../lib/store';
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
    if (!entry.mediaLocalPath) return 'text';
    const ext = entry.mediaLocalPath.split('.').pop()?.toLowerCase() ?? '';
    if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
    return 'text';
}

function isRelicActive(entry: RelicEntry, storageItems: StorageEntry[]): boolean {
    return storageItems.some(item =>
        item.value.includes(entry.callbackName) ||
        (entry.result && item.value.includes(entry.result))
    );
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
    if (mediaType === 'audio') return '🎵';
    return '📄';
}

function countDepth(val: any): number {
    if (typeof val !== 'object' || val === null) return 0;
    if (Array.isArray(val)) {
        return 1 + Math.max(0, ...val.map(countDepth));
    }
    const vals = Object.values(val);
    if (vals.length === 0) return 1;
    return 1 + Math.max(0, ...vals.map(countDepth));
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
        const [r, s] = await Promise.all([
            db.getAllWebviewAiCacheForApp(appId),
            db.getStorageForApp(appId),
        ]);
        setRelics(r as RelicEntry[]);
        setStorageItems(s as StorageEntry[]);
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
                await Sharing.shareAsync('file://' + entry.mediaLocalPath);
            } catch {
                Alert.alert(t('errorTitle'), t('unknownError'));
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
                                await FileSystem.deleteAsync(relic.mediaLocalPath, { idempotent: true }).catch(() => {});
                            }
                            await db.deleteWebviewAiCacheEntry(relic.id);
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
                        await db.clearStorageForApp(appId);
                        for (const relic of relics) {
                            if (relic.mediaLocalPath) {
                                await FileSystem.deleteAsync(relic.mediaLocalPath, { idempotent: true }).catch(() => {});
                            }
                        }
                        await db.clearAllWebviewAiCacheForApp(appId);
                        await loadData();
                    },
                },
            ]
        );
    };

    const renderValue = (val: any, depth = 0): ReactNode => {
        if (depth >= 3) {
            const remaining = countDepth(val);
            return (
                <Text key="more" style={styles.moreText}>
                    {t('essenceMoreLevels', { count: remaining })}
                </Text>
            );
        }
        if (Array.isArray(val)) {
            return (
                <View style={styles.indentLevel}>
                    {val.slice(0, 3).map((item, i) => (
                        <View key={i}>{renderValue(item, depth + 1)}</View>
                    ))}
                    {val.length > 3 && (
                        <Text style={styles.moreText}>{t('essenceMoreLevels', { count: val.length - 3 })}</Text>
                    )}
                </View>
            );
        }
        if (typeof val === 'object' && val !== null) {
            return (
                <View style={styles.indentLevel}>
                    {Object.entries(val).map(([k, v]) => (
                        <View key={k} style={{ marginBottom: 2 }}>
                            <Text style={styles.dimKey}>{k}</Text>
                            {renderValue(v, depth + 1)}
                        </View>
                    ))}
                </View>
            );
        }
        const linked = relics.find(r =>
            String(val).includes(r.callbackName) || String(val) === r.result
        );
        return (
            <View style={styles.valueRow}>
                <Text style={styles.valueText} numberOfLines={2}>{String(val)}</Text>
                {linked && (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{linked.callbackName}</Text>
                    </View>
                )}
            </View>
        );
    };

    const renderStorageItem = (item: StorageEntry) => {
        let parsed: any = item.value;
        try { parsed = JSON.parse(item.value); } catch { /* keep string */ }

        return (
            <View key={item.key} style={styles.storageItem}>
                <Text style={styles.storageKey}>{item.key}</Text>
                {renderValue(parsed, 0)}
            </View>
        );
    };

    const filters: { key: FilterType; label: string }[] = [
        { key: 'all', label: t('relicFilterAll') },
        { key: 'text', label: t('relicFilterText') },
        { key: 'image', label: t('relicFilterImage') },
        { key: 'video', label: t('relicFilterVideo') },
        { key: 'audio', label: t('relicFilterAudio') },
    ];

    return (
        <SafeAreaView style={styles.safeArea} edges={['top']}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={styles.backText}>‹</Text>
                </TouchableOpacity>
                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle}>{t('spellDataTitle')}</Text>
                    {app && <Text style={styles.headerSubtitle} numberOfLines={1}>{app.name}</Text>}
                </View>
                <View style={styles.backBtn} />
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
                {/* Relics Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('relicsCreated')}</Text>

                    {/* Filter Pills */}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow}>
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

                    {filteredRelics.length === 0 ? (
                        <Text style={styles.emptyText}>{t('noRelics')}</Text>
                    ) : (
                        filteredRelics.map((entry, idx) => {
                            const mediaType = getMediaType(entry);
                            const active = isRelicActive(entry, storageItems);
                            return (
                                <View key={entry.id ?? idx} style={styles.relicCard}>
                                    <View style={styles.relicHeader}>
                                        <Text style={styles.relicEmoji}>{mediaTypeEmoji(mediaType)}</Text>
                                        <View style={styles.relicInfo}>
                                            <Text style={styles.relicName} numberOfLines={1}>{entry.callbackName}</Text>
                                            <Text style={styles.relicDate}>
                                                {new Date(entry.createdAt).toLocaleDateString()}
                                            </Text>
                                        </View>
                                        {active && (
                                            <View style={styles.activeBadge}>
                                                <Text style={styles.activeBadgeText}>{t('relicActive')}</Text>
                                            </View>
                                        )}
                                    </View>
                                    {entry.result ? (
                                        <Text style={styles.relicPreview} numberOfLines={2}>{entry.result}</Text>
                                    ) : null}
                                    <TouchableOpacity
                                        style={styles.relicActionBtn}
                                        onPress={() => handleOpenRelic(entry)}
                                    >
                                        <Text style={styles.relicActionText}>{getActionLabel(mediaType)}</Text>
                                    </TouchableOpacity>
                                </View>
                            );
                        })
                    )}
                </View>

                {/* Essence Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('spellEssence')}</Text>
                    {storageItems.length === 0 ? (
                        <Text style={styles.emptyText}>{t('noEssence')}</Text>
                    ) : (
                        storageItems.map(renderStorageItem)
                    )}
                </View>

                {/* Purification Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('purificationRitual')}</Text>
                    <Text style={styles.purificationSubtitle}>{t('purificationSubtitle')}</Text>

                    <TouchableOpacity style={styles.purifyOption} onPress={handleCleanEssence}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.purifyOptionTitle}>{t('cleanEssence')}</Text>
                            <Text style={styles.purifyOptionDesc}>{t('cleanEssenceDesc')}</Text>
                        </View>
                        <Text style={styles.purifyArrow}>›</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.purifyOption} onPress={handlePurgeOldRelics}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.purifyOptionTitle}>{t('purgeOldRelics')}</Text>
                            <Text style={styles.purifyOptionDesc}>{t('purgeOldRelicsDesc')}</Text>
                        </View>
                        <Text style={styles.purifyArrow}>›</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={[styles.purifyOption, styles.purifyOptionDanger]} onPress={handleResetTotal}>
                        <View style={{ flex: 1 }}>
                            <Text style={[styles.purifyOptionTitle, styles.purifyDangerText]}>{t('resetTotal')}</Text>
                            <Text style={[styles.purifyOptionDesc, styles.purifyDangerText]}>{t('resetTotalDesc')}</Text>
                        </View>
                        <Text style={[styles.purifyArrow, styles.purifyDangerText]}>›</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>

            {/* Text Content Modal */}
            <Modal
                visible={textModal.visible}
                transparent
                animationType="slide"
                onRequestClose={() => setTextModal({ visible: false, content: '' })}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>{t('textViewerTitle')}</Text>
                            <TouchableOpacity onPress={() => setTextModal({ visible: false, content: '' })}>
                                <Text style={styles.modalClose}>{t('close')}</Text>
                            </TouchableOpacity>
                        </View>
                        <ScrollView style={styles.modalScroll}>
                            <Text style={styles.modalBody} selectable>{textModal.content}</Text>
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    backBtn: {
        width: 32,
        alignItems: 'center',
    },
    backText: {
        fontSize: 28,
        color: colors.primary,
        lineHeight: 32,
    },
    headerCenter: {
        flex: 1,
        alignItems: 'center',
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: colors.onBackground,
    },
    headerSubtitle: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginTop: 1,
        maxWidth: 200,
    },
    scroll: {
        flex: 1,
    },
    section: {
        margin: spacing.md,
        marginBottom: 0,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.onSurfaceVariant,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: spacing.sm,
    },
    filterRow: {
        marginBottom: spacing.sm,
    },
    filterPill: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: borderRadius.full,
        backgroundColor: colors.surfaceVariant,
        marginRight: 6,
    },
    filterPillActive: {
        backgroundColor: colors.primary,
    },
    filterPillText: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    filterPillTextActive: {
        color: '#fff',
        fontWeight: '600',
    },
    emptyText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        textAlign: 'center',
        paddingVertical: spacing.md,
        fontStyle: 'italic',
    },
    relicCard: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        marginBottom: spacing.sm,
    },
    relicHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    relicEmoji: {
        fontSize: 20,
        marginRight: spacing.sm,
    },
    relicInfo: {
        flex: 1,
    },
    relicName: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.onBackground,
    },
    relicDate: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        marginTop: 1,
    },
    activeBadge: {
        backgroundColor: colors.success,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: borderRadius.full,
    },
    activeBadgeText: {
        fontSize: 10,
        color: '#fff',
        fontWeight: '700',
    },
    relicPreview: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
        marginBottom: 6,
        lineHeight: 16,
    },
    relicActionBtn: {
        alignSelf: 'flex-start',
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: borderRadius.sm,
        backgroundColor: colors.primaryContainer,
    },
    relicActionText: {
        fontSize: 12,
        color: colors.primary,
        fontWeight: '600',
    },
    storageItem: {
        marginBottom: spacing.sm,
        paddingBottom: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    storageKey: {
        fontSize: 12,
        fontWeight: '700',
        color: colors.secondary,
        marginBottom: 2,
    },
    indentLevel: {
        paddingLeft: 12,
        borderLeftWidth: 1,
        borderLeftColor: colors.surfaceVariant,
        marginTop: 2,
    },
    dimKey: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        fontStyle: 'italic',
    },
    valueRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 4,
    },
    valueText: {
        fontSize: 12,
        color: colors.onBackground,
        flex: 1,
    },
    badge: {
        backgroundColor: colors.primaryContainer,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: borderRadius.sm,
    },
    badgeText: {
        fontSize: 9,
        color: colors.primary,
        fontWeight: '600',
    },
    moreText: {
        fontSize: 11,
        color: colors.onSurfaceVariant,
        fontStyle: 'italic',
        marginTop: 2,
    },
    purificationSubtitle: {
        fontSize: 13,
        color: colors.onSurfaceVariant,
        marginBottom: spacing.sm,
    },
    purifyOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    purifyOptionDanger: {
        borderBottomWidth: 0,
    },
    purifyOptionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.onBackground,
        marginBottom: 2,
    },
    purifyOptionDesc: {
        fontSize: 12,
        color: colors.onSurfaceVariant,
    },
    purifyDangerText: {
        color: colors.error,
    },
    purifyArrow: {
        fontSize: 20,
        color: colors.onSurfaceVariant,
        marginLeft: spacing.sm,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        maxHeight: '80%',
        minHeight: 200,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.onBackground,
    },
    modalClose: {
        fontSize: 14,
        color: colors.primary,
        fontWeight: '600',
    },
    modalScroll: {
        padding: spacing.md,
    },
    modalBody: {
        fontSize: 13,
        color: colors.onBackground,
        lineHeight: 20,
    },
});
