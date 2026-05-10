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
export function logManaEarned(source: 'iap_purchase' | 'ad_reward', amount: number, revenue_usd?: number) {
    analytics().logEvent('mana_earned', { source, amount, ...(revenue_usd !== undefined ? { revenue_usd } : {}) }).catch(() => {});
}

export function logShopOpened() {
    analytics().logEvent('shop_opened').catch(() => {});
}

export function logIapInitiated(productId: string) {
    analytics().logEvent('iap_initiated', { product_id: productId }).catch(() => {});
}

export function logIapCancelled(productId: string) {
    analytics().logEvent('iap_cancelled', { product_id: productId }).catch(() => {});
}

export function logIapFailed(productId: string) {
    analytics().logEvent('iap_failed', { product_id: productId }).catch(() => {});
}

export function logIapCreditFailed(productId: string) {
    analytics().logEvent('iap_credit_failed', { product_id: productId }).catch(() => {});
}

// ── Onboarding funnel ─────────────────────────────────────────────────────────
export function logObScreenView(screen: number) {
    analytics().logEvent('ob_screen_view', { screen }).catch(() => {});
}
export function logObChipSelected(chip: string) {
    analytics().logEvent('ob_chip_selected', { chip }).catch(() => {});
}
export function logObCompleted(chip: string) {
    analytics().logEvent('ob_completed', { chip }).catch(() => {});
}
export function logObSkipped(fromScreen: number) {
    analytics().logEvent('ob_skipped', { from_screen: fromScreen }).catch(() => {});
}

// ── Spell creation funnel ─────────────────────────────────────────────────────
export function logSpellCreateOpened(isFirstSpell: boolean) {
    analytics().logEvent('spell_create_opened', { is_first_spell: isFirstSpell }).catch(() => {});
}
export function logSpellCreateSubmitted(isFirstSpell: boolean) {
    analytics().logEvent('spell_create_submitted', { is_first_spell: isFirstSpell }).catch(() => {});
}

// ── Ads ───────────────────────────────────────────────────────────────────────
export function logAdStarted() {
    analytics().logEvent('ad_started').catch(() => {});
}

export function logAdPaidTimeout() {
    analytics().logEvent('ad_paid_timeout').catch(() => {});
}

export function logAdLoadFailed(errorCode: string) {
    analytics().logEvent('ad_load_failed', { error_code: errorCode }).catch(() => {});
}

export function logAdClosedEarly() {
    analytics().logEvent('ad_closed_early').catch(() => {});
}

// ── Spell list menu ───────────────────────────────────────────────────────────
export function logSpellMenuOpened() {
    analytics().logEvent('spell_menu_opened').catch(() => {});
}
export function logSpellMenuAction(action: string) {
    analytics().logEvent('spell_menu_action', { action }).catch(() => {});
}

// ── Editor ────────────────────────────────────────────────────────────────────
export function logEditorTabOpened(tab: string) {
    analytics().logEvent('editor_tab_opened', { tab }).catch(() => {});
}
export function logEditorAiEditSubmitted(hasElement: boolean) {
    analytics().logEvent('editor_ai_edit_submitted', { has_element: hasElement }).catch(() => {});
}
export function logEditorVersionRestored() {
    analytics().logEvent('editor_version_restored').catch(() => {});
}
export function logEditorVersionDeleted() {
    analytics().logEvent('editor_version_deleted').catch(() => {});
}

// ── Capability usage ──────────────────────────────────────────────────────────
export function logCapabilityUsed(capabilityId: string, messageType: string, success: boolean) {
    analytics().logEvent('capability_used', {
        capability_id: capabilityId,
        message_type: messageType,
        success: success ? 1 : 0,
    }).catch(() => {});
}
