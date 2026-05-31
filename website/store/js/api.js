import { getFunctions, httpsCallable }
  from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-functions.js';
import { app } from './auth.js';

const functions = getFunctions(app, FUNCTIONS_REGION);
const learnSpellFn = httpsCallable(functions, 'learnSpell');
const unpublishSpellFn = httpsCallable(functions, 'unpublishSpell');

async function learnSpell(spellId) {
  const result = await learnSpellFn({ spellId });
  return result.data;
}

async function unpublishSpell(spellId) {
  const result = await unpublishSpellFn({ spellId });
  return result.data;
}

export { learnSpell, unpublishSpell };
