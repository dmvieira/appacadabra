import 'expo-router/entry';
import { AppRegistry } from 'react-native';
import RunnerApp from './RunnerApp';
import { runBackgroundGeneratorTask } from './lib/backgroundGeneratorTask';

// Register the standalone runner component
// This will be loaded by RunnerActivity instead of expo-router
AppRegistry.registerComponent('runner', () => RunnerApp);

// HeadlessJS task hosted by BackgroundGeneratorService (Android FGS).
// Runs the BYOK spell generation pipeline in a background JS context so the
// job survives the main activity being backgrounded.
AppRegistry.registerHeadlessTask('BackgroundGeneratorTask', () => runBackgroundGeneratorTask);
