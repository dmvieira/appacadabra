import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Pressable,
    Modal,
    StyleSheet,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    FlatList,
} from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSpeechToText } from '../lib/useSpeech';
import { t } from '../lib/i18n';

interface ChatDialogProps {
    visible: boolean;
    title: string;
    isGenerating: boolean;
    onDismiss: () => void;
    onSend: (text: string) => Promise<boolean | void> | void;
    initialText?: string;
}

export function ChatDialog({ visible, title, isGenerating, onDismiss, onSend, initialText }: ChatDialogProps) {
    const [text, setText] = useState('');
    const [textBeforeSpeech, setTextBeforeSpeech] = useState('');
    const [isSending, setIsSending] = useState(false);
    const { isListening, transcript, startListening, stopListening } = useSpeechToText();

    // Update text when speech recognition gives results (replace, not append)
    useEffect(() => {
        if (transcript && isListening) {
            // Replace with base text + new transcript (not accumulate)
            setText(textBeforeSpeech + (textBeforeSpeech ? ' ' : '') + transcript);
        }
    }, [transcript, isListening, textBeforeSpeech]);

    // Reset text when dialog closes; pre-fill with initialText when opening
    useEffect(() => {
        if (!visible) {
            setText('');
        } else if (initialText) {
            setText(initialText);
        }
    }, [visible]);

    const handleSend = async () => {
        if (text.trim() && !isGenerating && !isSending) {
            setIsSending(true);
            try {
                const result = await onSend(text.trim());
                // Clear text only if result is explicitly true or undefined (void),
                // but if it returns false (error), keep text.
                if (result !== false) {
                    setText('');
                }
            } finally {
                setIsSending(false);
            }
        }
    };

    const toggleListening = () => {
        if (isListening) {
            stopListening();
        } else {
            // Save current text before starting speech
            setTextBeforeSpeech(text);
            startListening();
        }
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onDismiss}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.overlay}
                keyboardVerticalOffset={0}
            >
                <View style={styles.dialog}>
                    <Text style={styles.title}>{title}</Text>

                    {isGenerating ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={colors.primary} />
                            <Text style={styles.loadingText}>{t('creatingMagic')}</Text>
                        </View>
                    ) : (
                        <>
                            <View style={styles.inputContainer}>
                                <TextInput
                                    style={styles.input}
                                    value={text}
                                    onChangeText={setText}
                                    placeholder={t('describeRequirements')}
                                    placeholderTextColor={colors.onSurfaceVariant}
                                    multiline
                                    numberOfLines={4}
                                    textAlignVertical="top"
                                />
                                <TouchableOpacity
                                    style={[
                                        styles.micBtn,
                                        isListening && styles.micBtnActive
                                    ]}
                                    onPress={toggleListening}
                                >
                                    <Text style={styles.micIcon}>{isListening ? '🔴' : '🎤'}</Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.hint}>
                                {isListening
                                    ? t('listeningTap')
                                    : t('describeOrMic')
                                }
                            </Text>
                        </>
                    )}

                    <View style={styles.buttons}>
                        {!isGenerating && (
                            <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss}>
                                <Text style={styles.cancelText}>{t('cancel')}</Text>
                            </TouchableOpacity>
                        )}
                        {!isGenerating && (
                            <TouchableOpacity
                                style={[styles.sendBtn, (!text.trim() || isSending) && styles.sendBtnDisabled]}
                                onPress={handleSend}
                                disabled={!text.trim() || isSending}
                            >
                                <Text style={styles.sendText}>{t('send')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

interface EditDetailsDialogProps {
    visible: boolean;
    currentName: string;
    currentDescription?: string;
    onDismiss: () => void;
    onConfirm: (newName: string, newDescription: string) => void;
}

export function EditDetailsDialog({ visible, currentName, currentDescription, onDismiss, onConfirm }: EditDetailsDialogProps) {
    const insets = useSafeAreaInsets();
    const [name, setName] = useState(currentName);
    const [description, setDescription] = useState(currentDescription || '');

    React.useEffect(() => {
        if (visible) {
            setName(currentName);
            setDescription(currentDescription || '');
        }
    }, [currentName, currentDescription, visible]);

    const handleConfirm = () => {
        if (name.trim()) {
            onConfirm(name.trim(), description.trim());
        }
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={onDismiss}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={{ flex: 1 }}
            >
                <Pressable style={editStyles.overlay} onPress={onDismiss}>
                    <Pressable style={[editStyles.sheet, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
                        <View style={editStyles.handle} />

                        {/* Header */}
                        <View style={editStyles.header}>
                            <View style={editStyles.headerIcon}>
                                <Text style={{ fontSize: 20 }}>✏️</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={editStyles.headerTitle}>{t('editAppDetails')}</Text>
                            </View>
                            <TouchableOpacity style={editStyles.closeBtn} onPress={onDismiss}>
                                <Text style={editStyles.closeBtnText}>✕</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Body */}
                        <ScrollView style={editStyles.body} keyboardShouldPersistTaps="handled">
                            <Text style={editStyles.label}>{t('spellNameLabel')}</Text>
                            <TextInput
                                style={editStyles.input}
                                value={name}
                                onChangeText={setName}
                                placeholder={t('appNamePlaceholder')}
                                placeholderTextColor="#6B7280"
                            />

                            <Text style={[editStyles.label, { marginTop: 16 }]}>{t('shortDescriptionLabel')}</Text>
                            <TextInput
                                style={[editStyles.input, { minHeight: 80, textAlignVertical: 'top' }]}
                                value={description}
                                onChangeText={setDescription}
                                placeholder={t('createPlaceholder')}
                                placeholderTextColor="#6B7280"
                                multiline
                            />

                            <View style={editStyles.buttons}>
                                <TouchableOpacity style={editStyles.cancelBtn} onPress={onDismiss}>
                                    <Text style={editStyles.cancelText}>{t('cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={editStyles.saveBtn} onPress={handleConfirm}>
                                    <Text style={editStyles.saveText}>{t('save')}</Text>
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const editStyles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.55)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: '#111827',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: '#374151',
        borderRadius: 2,
        alignSelf: 'center',
        marginTop: 12,
        marginBottom: 20,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#1F2937',
    },
    headerIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
    },
    headerTitle: {
        color: '#F9FAFB',
        fontSize: 15,
        fontWeight: '800',
    },
    closeBtn: {
        marginLeft: 'auto',
        width: 32,
        height: 32,
        borderRadius: 99,
        backgroundColor: '#1F2937',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeBtnText: {
        color: '#9CA3AF',
        fontSize: 16,
    },
    body: {
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    label: {
        color: '#9CA3AF',
        fontSize: 13,
        fontWeight: '700',
        marginBottom: 8,
    },
    input: {
        backgroundColor: '#0D0D1A',
        borderWidth: 1,
        borderColor: '#1F2937',
        borderRadius: 14,
        padding: 14,
        color: '#F9FAFB',
        fontSize: 15,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
        marginTop: 24,
    },
    cancelBtn: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#1F2937',
    },
    cancelText: {
        color: '#9CA3AF',
        fontSize: 14,
        fontWeight: '700',
    },
    saveBtn: {
        paddingVertical: 10,
        paddingHorizontal: 24,
        borderRadius: 12,
        backgroundColor: '#7C3AED',
    },
    saveText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '800',
    },
});

interface ConfirmDialogProps {
    visible: boolean;
    title: string;
    message: string;
    confirmText?: string;
    onDismiss: () => void;
    onConfirm: () => void;
}

export function ConfirmDialog({
    visible,
    title,
    message,
    confirmText = t('confirm'),
    onDismiss,
    onConfirm
}: ConfirmDialogProps) {
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onDismiss}
        >
            <View style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>{title}</Text>
                    <Text style={styles.message}>{message}</Text>

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss}>
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.dangerBtn} onPress={onConfirm}>
                            <Text style={styles.dangerText}>{confirmText}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

interface BugReportApp { id: number; name: string; code: string; }

interface BugReportDialogProps {
    visible: boolean;
    apps: BugReportApp[];
    onDismiss: () => void;
    onSend: (comment: string, selectedApp: BugReportApp | null, includeStorage: boolean) => Promise<void>;
}

export function BugReportDialog({ visible, apps, onDismiss, onSend }: BugReportDialogProps) {
    const [comment, setComment] = useState('');
    const [selectedApp, setSelectedApp] = useState<BugReportApp | null>(null);
    const [includeStorage, setIncludeStorage] = useState(false);
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        if (!visible) {
            setComment('');
            setSelectedApp(null);
            setIncludeStorage(false);
            setIsSending(false);
        }
    }, [visible]);

    const handleSend = async () => {
        if (!comment.trim() || isSending) return;
        setIsSending(true);
        try {
            await onSend(comment.trim(), selectedApp, includeStorage);
            onDismiss();
        } finally {
            setIsSending(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
                <View style={styles.dialog}>
                    <Text style={styles.title}>{t('reportBugTitle')}</Text>

                    <TextInput
                        style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]}
                        value={comment}
                        onChangeText={setComment}
                        placeholder={t('reportBugPlaceholder')}
                        placeholderTextColor="#6B7280"
                        multiline
                        autoFocus
                    />

                    {apps.length > 0 && (
                        <View style={bugStyles.attachSection}>
                            <Text style={bugStyles.attachLabel}>{t('reportBugAttach')}</Text>
                            <FlatList
                                data={apps}
                                keyExtractor={a => String(a.id)}
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={{ gap: 8 }}
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={[bugStyles.chip, selectedApp?.id === item.id && bugStyles.chipSelected]}
                                        onPress={() => {
                                            const next = selectedApp?.id === item.id ? null : item;
                                            setSelectedApp(next);
                                            if (!next) setIncludeStorage(false);
                                        }}
                                    >
                                        <Text style={[bugStyles.chipText, selectedApp?.id === item.id && bugStyles.chipTextSelected]} numberOfLines={1}>
                                            {item.name}
                                        </Text>
                                    </TouchableOpacity>
                                )}
                            />
                            {selectedApp && (
                                <TouchableOpacity style={bugStyles.checkboxRow} onPress={() => setIncludeStorage(v => !v)}>
                                    <View style={[bugStyles.checkbox, includeStorage && bugStyles.checkboxChecked]}>
                                        {includeStorage && <Text style={bugStyles.checkmark}>✓</Text>}
                                    </View>
                                    <Text style={bugStyles.checkboxLabel}>{t('reportBugIncludeStorage')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss} disabled={isSending}>
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.sendBtn, (!comment.trim() || isSending) && styles.sendBtnDisabled]}
                            onPress={handleSend}
                            disabled={!comment.trim() || isSending}
                        >
                            <Text style={styles.sendText}>{isSending ? '...' : t('send')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const bugStyles = StyleSheet.create({
    attachSection: {
        marginTop: 12,
    },
    attachLabel: {
        color: '#9CA3AF',
        fontSize: 12,
        fontWeight: '600',
        marginBottom: 8,
    },
    chip: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#374151',
        backgroundColor: '#1F2937',
        maxWidth: 140,
    },
    chipSelected: {
        borderColor: '#7C3AED',
        backgroundColor: 'rgba(124,58,237,0.2)',
    },
    chipText: {
        color: '#9CA3AF',
        fontSize: 13,
    },
    chipTextSelected: {
        color: '#A78BFA',
        fontWeight: '600',
    },
    checkboxRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 10,
        gap: 8,
    },
    checkbox: {
        width: 18,
        height: 18,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: '#374151',
        backgroundColor: '#1F2937',
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkboxChecked: {
        borderColor: '#7C3AED',
        backgroundColor: 'rgba(124,58,237,0.3)',
    },
    checkmark: {
        color: '#A78BFA',
        fontSize: 12,
        lineHeight: 14,
    },
    checkboxLabel: {
        color: '#9CA3AF',
        fontSize: 13,
    },
});

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
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
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    inputContainer: {
        position: 'relative',
    },
    input: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        paddingEnd: 56, // Space for mic button
        color: colors.onSurface,
        fontSize: 16,
        minHeight: 120,
        borderWidth: 1,
        borderColor: colors.primary + '40',
    },
    micBtn: {
        position: 'absolute',
        right: spacing.sm,
        bottom: spacing.sm,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    micBtnActive: {
        backgroundColor: colors.error,
    },
    micIcon: {
        fontSize: 20,
    },
    singleInput: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        color: colors.onSurface,
        fontSize: 16,
        borderWidth: 1,
        borderColor: colors.primary + '40',
    },
    hint: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: spacing.sm,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
        marginTop: spacing.lg,
    },
    cancelBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
    },
    sendBtn: {
        backgroundColor: colors.primary,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
        borderRadius: borderRadius.md,
    },
    sendBtnDisabled: {
        opacity: 0.5,
    },
    sendText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: '600',
    },
    dangerBtn: {
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
    },
    dangerText: {
        color: colors.error,
        fontSize: 16,
        fontWeight: '600',
    },
    loadingContainer: {
        alignItems: 'center',
        paddingVertical: spacing.xl,
    },
    loadingText: {
        color: colors.onSurface,
        marginTop: spacing.md,
    },
    message: {
        color: colors.onSurface,
        fontSize: 16,
        marginBottom: spacing.md,
    },
    label: {
        fontSize: 14,
        fontWeight: 'bold',
        color: colors.onSurfaceVariant,
        marginBottom: spacing.xs,
    },
});
