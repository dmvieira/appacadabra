import { Accelerometer, Gyroscope, Magnetometer, Pedometer } from 'expo-sensors';
import { createCallbackScript } from './mediaHelpers';
import { CapabilityModule, HandlerContext, HandlerResult } from './types';

// Module-level state for sensor subscriptions
let pedometerSubscription: any | null = null;

export const sensorsCapability: CapabilityModule = {
    id: 'sensors',
    displayName: 'Sensors',
    minVersion: '1.0.0',
    androidPermissions: [
        'android.permission.ACTIVITY_RECOGNITION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
    ],

    docs: ` SENSORS (AppacadabraSensors)
- **IMPORTANT**: All sensor callbacks must be GLOBAL function names (strings).
- \`startAccelerometer(intervalMs, callbackName)\`
    - **Callback**: Global function name (string).
    - **data** is an Object: \`{ "x": number, "y": number, "z": number }\` (in Gs)
- \`startGyroscope(intervalMs, callbackName)\`
    - **data** is an Object: \`{ "x": number, "y": number, "z": number }\` (rotation rate in rad/s)
- \`startCompass(intervalMs, callbackName)\`
    - **data** is an Object: \`{ "heading": number, "x": number, "y": number, "z": number }\`
    - **Note**: \`heading\` is relative to North (0-360).
- \`startPedometer(callbackName)\`
    - **data** is an Object: \`{ "steps": number }\`
    - **Tip**: Takes 10-20 steps to start triggering events.
- \`startSpeedometer(callbackName)\`
    - **data** is an Object: \`{ "speed": number }\` (in km/h)
- \`startGPS(callbackName)\`
    - **data** is an Object: \`{ "latitude": number, "longitude": number, "altitude": number, "heading": number, "speed": number }\`
- \`stopAll()\`
    - **Note**: Stops ALL active sensors. ALWAYS call this when leaving the screen or pausing.`,

    validationMock: `    window.AppacadabraSensors = apiProxy;`,

    getInjectedJS: (_appId: number, _isEditMode: boolean): string => `
  window.AppacadabraSensors = {};

  const SensorsObj = (function() {
      var STEP_THRESHOLD = 11.5;
      var STEP_COOLDOWN = 300;
      var STRIDE_LENGTH = 0.75;

      var listeners = {
          motion: null,
          orientation: null,
          geo: null,
          gps: null,
          accel: null,
          gyro: null,
          pedometerInterval: null
      };

      var pedometer = {
          stepCount: 0,
          lastStepTime: 0,
          lastSpeed: 0,
          callbackName: null
      };

      var logCounts = {};
      function log(msg, data) {
          console.log('[Sensors] ' + msg + (data ? ' ' + JSON.stringify(data) : ''));
      }
      function throttledLog(tag, data) {
          if (!logCounts[tag]) {
              logCounts[tag] = 0;
              log(tag + ' FIRST data event:', data);
          }
          logCounts[tag]++;
          if (logCounts[tag] % 50 === 0) {
              log(tag + ' data (x' + logCounts[tag] + '):', data);
          }
      }

      function createBridgeCallback(targetName, fallbackFn) {
          var bridgeName = '_sensor_bridge_' + Math.floor(Math.random() * 1000000);

          var hasResponded = false;
          var timeout = setTimeout(function() {
              if (!hasResponded) {
                  log('Native bridge TIMEOUT for ' + targetName + ', starting fallback');
                  if (fallbackFn) fallbackFn();
              }
          }, 1500);

          window[bridgeName] = function(success, result) {
              if (!hasResponded) {
                  hasResponded = true;
                  clearTimeout(timeout);
              }

              if (success) {
                  var data = result;
                  if (typeof result === 'string' && (result.indexOf('{') === 0 || result.indexOf('[') === 0)) {
                      try {
                          data = JSON.parse(result);
                      } catch (e) {
                      }
                  }

                  var callbackFn = (typeof targetName === 'function') ? targetName : window[targetName];
                  var displayName = (typeof targetName === 'function') ? 'anonymous' : targetName;

                  if (typeof data === 'object' && data !== null && callbackFn) {
                      if (logCounts[displayName] === undefined) {
                          logCounts[displayName] = 0;
                          log('Native ' + displayName + ' FIRST update', data);
                      }
                      logCounts[displayName]++;
                      if (logCounts[displayName] % 50 === 0) log('Native ' + displayName + ' update (x' + logCounts[displayName] + ')', data);

                      callbackFn(true, result);
                  } else {
                      log('Native bridge confirmed for ' + displayName + ': ' + result);
                      if (callbackFn) callbackFn(success, result);
                  }
              } else {
                  log('Native bridge FAILED for ' + targetName + ': ' + result);
                  console.warn('Native sensor failed, starting fallback:', result);
                  if (fallbackFn) fallbackFn();
              }
          };
          return bridgeName;
      }

      return {
          startAccelerometer: function(interval, callback) {
              var intervalMs = typeof interval === 'number' ? interval : 100;
              var callbackName = (typeof interval === 'function') ? interval : (typeof interval === 'string' ? interval : callback);
              log('startAccelerometer called', { intervalMs, callbackName });

              var startFallback = function() {
                  log('Starting Accelerometer Fallback (devicemotion)');
                  if (listeners.accel) window.removeEventListener('devicemotion', listeners.accel);

                  listeners.accel = function(event) {
                      var acc = event.accelerationIncludingGravity;
                      if (!acc) return;
                      const g = 9.81;
                      var data = {
                          x: (acc.x || 0) / g,
                          y: (acc.y || 0) / g,
                          z: (acc.z || 0) / g
                      };
                      throttledLog('Accelerometer', data);
                      if (window[callbackName]) window[callbackName](true, data);
                  };
                  window.addEventListener('devicemotion', listeners.accel);
              };

              var bridgeName = createBridgeCallback(callbackName, startFallback);
              sendMessage('SENSORS_START_ACCELEROMETER', { intervalMs, callbackName: bridgeName }, bridgeName);
          },

          startGyroscope: function(interval, callback) {
              var intervalMs = typeof interval === 'number' ? interval : 100;
              var callbackName = (typeof interval === 'function') ? interval : (typeof interval === 'string' ? interval : callback);
              log('startGyroscope called', { intervalMs, callbackName });

              var startFallback = function() {
                  log('Starting Gyroscope Fallback (devicemotion)');
                  if (listeners.gyro) window.removeEventListener('devicemotion', listeners.gyro);

                  listeners.gyro = function(event) {
                      var rot = event.rotationRate;
                      if (!rot) return;
                      const degToRad = Math.PI / 180;
                      var data = {
                          x: (rot.beta || 0) * degToRad,
                          y: (rot.gamma || 0) * degToRad,
                          z: (rot.alpha || 0) * degToRad
                      };
                      throttledLog('Gyroscope', data);
                      if (window[callbackName]) window[callbackName](true, data);
                  };
                  window.addEventListener('devicemotion', listeners.gyro);
              };

              var bridgeName = createBridgeCallback(callbackName, startFallback);
              sendMessage('SENSORS_START_GYROSCOPE', { intervalMs, callbackName: bridgeName }, bridgeName);
          },

          startMagnetometer: function(interval, callback) {
              var intervalMs = typeof interval === 'number' ? interval : 100;
              var callbackName = (typeof interval === 'function') ? interval : (typeof interval === 'string' ? interval : callback);
              log('startMagnetometer called', { intervalMs, callbackName });

              var startFallback = function() {
                  log('Starting Magnetometer Fallback (deviceorientation)');
                  if (listeners.orientation) {
                      window.removeEventListener('deviceorientation', listeners.orientation);
                      if ('ondeviceorientationabsolute' in window) window.removeEventListener('deviceorientationabsolute', listeners.orientation);
                  }
                  listeners.orientation = function(event) {
                      var heading = 0;
                      if (event.webkitCompassHeading) {
                          heading = event.webkitCompassHeading;
                      } else if (event.alpha !== null) {
                          heading = 360 - event.alpha;
                      }
                      var data = { heading: heading, x: 0, y: 0, z: 0 };
                      throttledLog('Magnetometer', data);
                      if (window[callbackName]) {
                           window[callbackName](true, data);
                      }
                  };
                  window.addEventListener('deviceorientation', listeners.orientation);
                  if ('ondeviceorientationabsolute' in window) {
                      window.addEventListener('deviceorientationabsolute', listeners.orientation);
                  }
              };

              var bridgeName = createBridgeCallback(callbackName, startFallback);
              sendMessage('SENSORS_START_MAGNETOMETER', { intervalMs, callbackName: bridgeName }, bridgeName);
          },

          startPedometer: function(callbackName) {
              log('startPedometer called', { callbackName });

              var startJSFallback = function() {
                  log('Starting JS Pedometer (Motion+GPS)');
                  pedometer.stepCount = 0;
                  pedometer.callbackName = callbackName;
                  pedometer.lastStepTime = 0;

                  if (listeners.motion) window.removeEventListener('devicemotion', listeners.motion);

                  listeners.motion = function(event) {
                      var acc = event.accelerationIncludingGravity;
                      if (!acc) return;
                      var magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
                      var now = Date.now();
                      if (magnitude > STEP_THRESHOLD && (now - pedometer.lastStepTime) > STEP_COOLDOWN) {
                          pedometer.stepCount++;
                          pedometer.lastStepTime = now;
                          log('JS Pedometer Step detected!', pedometer.stepCount);
                          if (window[callbackName]) window[callbackName](true, { steps: pedometer.stepCount });
                      }
                  };
                  window.addEventListener('devicemotion', listeners.motion);

                  log('JS Pedometer Motion Listener Attached');

                  if (listeners.pedometerInterval) clearInterval(listeners.pedometerInterval);
                  listeners.pedometerInterval = setInterval(function() {
                       if (pedometer.lastSpeed > 3) {
                            var now = Date.now();
                            if (now - pedometer.lastStepTime > STEP_COOLDOWN) {
                                 pedometer.stepCount++;
                                 pedometer.lastStepTime = now;
                                 log('JS Pedometer GPS fallback step added', pedometer.stepCount);
                                 if (window[callbackName]) window[callbackName](true, { steps: pedometer.stepCount });
                            }
                       }
                  }, 1000);

                  if (!listeners.geo) {
                       log('JS Pedometer starting Geolocation for speed');
                       listeners.geo = navigator.geolocation.watchPosition(function(pos) {
                           pedometer.lastSpeed = (pos.coords.speed || 0) * 3.6;
                           log('JS Pedometer Speed update:', pedometer.lastSpeed);
                       }, function(e){ log('JS Pedometer Geo Error:', e); }, { enableHighAccuracy: true });
                  }
              };

              var bridgeName = createBridgeCallback(callbackName, startJSFallback);
              sendMessage('SENSORS_START_PEDOMETER', {}, bridgeName);
          },

          startSpeedometer: function(callbackName) {
               log('startSpeedometer called', { callbackName });
               if (listeners.geo) navigator.geolocation.clearWatch(listeners.geo);
               listeners.geo = navigator.geolocation.watchPosition(function(pos) {
                   var speed = (pos.coords.speed || 0) * 3.6;
                   pedometer.lastSpeed = speed;
                   if (window[callbackName]) window[callbackName](true, { speed: speed });
               }, function(err) {
                   log('Speedometer Error:', err);
                   if (window[callbackName]) window[callbackName](false, err.message);
               }, { enableHighAccuracy: true });
          },

          startGPS: function(callbackName) {
              log('startGPS called', { callbackName });
              if (listeners.gps) navigator.geolocation.clearWatch(listeners.gps);
              listeners.gps = navigator.geolocation.watchPosition(function(pos) {
                  var data = {
                      latitude: pos.coords.latitude,
                      longitude: pos.coords.longitude,
                      altitude: pos.coords.altitude,
                      accuracy: pos.coords.accuracy,
                      heading: pos.coords.heading,
                      speed: pos.coords.speed,
                      timestamp: pos.timestamp
                  };
                  if (window[callbackName]) window[callbackName](true, data);
              }, function(err) {
                  log('GPS Error:', err);
                  if (window[callbackName]) window[callbackName](false, err.message);
              }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
          },

          stopAccelerometer: function() {
              log('stopAccelerometer');
              sendMessage('SENSORS_STOP_ACCELEROMETER', {});
              if (listeners.accel) { window.removeEventListener('devicemotion', listeners.accel); listeners.accel = null; }
          },
          stopGyroscope: function() {
              log('stopGyroscope');
              sendMessage('SENSORS_STOP_GYROSCOPE', {});
              if (listeners.gyro) { window.removeEventListener('devicemotion', listeners.gyro); listeners.gyro = null; }
          },
          stopMagnetometer: function() {
              log('stopMagnetometer');
              sendMessage('SENSORS_STOP_MAGNETOMETER', {});
              if (listeners.orientation) {
                  window.removeEventListener('deviceorientation', listeners.orientation);
                  if ('ondeviceorientationabsolute' in window) window.removeEventListener('deviceorientationabsolute', listeners.orientation);
                  listeners.orientation = null;
              }
          },
          stopPedometer: function() {
             log('stopPedometer');
             sendMessage('SENSORS_STOP_PEDOMETER', {});
             if (listeners.motion) { window.removeEventListener('devicemotion', listeners.motion); listeners.motion = null; }
             if (listeners.pedometerInterval) { clearInterval(listeners.pedometerInterval); listeners.pedometerInterval = null; }
          },
          stopSpeedometer: function() {
              log('stopSpeedometer');
              if (listeners.geo) { navigator.geolocation.clearWatch(listeners.geo); listeners.geo = null; }
          },
          stopGPS: function() {
              log('stopGPS');
              if (listeners.gps) { navigator.geolocation.clearWatch(listeners.gps); listeners.gps = null; }
          },
          stopAll: function() {
              log('stopAll');
              sendMessage('SENSORS_STOP_ALL', {});
              if (listeners.accel) { window.removeEventListener('devicemotion', listeners.accel); listeners.accel = null; }
              if (listeners.gyro) { window.removeEventListener('devicemotion', listeners.gyro); listeners.gyro = null; }
              if (listeners.orientation) {
                  window.removeEventListener('deviceorientation', listeners.orientation);
                   if ('ondeviceorientationabsolute' in window) window.removeEventListener('deviceorientationabsolute', listeners.orientation);
                  listeners.orientation = null;
              }
              if (listeners.motion) { window.removeEventListener('devicemotion', listeners.motion); listeners.motion = null; }
              if (listeners.pedometerInterval) { clearInterval(listeners.pedometerInterval); listeners.pedometerInterval = null; }
              if (listeners.geo) { navigator.geolocation.clearWatch(listeners.geo); listeners.geo = null; }
              if (listeners.gps) { navigator.geolocation.clearWatch(listeners.gps); listeners.gps = null; }
          }
      };
  })();

  SensorsObj.startCompass = function(a, b) { return this.startMagnetometer(a, b); };
  SensorsObj.stopCompass = function() { return this.stopMagnetometer(); };

  Object.assign(window.AppacadabraSensors, SensorsObj);
`,

    handleMessage: async (type: string, data: any, ctx: HandlerContext): Promise<Partial<HandlerResult> | null> => {
        switch (type) {
            case 'SENSORS_START_ACCELEROMETER': {
                console.log(`[Bridge] Sensors start accelerometer: ${data.intervalMs}ms`);
                Accelerometer.removeAllListeners();
                try {
                    if (!await Accelerometer.isAvailableAsync()) throw new Error('Accelerometer not available');

                    let accelCount = 0;
                    const accelInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                    Accelerometer.setUpdateInterval(accelInterval);
                    Accelerometer.addListener(sensorData => {
                        accelCount++;
                        if (accelCount === 1 || accelCount % 50 === 0) console.log(`[Bridge] Native Accelerometer update (x${accelCount})`);
                        if (ctx.webViewRef.current && ctx.callbackName) {
                            const script = createCallbackScript(ctx.callbackName, true, sensorData);
                            ctx.webViewRef.current.injectJavaScript(script);
                        }
                    });
                    return { success: true, result: { status: 'started', sensor: 'accelerometer' } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'SENSORS_START_GYROSCOPE': {
                console.log(`[Bridge] Sensors start gyroscope: ${data.intervalMs}ms`);
                Gyroscope.removeAllListeners();
                try {
                    if (!await Gyroscope.isAvailableAsync()) throw new Error('Gyroscope not available');

                    let gyroCount = 0;
                    const gyroInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                    Gyroscope.setUpdateInterval(gyroInterval);
                    Gyroscope.addListener(sensorData => {
                        gyroCount++;
                        if (gyroCount === 1 || gyroCount % 50 === 0) console.log(`[Bridge] Native Gyroscope update (x${gyroCount})`);
                        if (ctx.webViewRef.current && ctx.callbackName) {
                            const script = createCallbackScript(ctx.callbackName, true, sensorData);
                            ctx.webViewRef.current.injectJavaScript(script);
                        }
                    });
                    return { success: true, result: { status: 'started', sensor: 'gyroscope' } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'SENSORS_START_MAGNETOMETER': {
                console.log(`[Bridge] Sensors start magnetometer: ${data.intervalMs}ms`);
                Magnetometer.removeAllListeners();
                try {
                    if (!await Magnetometer.isAvailableAsync()) throw new Error('Magnetometer not available');

                    let magCount = 0;
                    const magInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                    Magnetometer.setUpdateInterval(magInterval);
                    Magnetometer.addListener(sensorData => {
                        magCount++;
                        const { x, y } = sensorData;
                        let heading = Math.atan2(x, y) * (180 / Math.PI);
                        if (heading < 0) heading += 360;
                        const dataWithHeading = { ...sensorData, heading };

                        if (magCount === 1 || magCount % 50 === 0) console.log(`[Bridge] Native Magnetometer update (x${magCount}) heading: ${Math.round(heading)}`);
                        if (ctx.webViewRef.current && ctx.callbackName) {
                            const script = createCallbackScript(ctx.callbackName, true, dataWithHeading);
                            ctx.webViewRef.current.injectJavaScript(script);
                        }
                    });
                    return { success: true, result: { status: 'started', sensor: 'magnetometer' } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'SENSORS_START_PEDOMETER': {
                console.log('[Bridge] Sensors start pedometer');
                try {
                    if (pedometerSubscription) pedometerSubscription.remove();

                    if (!await Pedometer.isAvailableAsync()) throw new Error('Pedometer not available');

                    const permissions = await Pedometer.requestPermissionsAsync();
                    if (!permissions.granted) throw new Error('Pedometer permission denied');

                    pedometerSubscription = Pedometer.watchStepCount(result => {
                        console.log(`[Bridge] Native Pedometer step: ${result.steps}`);
                        if (ctx.webViewRef.current && ctx.callbackName) {
                            const script = createCallbackScript(ctx.callbackName, true, result);
                            ctx.webViewRef.current.injectJavaScript(script);
                        }
                    });
                    return { success: true, result: { status: 'started', sensor: 'pedometer' } };
                } catch (e) {
                    return { success: false, result: e instanceof Error ? e.message : 'Error' };
                }
            }

            case 'SENSORS_STOP_ACCELEROMETER': {
                Accelerometer.removeAllListeners();
                return { success: true, result: { status: 'stopped', sensor: 'accelerometer' } };
            }

            case 'SENSORS_STOP_GYROSCOPE': {
                Gyroscope.removeAllListeners();
                return { success: true, result: { status: 'stopped', sensor: 'gyroscope' } };
            }

            case 'SENSORS_STOP_MAGNETOMETER': {
                Magnetometer.removeAllListeners();
                return { success: true, result: { status: 'stopped', sensor: 'magnetometer' } };
            }

            case 'SENSORS_STOP_PEDOMETER': {
                if (pedometerSubscription) {
                    pedometerSubscription.remove();
                    pedometerSubscription = null;
                    return { success: true, result: { status: 'stopped', sensor: 'pedometer' } };
                } else {
                    return { success: true, result: { status: 'not_running', sensor: 'pedometer' } };
                }
            }

            case 'SENSORS_STOP_ALL': {
                Accelerometer.removeAllListeners();
                Gyroscope.removeAllListeners();
                Magnetometer.removeAllListeners();
                if (pedometerSubscription) {
                    pedometerSubscription.remove();
                    pedometerSubscription = null;
                }
                return { success: true, result: { status: 'stopped_all' } };
            }

            default:
                return null;
        }
    },
};
