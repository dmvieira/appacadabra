import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Modal,
    StyleSheet,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { colors, spacing, borderRadius } from '../lib/theme';
import { useSpeechToText } from '../lib/useSpeech';
import { t } from '../lib/i18n';

interface ChatDialogProps {
    visible: boolean;
    title: string;
    isGenerating: boolean;
    onDismiss: () => void;
    onSend: (text: string) => Promise<boolean | void> | void;
}

export function ChatDialog({ visible, title, isGenerating, onDismiss, onSend }: ChatDialogProps) {
    const [text, setText] = useState('');
    const [textBeforeSpeech, setTextBeforeSpeech] = useState('');
    const { isListening, transcript, startListening, stopListening } = useSpeechToText();

    // Update text when speech recognition gives results (replace, not append)
    useEffect(() => {
        if (transcript && isListening) {
            // Replace with base text + new transcript (not accumulate)
            setText(textBeforeSpeech + (textBeforeSpeech ? ' ' : '') + transcript);
        }
    }, [transcript, isListening, textBeforeSpeech]);

    // Reset text when dialog closes
    useEffect(() => {
        if (!visible) {
            setText('');
        }
    }, [visible]);

    const handleSend = async () => {
        if (text.trim() && !isGenerating) {
            const result = await onSend(text.trim());
            // Clear text only if result is explicitly true or undefined (void), 
            // but if it returns false (error), keep text.
            if (result !== false) {
                setText('');
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
                                style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
                                onPress={handleSend}
                                disabled={!text.trim()}
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
            animationType="fade"
            onRequestClose={onDismiss}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.overlay}
                keyboardVerticalOffset={0}
            >
                <View style={[styles.dialog, { maxHeight: '80%' }]}>
                    <Text style={styles.title}>{t('editAppDetails')}</Text>

                    <Text style={styles.label}>{t('spellNameLabel')}</Text>
                    <TextInput
                        style={styles.singleInput}
                        value={name}
                        onChangeText={setName}
                        placeholder={t('appNamePlaceholder')}
                        placeholderTextColor={colors.onSurfaceVariant}
                    />

                    <Text style={[styles.label, { marginTop: spacing.md }]}>{t('shortDescriptionLabel')}</Text>
                    <TextInput
                        style={[styles.input, { minHeight: 80, height: 100 }]}
                        value={description}
                        onChangeText={setDescription}
                        placeholder={t('createPlaceholder')}
                        placeholderTextColor={colors.onSurfaceVariant}
                        multiline
                        textAlignVertical="top"
                    />

                    <View style={styles.buttons}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss}>
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.sendBtn} onPress={handleConfirm}>
                            <Text style={styles.sendText}>{t('save')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

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
