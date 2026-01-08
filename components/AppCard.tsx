import React from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Image,
} from 'react-native';
import { GeneratedApp } from '../lib/database/types';
import { colors, borderRadius, spacing } from '../lib/theme';

interface AppCardProps {
    app: GeneratedApp;
    onRun: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRename: () => void;
    onIconPress?: () => void;
    onShortcut?: () => void;
}

export function AppCard({ app, onRun, onEdit, onDelete, onRename, onIconPress, onShortcut }: AppCardProps) {
    const formattedDate = new Date(app.lastUpdated).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    return (
        <View style={styles.card}>
            <TouchableOpacity style={styles.iconContainer} onPress={onIconPress || onRename}>
                {app.iconPath ? (
                    <Image source={{ uri: app.iconPath }} style={styles.icon} />
                ) : (
                    <Text style={styles.iconText}>
                        {app.name.slice(0, 2).toUpperCase()}
                    </Text>
                )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.info} onPress={onRename}>
                <Text style={styles.name} numberOfLines={1}>
                    {app.name}
                </Text>
                <Text style={styles.meta}>
                    v{app.currentVersion} • {formattedDate}
                </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionBtn} onPress={onRun}>
                <Text style={styles.actionIcon}>▶️</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={onEdit}>
                <Text style={styles.actionIcon}>✏️</Text>
            </TouchableOpacity>
            {onShortcut && (
                <TouchableOpacity style={styles.actionBtn} onPress={onShortcut}>
                    <Text style={styles.actionIcon}>📌</Text>
                </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.actionBtn} onPress={onDelete}>
                <Text style={[styles.actionIcon, { opacity: 0.7 }]}>🗑️</Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },
    iconContainer: {
        width: 48,
        height: 48,
        borderRadius: borderRadius.md,
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
    },
    icon: {
        width: 48,
        height: 48,
    },
    iconText: {
        color: colors.onPrimaryContainer,
        fontSize: 16,
        fontWeight: '600',
    },
    info: {
        flex: 1,
        marginLeft: spacing.sm,
    },
    name: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '600',
    },
    meta: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 2,
    },
    actions: {
        flexDirection: 'row',
        gap: 4,
    },
    actionBtn: {
        padding: spacing.sm,
    },
    actionIcon: {
        fontSize: 20,
    },
});
