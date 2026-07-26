/**
 * ModelUnavailableModal — surfaced when an AI call fails because the
 * user-chosen model has been discontinued by OpenRouter. Offers two paths:
 *   1. "Choose another" → open Settings/OpenRouter with a query param so the
 *      picker for the affected task auto-opens.
 *   2. "Use default" → clear the preference (falls back to `MODELS[task]`)
 *      and bump aiKeyVersion so any listener retries.
 */

import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useBridgeUIStore } from '../lib/bridgeUIStore';
import { useAppStore } from '../lib/store';
import { clearPreferredModel } from '../lib/api/modelPreferences';
import { TASK_LABEL_KEYS } from '../lib/api/modelCatalog';
import { colors, spacing, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

export function ModelUnavailableModal() {
    const router = useRouter();
    const request = useBridgeUIStore(s => s.modelUnavailableRequest);
    const dismissModelUnavailable = useBridgeUIStore(s => s.dismissModelUnavailable);
    const bumpAiKeyVersion = useAppStore(s => s.bumpAiKeyVersion);
    const refreshMissingModelTasks = useAppStore(s => s.refreshMissingModelTasks);

    if (!request) return null;

    const { taskKey, modelId } = request;
    const taskLabel = t(TASK_LABEL_KEYS[taskKey]);

    const handleChooseAnother = () => {
        dismissModelUnavailable();
        router.push({ pathname: '/settings/openrouter', params: { openPicker: taskKey } });
    };

    const handleUseDefault = async () => {
        dismissModelUnavailable();
        await clearPreferredModel(taskKey);
        await refreshMissingModelTasks();
        bumpAiKeyVersion();
    };

    const body = t('openrouterModelUnavailableBody')
        .replace('{modelId}', modelId)
        .replace('{task}', taskLabel);

    return (
        <Modal visible={true} transparent animationType="fade" onRequestClose={dismissModelUnavailable}>
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>
                        ⚠️  {t('openrouterModelUnavailableTitle')}
                    </Text>
                    <Text style={styles.message}>{body}</Text>
                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={handleUseDefault}>
                            <Text style={styles.secondaryText}>
                                {t('openrouterModelUnavailableUseDefault')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.primaryBtn} onPress={handleChooseAnother}>
                            <Text style={styles.primaryText}>
                                {t('openrouterModelUnavailableChooseAnother')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
    },
    dialog: {
        width: '100%',
        maxWidth: 400,
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.lg,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    message: {
        fontSize: 14,
        color: colors.onSurfaceVariant,
        lineHeight: 20,
        marginBottom: spacing.lg,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
    },
    secondaryBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
    },
    secondaryText: {
        color: colors.onSurfaceVariant,
        fontSize: 15,
    },
    primaryBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.primary,
        borderRadius: borderRadius.md,
    },
    primaryText: {
        color: colors.onPrimary,
        fontSize: 15,
        fontWeight: '600',
    },
});
