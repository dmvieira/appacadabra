import 'expo-router/entry';
import { AppRegistry } from 'react-native';
import RunnerApp from './RunnerApp';

// Register the standalone runner component
// This will be loaded by RunnerActivity instead of expo-router
AppRegistry.registerComponent('runner', () => RunnerApp);
