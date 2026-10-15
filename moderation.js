/* Basic content filtering for comments and review notes: a short profanity
 * blocklist and a few spam shapes. Server-side only — the client may pre-check
 * to save a round-trip, but the server is the gate. Kept dependency-free:
 * normalise, then literal substring match. Blocked words are never echoed back.
 */

// Lowercase literals matched against normalised text. Plain everyday list:
// the strong set and a couple of common variants. Not exhaustive by design —
// the report queue (a later phase) is the real backstop.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dickhead',
  'whore', 'slut', 'wanker', 'bollocks', 'prick',
];

// Text through one normaliser: lowercase, digits that stand in for letters
// swapped back, everything that is not a letter or space dropped. Letter runs
// and inner spacing are handled by the matchers below, not here, so the
// blocklist words themselves stay whole.
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProfane(text) {
  const n = normalise(text);
  // "f u c k" as separate words, punctuation between letters, and repeated
  // letters ("fuuuck") each land on a form that matches the plain literals.
  const squashed = n.replace(/\s/g, '');
  const squeezed = squashed.replace(/(.)\1+/g, '$1');
  return PROFANITY.some(w => n.indexOf(w) !== -1 || squashed.indexOf(w) !== -1
    || squeezed.indexOf(w) !== -1);
}

// A lighter normal form for the "same text again" duplicate check:
// lowercase, punctuation dropped, spacing collapsed — no leetspeak mapping,
// which would wrongly make "comment 1" and "comment 19" identical.
function loose(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// (a) a bare link with no words around it; (b) more than 3 links; (c) an
// all-caps run longer than 40 letters. The "same text again within 24 hours"
// duplicate check is the caller's — it needs the database.
function isSpam(text) {
  const s = String(text || '');
  const links = (s.match(/https?:\/\//g) || []).length + (s.match(/\bwww\./g) || []).length;
  if (links > 3) return true;
  // A bare link with no words of its own around it.
  const noLinks = s.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  if (links >= 1 && normalise(noLinks).replace(/\s/g, '').length < 3) return true;
  const caps = s.replace(/[^A-Za-z]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (caps.join('').length > 40) return true;
  return false;
}

module.exports = { normalise, loose, isProfane, isSpam };
