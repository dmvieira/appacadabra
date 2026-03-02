import analytics from '@react-native-firebase/analytics';

// Screen view — called automatically via usePathname() in _layout.tsx
export function logScreenView(screenName: string) {
    analytics().logScreenView({ screen_name: screenName, screen_class: screenName }).catch(() => {});
}

// App lifecycle
export function logAppCreated(creditsUsed: number) {
    analytics().logEvent('app_created', { credits_used: creditsUsed }).catch(() => {});
}

export function logAppEdited(creditsUsed: number) {
    analytics().logEvent('app_edited', { credits_used: creditsUsed }).catch(() => {});
}

// AI generation via WebView bridge
export function logAiGenerate(creditsUsed: number, hasImage: boolean, hasAudio: boolean) {
    analytics().logEvent('ai_generate', {
        credits_used: creditsUsed,
        has_image: hasImage,
        has_audio: hasAudio,
    }).catch(() => {});
}

export function logAiGenerateImage(creditsUsed: number) {
    analytics().logEvent('ai_generate_image', { credits_used: creditsUsed }).catch(() => {});
}

// Icon generation (context: 'setup' = first-time setup flow, 'menu' = icon picker menu)
export function logIconGenerated(context: 'setup' | 'menu', creditsUsed: number) {
    analytics().logEvent('icon_generated', { context, credits_used: creditsUsed }).catch(() => {});
}

// Mana
export function logManaEarned(source: 'iap_purchase' | 'ad_reward', amount: number) {
    analytics().logEvent('mana_earned', { source, amount }).catch(() => {});
}

export function logShopOpened() {
    analytics().logEvent('shop_opened').catch(() => {});
}
