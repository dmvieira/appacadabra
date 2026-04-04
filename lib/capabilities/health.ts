import {
    initialize as initHealthConnect,
    requestPermission,
    readRecords,
    aggregateRecord,
    getGrantedPermissions,
    getSdkStatus,
    SdkAvailabilityStatus
} from 'react-native-health-connect';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// Singleton promise to prevent parallel permission requests
let healthInitPromise: Promise<{ ok: boolean; error?: string }> | null = null;

async function ensureHealthAccess(): Promise<{ ok: boolean; error?: string }> {
    if (healthInitPromise) {
        return healthInitPromise;
    }

    healthInitPromise = (async () => {
        try {
            const sdkStatus = await getSdkStatus();
            if (sdkStatus !== SdkAvailabilityStatus.SDK_AVAILABLE) {
                return { ok: false, error: 'Health Connect not available on this device' };
            }

            const initialized = await initHealthConnect();
            if (!initialized) {
                return { ok: false, error: 'Failed to initialize Health Connect' };
            }

            const permissions = [
                { accessType: 'read', recordType: 'Steps' },
                { accessType: 'read', recordType: 'HeartRate' },
                { accessType: 'read', recordType: 'ExerciseSession' },
                { accessType: 'read', recordType: 'SleepSession' },
                { accessType: 'read', recordType: 'TotalCaloriesBurned' },
            ];

            const granted = await getGrantedPermissions();
            const missing = permissions.filter(p =>
                !granted.some(g => g.recordType === p.recordType && g.accessType === p.accessType)
            );

            if (missing.length > 0) {
                await requestPermission(permissions as any);
            }

            return { ok: true };
        } catch (e: any) {
            console.error('Health Access Error:', e);
            return { ok: false, error: e.message || 'Health Access Error' };
        }
    })();

    healthInitPromise.finally(() => {
        setTimeout(() => { healthInitPromise = null; }, 5000);
    });

    return healthInitPromise;
}

const mapSleepStage = (stage: number): string => {
    switch (stage) {
        case 1: return 'AWAKE';
        case 2: return 'LIGHT';
        case 3: return 'AWAKE';
        case 4: return 'LIGHT';
        case 5: return 'DEEP';
        case 6: return 'REM';
        default: return 'UNKNOWN';
    }
};

export const healthCapability: CapabilityModule = {
    id: 'health',
    displayName: 'Health',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.health.READ_STEPS',
        'android.permission.health.READ_HEART_RATE',
        'android.permission.health.READ_EXERCISE',
        'android.permission.health.READ_SLEEP',
        'android.permission.health.READ_TOTAL_CALORIES_BURNED',
    ],

    docs: `💪 HEALTH (AppacadabraHealth)
- \`getSteps(startMs, endMs, callback)\` - Get step count
    - **Return**: JSON Object: \`{ "totalSteps": number, "records": [{ "startTime": "ISO String", "endTime": "ISO String", "count": number }] }\`
- \`getHeartRate(startMs, endMs, callback)\` - Get heart rate
    - **Return**: JSON Array of objects: \`[{ "startTime": "ISO String", "endTime": "ISO String", "samples": [{ "time": "ISO String", "beatsPerMinute": number }] }]\`
- \`getExercise(startMs, endMs, callback)\` - Get exercise sessions. **Crucial**:
    - **Return**: JSON Array: \`[{ "startTime": "ISO", "endTime": "ISO", "exerciseTypeName": "ROWING"|"WALKING"|..., "exerciseType": number, "title": string|null (often null! use typeName), "notes": string|null, "metadata": {...} }]\`
    - **Note**: \`title\` is often null. Display \`exerciseTypeName\` as label. \`exerciseType\` 46 is "ROWING". Ignore internal metadata.
- \`getSleep(startMs, endMs, callback)\` - Get sleep sessions
    - **Return**: JSON Array of objects: \`[{ "startTime": "ISO String", "endTime": "ISO String", "title": string|null, "notes": string|null, "stages": [{ "startTime": "ISO String", "endTime": "ISO String", "stage": "AWAKE"|"LIGHT"|"DEEP"|"REM"|"UNKNOWN" }] }]\`
- \`getCalories(startMs, endMs, callback)\` - Get calories burned (Active + Basal)
    - **Return**: JSON Object: \`{ "totalCalories": number, "records": [{ "startTime": "ISO", "endTime": "ISO", "energy": { "inKilocalories": number } }] }\``,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraHealth = {
    initialize: function(callbackName) {
        console.log('[AppacadabraHealth.initialize] callback:', callbackName);
        sendMessage('HEALTH_INITIALIZE', {}, callbackName);
    },
    getSteps: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getSteps] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_STEPS', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getHeartRate: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getHeartRate] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_HEART_RATE', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getExercise: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getExercise] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_EXERCISE', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getSleep: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getSleep] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_SLEEP', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    },
    getCalories: function(startMs, endMs, callbackName) {
        console.log('[AppacadabraHealth.getCalories] start:', new Date(startMs).toISOString(), 'end:', new Date(endMs).toISOString(), 'callback:', callbackName);
        sendMessage('HEALTH_GET_CALORIES', { startTimeMs: startMs, endTimeMs: endMs }, callbackName);
    }
  };
