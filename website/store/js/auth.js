import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider,
  signInWithPopup,
  signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import { t } from './store-i18n.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
const authListeners = [];

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authListeners.forEach(fn => fn(user));
  updateAuthUI(user);
});

async function signIn() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.warn('[Auth] sign-in error:', err.code);
    }
  }
}

function updateAuthUI(user) {
  const btn = document.getElementById('auth-btn');
  if (!btn) return;

  // Remove any existing dropdown
  document.getElementById('auth-dropdown')?.remove();

  if (user) {
    const avatar = user.photoURL
      ? `<img src="${user.photoURL}" class="auth-avatar" alt="" referrerpolicy="no-referrer">`
      : `<span class="auth-avatar-initial">${(user.displayName || user.email || '?')[0].toUpperCase()}</span>`;
    btn.innerHTML = `${avatar}<span class="auth-name">${user.displayName || user.email || 'Account'}</span> ▾`;
    btn.className = 'auth-btn auth-btn--user';
    btn.title = '';
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleAuthDropdown(user);
    };
  } else {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> ${t('signIn')}`;
    btn.className = 'auth-btn';
    btn.title = '';
    btn.onclick = signIn;
  }
}

function toggleAuthDropdown(user) {
  const existing = document.getElementById('auth-dropdown');
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById('auth-btn');
  const dropdown = document.createElement('div');
  dropdown.id = 'auth-dropdown';
  dropdown.className = 'auth-dropdown';
  dropdown.innerHTML = `
    <div class="auth-dropdown-user">
      <span class="auth-dropdown-name">${user.displayName || ''}</span>
      <span class="auth-dropdown-email">${user.email || ''}</span>
    </div>
    <hr class="auth-dropdown-divider">
    <button class="auth-dropdown-signout" type="button">${t('signOut')}</button>
  `;
  dropdown.querySelector('.auth-dropdown-signout').onclick = () => {
    dropdown.remove();
    signOut(auth);
  };

  // Position below the button
  const rect = btn.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  dropdown.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(dropdown);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', () => dropdown.remove(), { once: true });
  }, 0);
}

function onAuthChange(fn) {
  authListeners.push(fn);
}

function getCurrentUser() {
  return currentUser;
}

function requireAuth(callback) {
  if (currentUser) {
    callback(currentUser);
    return;
  }
  signIn();
}

export { app, auth, getCurrentUser, onAuthChange, requireAuth, signIn };
