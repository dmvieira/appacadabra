import AppleHealthKit, { HealthKitPermissions } from 'react-native-health';
import { t } from '../i18n';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

const PERMISSIONS: HealthKitPermissions = {
    permissions: {
        read: [
            AppleHealthKit.Constants.Permissions.StepCount,
            AppleHealthKit.Constants.Permissions.HeartRate,
            AppleHealthKit.Constants.Permissions.SleepAnalysis,
            AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
            AppleHealthKit.Constants.Permissions.Workout,
        ],
        write: [],
    },
};

let initPromise: Promise<{ ok: boolean; error?: string }> | null = null;

function ensureHealthAccess(): Promise<{ ok: boolean; error?: string }> {
    if (initPromise) return initPromise;
    initPromise = new Promise(resolve => {
        AppleHealthKit.initHealthKit(PERMISSIONS, (error: string) => {
            if (error) {
                resolve({ ok: false, error: error || 'HealthKit initialization failed' });
            } else {
                resolve({ ok: true });
            }
        });
    });
    initPromise.finally(() => { setTimeout(() => { initPromise = null; }, 5000); });
    return initPromise;
}

function toISO(ms: number | undefined, fallbackOffsetMs: number): string {
    return new Date(ms ?? Date.now() - fallbackOffsetMs).toISOString();
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const exerciseTypeNames: Record<string, string> = {
    Walking: 'WALKING', Running: 'RUNNING', Cycling: 'BIKING', Swimming: 'SWIMMING',
    Yoga: 'YOGA', Hiking: 'HIKING', Dancing: 'DANCING', Pilates: 'PILATES',
    Tennis: 'TENNIS', Soccer: 'SOCCER', Basketball: 'OTHER', Golf: 'GOLF',
    Rowing: 'ROWING', Elliptical: 'OTHER', StairClimbing: 'STAIR_CLIMBING',
    HighIntensityIntervalTraining: 'HIIT', FunctionalStrengthTraining: 'STRENGTH_TRAINING',
    TraditionalStrengthTraining: 'WEIGHTLIFTING', Other: 'OTHER',
};

export const healthCapability: CapabilityModule = {
    id: 'health',
    displayName: 'Health',
    minVersion: '2.0.0',
    description: "`getSteps` returns step count records; `getHeartRate` returns heart rate samples; `getExercise` returns exercise sessions with type names; `getSleep` returns sleep stages; `getCalories` returns active calories — all accept a start/end timestamp range.",
    androidPermissions: [],
    manifestBlocks: [],

    docs: `💪 HEALTH (AppacadabraHealth)
- \`getSteps(startMs, endMs, callback)\` - Get step count. Callback: \`callback(success, data)\`
    - **data** is an Object: \`{ totalSteps: number, records: [{ startTime: "ISO String", endTime: "ISO String", count: number }] }\`
    - Example: \`var steps = data.totalSteps;\`
- \`getHeartRate(startMs, endMs, callback)\` - Get heart rate. Callback: \`callback(success, data)\`
    - **data** is an Array: \`[{ startTime: "ISO String", endTime: "ISO String", samples: [{ time: "ISO String", beatsPerMinute: number }] }]\`
    - Example: \`var bpm = data[0].samples[0].beatsPerMinute;\`
- \`getExercise(startMs, endMs, callback)\` - Get exercise sessions. Callback: \`callback(success, data)\`.
    - **data** is an Array: \`[{ startTime: "ISO", endTime: "ISO", exerciseTypeName: "ROWING"|"WALKING"|..., title: string }]\`
- \`getSleep(startMs, endMs, callback)\` - Get sleep sessions. Callback: \`callback(success, data)\`
    - **data** is an Array: \`[{ startTime: "ISO String", endTime: "ISO String", stages: [{ startTime: "ISO String", endTime: "ISO String", stage: "AWAKE"|"LIGHT"|"DEEP"|"REM"|"UNKNOWN" }] }]\`
- \`getCalories(startMs, endMs, callback)\` - Get calories burned. Callback: \`callback(success, data)\`
    - **data** is an Object: \`{ totalCalories: number, records: [{ startTime: "ISO", endTime: "ISO", energy: { inKilocalories: number } }] }\``,

    validationMock: `    window.AppacadabraHealth = apiProxy;`,

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
                const access = await ensureHealthAccess();
                return { success: access.ok, result: access.ok ? 'HealthKit initialized' : access.error };
            }

            case 'HEALTH_GET_STEPS': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) return { success: false, result: access.error || 'HealthKit access denied' };

                    const startDate = toISO(data.startTimeMs, DAY);
                    const endDate = toISO(data.endTimeMs, 0);

                    const [totalResult, samplesResult] = await Promise.all([
                        new Promise<number>((resolve) => {
                            AppleHealthKit.getStepCount({ startDate, endDate }, (err: string, result: { value: number }) => {
                                resolve(err ? 0 : (result?.value ?? 0));
                            });
                        }),
                        new Promise<any[]>((resolve) => {
                            AppleHealthKit.getDailyStepCountSamples({ startDate, endDate }, (err: string, results: any[]) => {
                                resolve(err ? [] : (results ?? []));
                            });
                        }),
                    ]);

                    const records = samplesResult.map(r => ({
                        startTime: r.startDate,
                        endTime: r.endDate,
                        count: r.value,
                    }));

                    return { success: true, result: { totalSteps: totalResult, records } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading steps' };
                }
            }

            case 'HEALTH_GET_HEART_RATE': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) return { success: false, result: access.error || 'HealthKit access denied' };

                    const startDate = toISO(data.startTimeMs, DAY);
                    const endDate = toISO(data.endTimeMs, 0);

                    const samples = await new Promise<any[]>((resolve) => {
                        AppleHealthKit.getHeartRateSamples({ startDate, endDate }, (err: string, results: any[]) => {
                            resolve(err ? [] : (results ?? []));
                        });
                    });

                    // Normalize to the same shape as Health Connect: grouped by session (iOS returns individual samples)
                    const normalized = samples.map(r => ({
                        startTime: r.startDate,
                        endTime: r.endDate,
                        samples: [{ time: r.startDate, beatsPerMinute: r.value }],
                    }));

                    return { success: true, result: normalized };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading heart rate' };
                }
            }

            case 'HEALTH_GET_EXERCISE': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) return { success: false, result: access.error || 'HealthKit access denied' };

                    const startDate = toISO(data.startTimeMs, WEEK);
                    const endDate = toISO(data.endTimeMs, 0);

                    const workouts = await new Promise<any[]>((resolve) => {
                        AppleHealthKit.getSamples({ type: 'Workout', startDate, endDate } as any, (err: string, results: any[]) => {
                            resolve(err ? [] : (results ?? []));
                        });
                    });

                    const enriched = workouts.map(r => {
                        const rawType = r.activityName || r.workoutActivityType || 'Other';
                        const typeName = exerciseTypeNames[rawType] || 'OTHER';
                        const localized = t(`exercise_${typeName.toLowerCase()}`, { defaultValue: typeName });
                        return {
                            startTime: r.startDate,
                            endTime: r.endDate,
                            exerciseTypeName: typeName,
                            exerciseTypeLabel: localized,
                            title: r.sourceName || localized,
                            notes: null,
                        };
                    });

                    return { success: true, result: enriched };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading exercise' };
                }
            }

            case 'HEALTH_GET_SLEEP': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) return { success: false, result: access.error || 'HealthKit access denied' };

                    const startDate = toISO(data.startTimeMs, WEEK);
                    const endDate = toISO(data.endTimeMs, 0);

                    const samples = await new Promise<any[]>((resolve) => {
                        AppleHealthKit.getSleepSamples({ startDate, endDate }, (err: string, results: any[]) => {
                            resolve(err ? [] : (results ?? []));
                        });
                    });

                    // HealthKit returns individual sleep stage intervals; group into sessions by date
                    const sessions = new Map<string, { startTime: string; endTime: string; stages: any[] }>();
                    for (const s of samples) {
                        const dayKey = new Date(s.startDate).toISOString().slice(0, 10);
                        if (!sessions.has(dayKey)) {
                            sessions.set(dayKey, { startTime: s.startDate, endTime: s.endDate, stages: [] });
                        }
                        const session = sessions.get(dayKey)!;
                        if (s.endDate > session.endTime) session.endTime = s.endDate;

                        const rawValue: string = s.value || '';
                        let stage = 'UNKNOWN';
                        if (rawValue === 'INBED') stage = 'LIGHT';
                        else if (rawValue === 'ASLEEP' || rawValue === 'ASLEEPUNSPECIFIED') stage = 'LIGHT';
                        else if (rawValue === 'AWAKE') stage = 'AWAKE';
                        else if (rawValue === 'ASLEEPCORE') stage = 'LIGHT';
                        else if (rawValue === 'ASLEEPDEEP') stage = 'DEEP';
                        else if (rawValue === 'ASLEEPREM') stage = 'REM';

                        session.stages.push({ startTime: s.startDate, endTime: s.endDate, stage });
                    }

                    const result = Array.from(sessions.values()).map(s => ({
                        startTime: s.startTime,
                        endTime: s.endTime,
                        title: null,
                        notes: null,
                        stages: s.stages,
                    }));

                    return { success: true, result };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading sleep' };
                }
            }

            case 'HEALTH_GET_CALORIES': {
                try {
                    const access = await ensureHealthAccess();
                    if (!access.ok) return { success: false, result: access.error || 'HealthKit access denied' };

                    const startDate = toISO(data.startTimeMs, DAY);
                    const endDate = toISO(data.endTimeMs, 0);

                    const samples = await new Promise<any[]>((resolve) => {
                        AppleHealthKit.getActiveEnergyBurned({ startDate, endDate }, (err: string, results: any[]) => {
                            resolve(err ? [] : (results ?? []));
                        });
                    });

                    const records = samples.map(r => ({
                        startTime: r.startDate,
                        endTime: r.endDate,
                        energy: { inKilocalories: r.value },
                    }));
                    const totalCalories = records.reduce((sum, r) => sum + r.energy.inKilocalories, 0);

                    return { success: true, result: { totalCalories, records } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error reading calories' };
                }
            }

            default:
                return null;
        }
    },
};