`,

    handleMessage: async (type: string, data: any, _ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'HEALTH_INITIALIZE': {
                return { success: true, result: 'Health Connect initialized' };
            }

            case 'HEALTH_GET_STEPS': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) {
                        return { success: false, result: access.error || 'Health Access Denied' };
                    }
                    const stepsStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                    const stepsEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                    console.log(`[Bridge] Querying Steps from ${stepsStart.toISOString()} to ${stepsEnd.toISOString()}`);

                    const [stepsRecords, stepsAgg] = await Promise.all([
                        readRecords('Steps', {
                            timeRangeFilter: {
                                operator: 'between',
                                startTime: stepsStart.toISOString(),
                                endTime: stepsEnd.toISOString()
                            }
                        }),
                        aggregateRecord({
                            recordType: 'Steps',
                            timeRangeFilter: {
                                operator: 'between',
                                startTime: stepsStart.toISOString(),
                                endTime: stepsEnd.toISOString()
                            }
                        })
                    ]);

                    const totalSteps = (stepsAgg as any).COUNT_TOTAL || (stepsAgg as any).count || (stepsAgg as any).total || stepsRecords.records.reduce((sum: number, r: { count?: number }) => sum + (r.count || 0), 0) || 0;

                    console.log(`[Bridge] Found total steps: ${totalSteps}`);
                    return { success: true, result: JSON.stringify({ totalSteps, records: stepsRecords.records }) };
                } catch (e) {
                    console.error('Health get steps error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading steps' };
                }
            }

            case 'HEALTH_GET_HEART_RATE': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) {
                        return { success: false, result: access.error || 'Health Access Denied' };
                    }
                    const hrStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                    const hrEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                    console.log(`[Bridge] Querying HeartRate from ${hrStart.toISOString()} to ${hrEnd.toISOString()}`);

                    const hrRecords = await readRecords('HeartRate', {
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: hrStart.toISOString(),
                            endTime: hrEnd.toISOString()
                        }
                    });

                    console.log(`[Bridge] Found ${hrRecords.records.length} heart rate records.`);
                    return { success: true, result: JSON.stringify(hrRecords.records) };
                } catch (e) {
                    console.error('Health get heart rate error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading heart rate' };
                }
            }

            case 'HEALTH_GET_EXERCISE': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) {
                        return { success: false, result: access.error || 'Health Access Denied' };
                    }
                    const exStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                    const exEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                    console.log(`[Bridge] Querying ExerciseSession from ${exStart.toISOString()} to ${exEnd.toISOString()}`);

                    const exRecords = await readRecords('ExerciseSession', {
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: exStart.toISOString(),
                            endTime: exEnd.toISOString()
                        }
                    });

                    console.log(`[Bridge] Found ${exRecords.records.length} records.`);
                    if (exRecords.records.length > 0) {
                        console.log(`[Bridge] First record: ${JSON.stringify(exRecords.records[0])}`);
                    }

                    const exerciseTypeNames: Record<number, string> = {
                        0: 'OTHER', 8: 'BIKING', 16: 'DANCING', 32: 'GOLF', 36: 'HIIT',
                        37: 'HIKING', 44: 'MARTIAL_ARTS', 46: 'ROWING', 48: 'PILATES', 51: 'ROCK_CLIMBING',
                        53: 'ROWING', 56: 'RUNNING', 64: 'SOCCER', 68: 'STAIR_CLIMBING',
                        70: 'STRENGTH_TRAINING', 71: 'STRETCHING', 73: 'SWIMMING',
                        76: 'TENNIS', 79: 'WALKING', 81: 'WEIGHTLIFTING', 83: 'YOGA'
                    };

                    const enrichedRecords = exRecords.records.map((r: { exerciseType?: number; startTime?: string; endTime?: string; title?: string; notes?: string }) => {
                        const typeName = exerciseTypeNames[r.exerciseType || 0] || 'OTHER';
                        const localizedName = t(`exercise_${typeName.toLowerCase()}`, { defaultValue: typeName });

                        return {
                            ...r,
                            exerciseTypeName: typeName,
                            exerciseTypeLabel: localizedName,
                            title: r.title || localizedName
                        };
                    });

                    return { success: true, result: JSON.stringify(enrichedRecords) };
                } catch (e) {
                    console.error('Health get exercise error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading exercise' };
                }
            }

            case 'HEALTH_GET_CALORIES': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) {
                        return { success: false, result: access.error || 'Health Access Denied' };
                    }
                    const calStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                    const calEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                    console.log(`[Bridge] Querying Calories from ${calStart.toISOString()} to ${calEnd.toISOString()}`);

                    const [calRecords, calAgg] = await Promise.all([
                        readRecords('TotalCaloriesBurned', {
                            timeRangeFilter: {
                                operator: 'between',
                                startTime: calStart.toISOString(),
                                endTime: calEnd.toISOString()
                            }
                        }),
                        aggregateRecord({
                            recordType: 'TotalCaloriesBurned',
                            timeRangeFilter: {
                                operator: 'between',
                                startTime: calStart.toISOString(),
                                endTime: calEnd.toISOString()
                            }
                        })
                    ]);

                    const aggTotal = (calAgg as any).ENERGY_TOTAL?.inKilocalories || (calAgg as any).totalEnergy?.inKilocalories || 0;

                    let totalCalories = aggTotal;

                    if (!totalCalories && calRecords.records) {
                        totalCalories = calRecords.records.reduce((sum: number, r: any) => {
                            const kcal = r.energy?.inKilocalories || 0;
                            return sum + kcal;
                        }, 0);
                    }

                    console.log(`[Bridge] Found total calories: ${totalCalories}`);
                    return { success: true, result: JSON.stringify({ totalCalories, records: calRecords.records }) };
                } catch (e) {
                    console.error('Health get calories error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading calories' };
                }
            }

            case 'HEALTH_GET_SLEEP': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) {
                        return { success: false, result: access.error || 'Health Access Denied' };
                    }
                    const sleepStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                    const sleepEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                    console.log(`[Bridge] Querying SleepSession from ${sleepStart.toISOString()} to ${sleepEnd.toISOString()}`);

                    const sleepRecords = await readRecords('SleepSession', {
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: sleepStart.toISOString(),
                            endTime: sleepEnd.toISOString()
                        }
                    });

                    console.log(`[Bridge] Found ${sleepRecords.records.length} sleep records.`);

                    const mappedRecords = sleepRecords.records.map((r: any) => {
                        const stages = r.stages?.map((s: any) => ({
                            startTime: s.startTime,
                            endTime: s.endTime,
                            stage: mapSleepStage(s.stage)
                        })) || [];

                        if (r === sleepRecords.records[0]) {
                            console.log(`[Bridge] First session stages count: ${stages.length}`);
                            if (stages.length > 0) console.log(`[Bridge] First stage: ${JSON.stringify(stages[0])}`);
                        }

                        return {
                            startTime: r.startTime,
                            endTime: r.endTime,
                            title: r.title,
                            notes: r.notes,
                            stages: stages
                        };
                    });

                    return { success: true, result: JSON.stringify(mappedRecords) };
                } catch (e) {
                    console.error('Health get sleep error:', e);
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading sleep' };
                }
            }

            default:
                return null;
        }
    },
};
