import { Redirect } from 'expo-router';

export default function NotFound() {
    // Redirect any unknown routes (like file paths from deep links) to the home screen
    return <Redirect href="/" />;
}
