/**
 * Shared WebView message handlers
 * 
 * This module provides a unified handler for WebView bridge messages,
 * reducing code duplication across [id].tsx, RunnerApp.tsx, and AppRunner.tsx
 */

import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Contacts from 'expo-contacts';
import * as LocalAuthentication from 'expo-local-authentication';
import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { WebView } from 'react-native-webview';
import * as ai from '../api/ai';

import * as db from '../database/db';
import { createCallbackScript } from './injectedJS';
import { t } from '../i18n';
import { useManaStore } from '../manaStore';

export interface HandlerContext {
    webViewRef: React.RefObject<WebView>;
    appId: number | null;
}

export interface HandlerResult {
    success: boolean;
    result: string;
    handled: boolean;  // false if message type was not recognized
}

/**
 * Handle a WebView bridge message.
 * Returns { handled: false } if the message type is not recognized,
 * allowing the caller to handle it locally.
 */
export async function handleBridgeMessage(
    type: string,
    data: any,
    ctx: HandlerContext
): Promise<HandlerResult> {
    let success = true;
    let result = '';

    switch (type) {
        // ============= AI Handler =============
        case 'AI_GENERATE':
            try {
                // Mana check is handled by server now, but we could add a check if we fetched balance
                // For now, let's trust the server response or generic error

                const genResult = await ai.aiGenerate({
                    prompt: data.prompt,
                    search: data.search,
                    schema: data.schema,
                    image: data.image,
                    audio: data.audio,
                });
                result = genResult.text;

                // Log cost (optional)
                console.log(`[Bridge] AI generated. Usage:`, genResult.usage);

                // Update App Total Mana Cost if we have appId
                // Assuming we can get cost from usage if server provides it in response
                if (ctx.appId) {
                    // Similar to [id].tsx, we might skip this update if we don't have exact cost
                    // or rely on server to update the app record if possible (but server func usually doesn't update app doc unless specified)
                    // We will leave this as is for now, maybe just skipping cost update locally
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Calendar Handlers =============
        case 'CALENDAR_CREATE_EVENT':
        case 'CALENDAR_CREATE_EVENT_REMINDER':
            try {
                const startMs = data.startTimeMs;
                const endMs = data.endTimeMs;
                const eventTitle = encodeURIComponent(data.title || t('newEvent'));
                const eventDesc = encodeURIComponent(data.description || '');

                const startDate = new Date(startMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
                const endDate = new Date(endMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

                const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${eventTitle}&details=${eventDesc}&dates=${startDate}/${endDate}`;
                await Linking.openURL(googleCalUrl);
                result = 'Calendar opened';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'CALENDAR_HAS_PERMISSION':
            const calPerm = await Calendar.getCalendarPermissionsAsync();
            result = (calPerm.status === 'granted').toString();
            break;

        case 'CALENDAR_REQUEST_PERMISSION':
            await Calendar.requestCalendarPermissionsAsync();
            break;

        // ============= Notification Handlers =============
        case 'NOTIFY_SHOW_NOW':
            try {
                const showNowPerm = await Notifications.getPermissionsAsync();
                if (showNowPerm.status !== 'granted') {
                    const { status } = await Notifications.requestPermissionsAsync();
                    if (status !== 'granted') {
                        success = false;
                        result = 'Notification permission denied';
                        break;
                    }
                }

                await Notifications.scheduleNotificationAsync({
                    content: { title: data.title, body: data.message },
                    trigger: null,
                });
                result = 'Notification sent';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_SCHEDULE':
            try {
                const schedulePerm = await Notifications.getPermissionsAsync();
                if (schedulePerm.status !== 'granted') {
                    const { status } = await Notifications.requestPermissionsAsync();
                    if (status !== 'granted') {
                        success = false;
                        result = 'Notification permission denied';
                        break;
                    }
                }

                const identifier = await Notifications.scheduleNotificationAsync({
                    content: { title: data.title, body: data.message },
                    trigger: {
                        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                        seconds: data.delayMinutes * 60,
                    },
                });
                result = identifier;
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_SCHEDULE_AT':
            try {
                const scheduleAtPerm = await Notifications.getPermissionsAsync();
                if (scheduleAtPerm.status !== 'granted') {
                    const { status } = await Notifications.requestPermissionsAsync();
                    if (status !== 'granted') {
                        success = false;
                        result = 'Notification permission denied';
                        break;
                    }
                }

                const identifierAt = await Notifications.scheduleNotificationAsync({
                    content: { title: data.title, body: data.message },
                    trigger: {
                        type: Notifications.SchedulableTriggerInputTypes.DATE,
                        date: new Date(data.timeMs),
                    },
                });
                result = identifierAt;
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_HAS_PERMISSION':
            const notifPerm = await Notifications.getPermissionsAsync();
            result = (notifPerm.status === 'granted').toString();
            break;

        case 'NOTIFY_REQUEST_PERMISSION':
            await Notifications.requestPermissionsAsync();
            break;

        // ============= Storage Handlers =============
        case 'STORAGE_SET':
            if (ctx.appId) {
                await db.setStorageItem(ctx.appId, data.key, data.value);
            }
            break;

        case 'STORAGE_REMOVE':
            if (ctx.appId) {
                await db.removeStorageItem(ctx.appId, data.key);
            }
            break;

        case 'STORAGE_CLEAR':
            if (ctx.appId) {
                await db.clearStorageForApp(ctx.appId);
            }
            break;

        // ============= Location Handler =============
        case 'LOCATION_GET_CURRENT_POSITION':
            try {
                const locStatus = await Location.requestForegroundPermissionsAsync();
                if (locStatus.status === 'granted') {
                    const loc = await Location.getCurrentPositionAsync({});
                    result = JSON.stringify(loc);
                } else {
                    result = 'Permission denied';
                    success = false;
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Share Handlers =============
        case 'SHARE_CONTENT':
            try {
                if (await Sharing.isAvailableAsync()) {
                    const content = data.text || data.url || '';
                    const tempPath = FileSystem.cacheDirectory + 'share_temp.txt';
                    await FileSystem.writeAsStringAsync(tempPath, content);
                    await Sharing.shareAsync(tempPath, { mimeType: 'text/plain' });
                    result = 'Shared';
                } else {
                    if (data.url) {
                        await Linking.openURL(`mailto:?body=${encodeURIComponent(data.text || '')} ${data.url}`);
                    }
                    result = 'Shared via fallback';
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SHARE_FILE':
            try {
                if (await Sharing.isAvailableAsync()) {
                    const tempPath = FileSystem.cacheDirectory + (data.filename || 'shared_file');
                    await FileSystem.writeAsStringAsync(tempPath, data.base64, { encoding: FileSystem.EncodingType.Base64 });
                    await Sharing.shareAsync(tempPath, { mimeType: data.mimeType || 'application/octet-stream' });
                    result = 'File shared';
                } else {
                    success = false;
                    result = 'Sharing not available';
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Contacts Handlers =============


        case 'CONTACTS_SEARCH':
            try {
                const searchPerm = await Contacts.requestPermissionsAsync();
                if (searchPerm.status === 'granted') {
                    const { data: allContacts } = await Contacts.getContactsAsync({
                        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
                    });
                    const query = (data.query || '').toLowerCase();
                    const filtered = allContacts.filter(c =>
                        c.name?.toLowerCase().includes(query) ||
                        c.phoneNumbers?.some(p => p.number?.includes(query)) ||
                        c.emails?.some(e => e.email?.toLowerCase().includes(query))
                    );
                    result = JSON.stringify(filtered.slice(0, 50));
                } else {
                    success = false;
                    result = 'Contacts permission denied';
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'CONTACTS_ADD':
            try {
                const addPerm = await Contacts.requestPermissionsAsync();
                if (addPerm.status === 'granted') {
                    const contact = data.contact || {};

                    // Build contact object for native form with proper field mapping
                    const newContact: Partial<Contacts.Contact> = {
                        contactType: Contacts.ContactTypes.Person,
                        name: String(contact.name || ''),
                        firstName: String(contact.firstName || contact.name?.split(' ')[0] || ''),
                        lastName: String(contact.lastName || contact.name?.split(' ').slice(1).join(' ') || ''),
                    };

                    // Add phone if provided
                    if (contact.phone) {
                        newContact.phoneNumbers = [{ number: String(contact.phone), label: 'mobile' }];
                    }

                    // Add email if provided
                    if (contact.email) {
                        newContact.emails = [{ email: String(contact.email), label: 'work' }];
                    }

                    // Add company/work fields if provided
                    if (contact.company) newContact.company = String(contact.company);
                    if (contact.jobTitle) newContact.jobTitle = String(contact.jobTitle);
                    if (contact.department) newContact.department = String(contact.department);

                    // Add nickname if provided
                    if (contact.nickname) newContact.nickname = String(contact.nickname);

                    // Add note if provided
                    if (contact.note) newContact.note = String(contact.note);

                    // Add address if provided (can be object or string)
                    if (contact.address) {
                        if (typeof contact.address === 'string') {
                            newContact.addresses = [{ street: String(contact.address), label: 'home' }];
                        } else if (typeof contact.address === 'object') {
                            newContact.addresses = [{
                                street: String(contact.address.street || ''),
                                city: String(contact.address.city || ''),
                                region: String(contact.address.region || contact.address.state || ''),
                                postalCode: String(contact.address.postalCode || contact.address.zipCode || ''),
                                country: String(contact.address.country || ''),
                                label: String(contact.address.label || 'home')
                            }];
                        }
                    }

                    // Add birthday if provided (expects { day, month, year } or "YYYY-MM-DD" string)
                    if (contact.birthday) {
                        if (typeof contact.birthday === 'string') {
                            const parts = contact.birthday.split('-');
                            if (parts.length >= 3) {
                                newContact.birthday = {
                                    year: parseInt(parts[0], 10),
                                    month: parseInt(parts[1], 10) - 1, // JS months are 0-indexed
                                    day: parseInt(parts[2], 10)
                                };
                            }
                        } else if (typeof contact.birthday === 'object') {
                            newContact.birthday = {
                                year: contact.birthday.year,
                                month: contact.birthday.month,
                                day: contact.birthday.day
                            };
                        }
                    }

                    // Add website/URL if provided
                    if (contact.website || contact.url) {
                        newContact.urlAddresses = [{
                            url: String(contact.website || contact.url),
                            label: 'homepage'
                        }];
                    }

                    // Use presentFormAsync to open native add contact form
                    // This is more reliable than addContactAsync on Android
                    await Contacts.presentFormAsync(null, newContact as Contacts.Contact, { isNew: true });
                    result = 'Contact form presented';
                } else {
                    success = false;
                    result = 'Contacts permission denied';
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'CONTACTS_UPDATE':
            try {
                const updatePerm = await Contacts.requestPermissionsAsync();
                if (updatePerm.status === 'granted') {
                    const contactData = data.contact || {};

                    if (!contactData.id) {
                        throw new Error('Contact ID is required for update');
                    }

                    // Build update payload with properly typed fields
                    const updatePayload: Record<string, any> = {
                        id: String(contactData.id)
                    };

                    // Parse name if needed
                    if (contactData.name) {
                        updatePayload.firstName = String(contactData.name.split(' ')[0] || '');
                        if (contactData.name.includes(' ')) {
                            updatePayload.lastName = String(contactData.name.split(' ').slice(1).join(' '));
                        }
                    }
                    if (contactData.firstName) updatePayload.firstName = String(contactData.firstName);
                    if (contactData.lastName) updatePayload.lastName = String(contactData.lastName);
                    if (contactData.company) updatePayload.company = String(contactData.company);
                    if (contactData.jobTitle) updatePayload.jobTitle = String(contactData.jobTitle);
                    if (contactData.department) updatePayload.department = String(contactData.department);
                    if (contactData.nickname) updatePayload.nickname = String(contactData.nickname);
                    if (contactData.note) updatePayload.note = String(contactData.note);

                    // Phone numbers
                    if (contactData.phone) {
                        updatePayload.phoneNumbers = [{ number: String(contactData.phone), label: 'mobile' }];
                    }

                    // Emails
                    if (contactData.email) {
                        updatePayload.emails = [{ email: String(contactData.email), label: 'work' }];
                    }

                    // Try updateContactAsync first (works on some devices)
                    try {
                        const resultId = await Contacts.updateContactAsync(updatePayload as any);
                        result = resultId;
                    } catch (updateError: any) {
                        // Fallback: copy data to clipboard and open native editor
                        // See: https://github.com/expo/expo/issues/36802
                        // Fallback to native editor with clipboard support

                        // Build clipboard text with ALL contact info for easy pasting
                        const clipboardParts: string[] = [];

                        // Name parts
                        const fullName = [updatePayload.firstName, updatePayload.lastName].filter(Boolean).join(' ');
                        if (fullName) clipboardParts.push(`Nome: ${fullName}`);

                        // Contact info
                        if (contactData.phone) clipboardParts.push(`Tel: ${contactData.phone}`);
                        if (contactData.email) clipboardParts.push(`Email: ${contactData.email}`);

                        // Work info
                        if (contactData.company) clipboardParts.push(`Empresa: ${contactData.company}`);
                        if (contactData.jobTitle) clipboardParts.push(`Cargo: ${contactData.jobTitle}`);
                        if (contactData.department) clipboardParts.push(`Departamento: ${contactData.department}`);

                        // Address - check both contactData.address and updatePayload.addresses
                        if (contactData.address) {
                            let addrStr: string;
                            if (typeof contactData.address === 'string') {
                                addrStr = contactData.address;
                            } else {
                                const a = contactData.address;
                                addrStr = [a.street, a.city, a.region, a.state, a.postalCode, a.zipCode, a.country]
                                    .filter(Boolean).join(', ');
                            }
                            if (addrStr) clipboardParts.push(`Endereço: ${addrStr}`);
                        }

                        // Other fields
                        if (contactData.birthday) {
                            const bd = typeof contactData.birthday === 'string'
                                ? contactData.birthday
                                : `${contactData.birthday.day}/${contactData.birthday.month}/${contactData.birthday.year}`;
                            clipboardParts.push(`Nascimento: ${bd}`);
                        }
                        if (contactData.website || contactData.url) {
                            clipboardParts.push(`Website: ${contactData.website || contactData.url}`);
                        }
                        if (contactData.nickname) clipboardParts.push(`Apelido: ${contactData.nickname}`);
                        if (contactData.note) clipboardParts.push(`Nota: ${contactData.note}`);

                        // Copy to clipboard FIRST (before any focus change)
                        const clipboardText = clipboardParts.join('\n');

                        const { Clipboard, Alert } = require('react-native');
                        if (clipboardText) {
                            Clipboard.setString(clipboardText);
                        }

                        // Show alert and wait for user to tap OK before opening editor
                        await new Promise<void>((resolve) => {
                            Alert.alert(
                                'Dados copiados',
                                clipboardText
                                    ? 'As informações do contato foram copiadas para a área de transferência. Cole nos campos desejados.'
                                    : 'Edite o contato na tela seguinte.',
                                [{ text: 'OK', onPress: () => resolve() }]
                            );
                        });

                        // Open native editor
                        await Contacts.presentFormAsync(String(contactData.id), null, { allowsEditing: true });
                        result = contactData.id;
                    }
                } else {
                    success = false;
                    result = 'Contacts permission denied';
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Auth Handlers =============


        case 'AUTH_AUTHENTICATE':
            try {
                // Check availability internally
                const hasHardware = await LocalAuthentication.hasHardwareAsync();
                const isEnrolled = await LocalAuthentication.isEnrolledAsync();

                if (!hasHardware || !isEnrolled) {
                    throw new Error(t('biometricsNotAvailable') || 'Biometric authentication not available');
                }

                const authResult = await LocalAuthentication.authenticateAsync({
                    promptMessage: data.reason || t('confirmIdentity'),
                    fallbackLabel: t('usePassword'),
                    disableDeviceFallback: false,
                });
                result = JSON.stringify(authResult);
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;



        // ============= Sensors Handlers =============
        case 'SENSORS_START_ACCELEROMETER':
            try {
                Accelerometer.setUpdateInterval(data.intervalMs || 100);
                Accelerometer.addListener(sensorData => {
                    if (ctx.webViewRef.current && data.callbackName) {
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = 'Accelerometer started';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_START_GYROSCOPE':
            try {
                Gyroscope.setUpdateInterval(data.intervalMs || 100);
                Gyroscope.addListener(sensorData => {
                    if (ctx.webViewRef.current && data.callbackName) {
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = 'Gyroscope started';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_START_MAGNETOMETER':
            try {
                Magnetometer.setUpdateInterval(data.intervalMs || 100);
                Magnetometer.addListener(sensorData => {
                    if (ctx.webViewRef.current && data.callbackName) {
                        const { x, y } = sensorData;
                        let heading = Math.atan2(y, x) * (180 / Math.PI);
                        if (heading < 0) heading += 360;
                        const dataWithHeading = { ...sensorData, heading };
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(dataWithHeading));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = 'Magnetometer started';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_STOP_ACCELEROMETER':
            Accelerometer.removeAllListeners();
            result = 'Accelerometer stopped';
            break;

        case 'SENSORS_STOP_GYROSCOPE':
            Gyroscope.removeAllListeners();
            result = 'Gyroscope stopped';
            break;

        case 'SENSORS_STOP_MAGNETOMETER':
            Magnetometer.removeAllListeners();
            result = 'Magnetometer stopped';
            break;

        case 'SENSORS_STOP_ALL':
            Accelerometer.removeAllListeners();
            Gyroscope.removeAllListeners();
            Magnetometer.removeAllListeners();
            result = 'All sensors stopped';
            break;

        default:
            // Message type not handled by shared module
            return { success: false, result: '', handled: false };
    }

    return { success, result, handled: true };
}
