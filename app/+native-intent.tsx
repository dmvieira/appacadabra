export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    try {
        if (!path) return '/';

        if (path.startsWith('runapp://')) {
            // Always handled by RunnerActivity on Android
            return '/';
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
