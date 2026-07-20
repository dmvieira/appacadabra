// ============================================
// Appacadabra Landing Page - Main JavaScript
// ============================================

// Default language
let currentLang = 'en';

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Detect browser language
    const browserLang = navigator.language.split('-')[0];
    const supportedLangs = ['en', 'pt', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'ar', 'hi', 'ru', 'tr', 'nl', 'pl', 'vi', 'th'];

    // Check URL param first, then localStorage, then browser language
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    const savedLang = localStorage.getItem('appacadabra_lang');

    if (urlLang && supportedLangs.includes(urlLang)) {
        currentLang = urlLang;
    } else if (savedLang && supportedLangs.includes(savedLang)) {
        currentLang = savedLang;
    } else if (supportedLangs.includes(browserLang)) {
        currentLang = browserLang;
    }

    // Set language selector
    document.getElementById('lang-select').value = currentLang;
    document.getElementById('form-language').value = currentLang;

    // Apply translations
    applyTranslations(currentLang);
});

// Change language
function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('appacadabra_lang', lang);
    document.getElementById('form-language').value = lang;
    applyTranslations(lang);

    // Track language change
    if (typeof gtag === 'function') {
        gtag('event', 'language_change', {
            'language': lang
        });
    }
}

// Apply translations to all elements with data-i18n attribute
function applyTranslations(lang) {
    const t = translations[lang] || translations['en'];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) {
            el.textContent = t[key];
        }
    });

    // Handle placeholder translations
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) {
            el.placeholder = t[key];
        }
    });

    // Update HTML lang attribute
    document.documentElement.lang = lang;
}

// ============================================
// iOS Modal
// ============================================

function showIOSModal() {
    document.getElementById('ios-modal').classList.add('active');

    // Track modal open
    if (typeof gtag === 'function') {
        gtag('event', 'ios_modal_open', {
            'language': currentLang
        });
    }
}

function closeIOSModal() {
    document.getElementById('ios-modal').classList.remove('active');
}

// Close modal on outside click
document.addEventListener('click', (e) => {
    const modal = document.getElementById('ios-modal');
    if (e.target === modal) {
        closeIOSModal();
    }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeIOSModal();
    }
});

// ============================================
// Analytics Tracking
// ============================================

function trackDownload(platform) {
    if (typeof gtag === 'function') {
        gtag('event', 'download_click', { platform, language: currentLang });
    }
    const isAndroid = /android/i.test(navigator.userAgent);
    if (isAndroid) {
        window.location.href = 'market://details?id=ai.appacadabra.app';
    } else {
        window.open('https://play.google.com/store/apps/details?id=ai.appacadabra.app', '_blank');
    }
    return false; // prevent default href
}

// Handle iOS Waitlist Form (AJAX)
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('ios-waitlist-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const button = form.querySelector('button');
            const originalText = button.textContent;

            // Loading state
            button.disabled = true;
            button.textContent = "Sending...";

            try {
                const response = await fetch(form.action, {
                    method: 'POST',
                    body: new FormData(form),
                    headers: {
                        'Accept': 'application/json'
                    }
                });

                if (response.ok) {
                    // Success
                    button.textContent = "Thanks! ✨";
                    form.reset();

                    // Track event
                    if (typeof gtag === 'function') {
                        gtag('event', 'ios_waitlist_signup', {
                            'language': currentLang
                        });
                    }

                    // Close after delay
                    setTimeout(() => {
                        closeIOSModal();
                        // Reset button for next time
                        setTimeout(() => {
                            button.disabled = false;
                            button.textContent = originalText;
                        }, 500);
                    }, 2000);
                } else {
                    throw new Error('Network response was not ok');
                }
            } catch (error) {
                // Error
                console.error('Error:', error);
                button.textContent = "Error 😕";
                setTimeout(() => {
                    button.disabled = false;
                    button.textContent = originalText;
                }, 3000);
            }
        });
    }
});

// ============================================
// Smooth scroll for anchor links
// ============================================

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth'
            });
        }
    });
});

// ============================================
// Intersection Observer for animations
// ============================================

const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Animate feature cards, steps, screen cards and pricing cards on scroll
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.feature-card, .step, .screen-card, .byok-step').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(el);
    });
});

// ============================================
// FAQ Accordion
// ============================================

function toggleFaq(btn) {
    const isOpen = btn.getAttribute('aria-expanded') === 'true';
    const answer = btn.nextElementSibling;

    btn.setAttribute('aria-expanded', String(!isOpen));

    if (isOpen) {
        answer.hidden = true;
    } else {
        answer.hidden = false;

        // Track FAQ expand event
        const questionText = btn.querySelector('[data-i18n]')
            ? btn.querySelector('[data-i18n]').textContent.trim()
            : btn.textContent.trim();

        if (typeof gtag === 'function') {
            gtag('event', 'faq_expand', {
                'question': questionText,
                'language': currentLang
            });
        }
    }
}

// ============================================
// Email Obfuscation
// ============================================

function openEmail() {
    const user = 'support';
    const domain = 'appacadabra.ai';
    const email = user + '@' + domain;
    window.location.href = 'mailto:' + email;
}

// Render obfuscated email text
document.addEventListener('DOMContentLoaded', () => {
    const emailElements = document.querySelectorAll('.obfuscated-email');
    emailElements.forEach(el => {
        const user = 'support';
        const domain = 'appacadabra.ai';
        el.textContent = user + '@' + domain;
    });
});
