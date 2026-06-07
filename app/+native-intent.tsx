export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    try {
        if (!path) return '/';

        if (path.startsWith('runapp://')) {
            // Always handled by RunnerActivity on Android
            return '/';
        }

        // iOS Quick Actions (long-press app icon → spell shortcut) fire this
        // scheme via UIApplication.open from AppDelegate. Strip the scheme so
        // Expo Router resolves to `/runner/[id]`.
        if (path.startsWith('appacadabra://runner/')) {
            const id = path.slice('appacadabra://runner/'.length);
            return `/runner/${id}`;
        }

        if (path.startsWith('content://') || path.startsWith('file://')) {
            const encoded = encodeURIComponent(path);
            return `/?openUri=${encoded}`;
        }

        return path;
    } catch {
        return '/';
    }
}
