import * as Calendar from 'expo-calendar';
import * as Linking from 'expo-linking';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

export const calendarCapability: CapabilityModule = {
    id: 'calendar',
    displayName: 'Calendar',
    minVersion: '1.0.0',
    description: "`createEvent` and `createEventWithReminder` add calendar events with optional alerts; `getEvents` fetches events in a date range with attendees; `deleteEvent` removes an event by ID.",
    androidPermissions: [
        'android.permission.READ_CALENDAR',
        'android.permission.WRITE_CALENDAR',
    ],

    docs: `📅 CALENDAR (AppacadabraCalendar)
- \`createEvent(title, desc, startMs, endMs, callback)\`
- \`createEventWithReminder(title, desc, startMs, endMs, minutes, callback)\`
- \`getEvents(startMs, endMs, callback)\` - Callback: \`callback(success, data)\`
    - **data** is an Array: \`[{id, title, startDate, endDate, allDay, location, notes, calendarId, calendarName, attendees: [{name, email, status, isCurrentUser}]}, ...]\`
- \`deleteEvent(eventId, callback)\`
    - **Return**: "Event deleted" (string)
- **Return for create**: "Calendar opened" (string)`,

    validationMock: `    window.AppacadabraCalendar = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraCalendar = {
    createEvent: function(title, description, startTimeMs, endTimeMs, callbackName) {
        console.log('[AppacadabraCalendar.createEvent] title:', title, 'callback:', callbackName);
        sendMessage('CALENDAR_CREATE_EVENT', { title, description, startTimeMs, endTimeMs }, callbackName);
    },
    createEventWithReminder: function(title, description, startTimeMs, endTimeMs, reminderMinutes, callbackName) {
        console.log('[AppacadabraCalendar.createEventWithReminder] title:', title, 'reminder:', reminderMinutes, 'min, callback:', callbackName);
        sendMessage('CALENDAR_CREATE_EVENT_REMINDER', { title, description, startTimeMs, endTimeMs, reminderMinutes }, callbackName);
    },
    getEvents: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraCalendar.getEvents] callback:', callbackName);
        sendMessage('CALENDAR_GET_EVENTS', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    deleteEvent: function(eventId, callbackName) {
        console.log('[AppacadabraCalendar.deleteEvent] eventId:', eventId, 'callback:', callbackName);
        sendMessage('CALENDAR_DELETE_EVENT', { eventId }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'CALENDAR_CREATE_EVENT':
            case 'CALENDAR_CREATE_EVENT_REMINDER': {
                console.log(`[Bridge] Calendar create event: ${data.title}`);
                try {
                    const startDate = new Date(data.startTimeMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
                    const endDate = new Date(data.endTimeMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
                    const eventTitle = encodeURIComponent(data.title || t('newEvent'));
                    const eventDesc = encodeURIComponent(data.description || '');
                    const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${eventTitle}&details=${eventDesc}&dates=${startDate}/${endDate}`;
                    await Linking.openURL(googleCalUrl);
                    return { success: true, result: 'Calendar opened' };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'CALENDAR_GET_EVENTS': {
                console.log('[Bridge] Calendar get events request');
                try {
                    const { status } = await Calendar.requestCalendarPermissionsAsync();
                    if (status !== 'granted') {
                        return { success: false, result: t('accessDenied') || 'Permission denied' };
                    }

                    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
                    const calendarIds = calendars.map(c => c.id);
                    const calendarMap = new Map(calendars.map(c => [c.id, c.title]));

                    if (calendarIds.length === 0) {
                        return { success: true, result: [] };
                    }

                    const startDate = data.startTimeMs ? new Date(data.startTimeMs) : new Date();
                    const endDate = data.endTimeMs ? new Date(data.endTimeMs) : new Date(Date.now() + 24 * 60 * 60 * 1000);
                    const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate);

                    const detailedEvents = await Promise.all(events.map(async (e) => {
                        let attendees: { name?: string; email?: string; status?: string; isCurrentUser?: boolean }[] = [];
                        try {
                            const raw = await Calendar.getAttendeesForEventAsync(e.id);
                            attendees = raw.map(a => ({ name: a.name, email: a.email, status: a.status, isCurrentUser: a.isCurrentUser }));
                        } catch { /* some events don't support attendees */ }
                        return {
                            id: e.id, title: e.title, startDate: e.startDate, endDate: e.endDate,
                            allDay: e.allDay, location: e.location, notes: e.notes,
                            calendarId: e.calendarId,
                            calendarName: calendarMap.get(e.calendarId) || 'Unknown',
                            attendees,
                        };
                    }));

                    console.log(`[Bridge] Found ${detailedEvents.length} events`);
                    return { success: true, result: detailedEvents };
                } catch (e) {
                    console.error('Calendar get events error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading calendar' };
                }
            }

            case 'CALENDAR_HAS_PERMISSION': {
                const calPerm = await Calendar.getCalendarPermissionsAsync();
                return { success: true, result: (calPerm.status === 'granted').toString() };
            }

            case 'CALENDAR_DELETE_EVENT': {
                console.log(`[Bridge] Calendar delete event: ${data.eventId}`);
                try {
                    const { status } = await Calendar.requestCalendarPermissionsAsync();
                    if (status !== 'granted') {
                        return { success: false, result: t('accessDenied') || 'Permission denied' };
                    }
                    await Calendar.deleteEventAsync(data.eventId);
                    return { success: true, result: 'Event deleted' };
                } catch (e) {
                    console.error('Calendar delete event error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error deleting event' };
                }
            }

            case 'CALENDAR_REQUEST_PERMISSION':
                await Calendar.requestCalendarPermissionsAsync();
                return { success: true, result: '' };

            default:
                return null;
        }
    },
};
