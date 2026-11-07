/**
 * EchoText — Browser voice catalogue
 * Wraps speechSynthesis.getVoices(): async loading, language matching,
 * quality ranking and gender detection (the API doesn't expose gender, so it
 * is inferred from well-known voice names across Windows, macOS, Chrome & Edge).
 */
(function (App) {
  'use strict';

  const synth = window.speechSynthesis;
  const GOOGLE_US = 'Google US English';

  const FEMALE_NAMES = [
    'zira', 'hazel', 'susan', 'catherine', 'linda', 'heera', 'helena', 'hortense', 'julie', 'sabina', 'haruka',
    'ayumi', 'nanami', 'heami', 'sunhi', 'sun-hi', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona',
    'veena', 'kyoko', 'yuna', 'amelie', 'amélie', 'aurelie', 'audrey', 'marie', 'monica', 'mónica', 'paulina',
    'linh', 'hoaimy', 'sreymom', 'aria', 'jenny', 'emma', 'ava', 'michelle', 'ana', 'sonia', 'libby', 'clara',
    'natasha', 'sara', 'elvira', 'denise', 'eloise', 'vivienne', 'ximena', 'dalia', 'laura', 'lucia', 'irene',
    'elena', 'salome', 'shiori', 'mayu', 'aoi', 'seoyeon', 'jimin', 'yujin', 'serena', 'allison', 'kathy', 'vicki',
    'nicky', 'zoe', 'joelle', 'noelle', 'sandy', 'shelley', 'flo', 'grandma', 'alice', 'anna', 'nora', 'ellen',
  ];

  const MALE_NAMES = [
    'david', 'mark', 'george', 'james', 'richard', 'ravi', 'paul', 'pablo', 'raul', 'claude', 'ichiro', 'keita',
    'guy', 'andrew', 'brian', 'christopher', 'eric', 'roger', 'steffan', 'ryan', 'thomas', 'daniel', 'alex', 'fred',
    'aaron', 'arthur', 'rishi', 'jorge', 'diego', 'juan', 'nicolas', 'henri', 'alvaro', 'álvaro', 'injoon', 'hyunsu',
    'bongjin', 'gookmin', 'namminh', 'piseth', 'naoki', 'daichi', 'otoya', 'hattori', 'jacques', 'remy',
    'rémy', 'jerome', 'jérôme', 'yves', 'alain', 'gonzalo', 'arnau', 'dario', 'eddy', 'evan', 'nathan', 'tom',
    'reed', 'rocko', 'ralph', 'albert', 'bruce', 'grandpa', 'junior', 'tomas', 'tomás',
  ];

  const femaleRe = new RegExp(`(^|[^\\p{L}])(${FEMALE_NAMES.join('|')})([^\\p{L}]|$)`, 'iu');
  const maleRe = new RegExp(`(^|[^\\p{L}])(${MALE_NAMES.join('|')})([^\\p{L}]|$)`, 'iu');

  let voices = [];
  let pending = null;

  const normalizeLang = (lang) => String(lang || '').replace('_', '-').toLowerCase();

  function detectGender(voice) {
    const name = voice.name.toLowerCase();
    if (/\bfemale\b|\bwoman\b/.test(name)) return 'female';
    if (/\bmale\b|\bman\b/.test(name)) return 'male';
    if (femaleRe.test(name)) return 'female';
    if (maleRe.test(name)) return 'male';
    return null;
  }

  function qualityScore(voice) {
    const name = voice.name.toLowerCase();
    let score = 0;
    if (/natural|neural|premium|enhanced|wavenet/.test(name)) score += 3;
    if (/online/.test(name)) score += 1;
    if (/google/.test(name)) score += 1;
    return score;
  }

  function displayName(voice) {
    const isNatural = /natural|neural/i.test(voice.name);
    const base = voice.name
      .replace(/\s+-\s+[^-]+$/, '') // "… - English (United States)"
      .replace(/\s*\((natural|neural)\)/i, '')
      .replace(/\s+online/i, '')
      .replace(/^microsoft\s+/i, '')
      .trim();
    return `${base}${isNatural ? ' · Natural' : ''}`;
  }

  function refresh() {
    voices = synth ? synth.getVoices() : [];
    return voices;
  }

  function load(timeout = 1500) {
    if (!synth) return Promise.resolve([]);
    if (refresh().length) return Promise.resolve(voices);
    if (!pending) {
      pending = new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          synth.removeEventListener('voiceschanged', finish);
          pending = null;
          resolve(refresh());
        };
        const timer = setTimeout(finish, timeout);
        synth.addEventListener('voiceschanged', finish);
      });
    }
    return pending;
  }

  // Edge and Chrome add online voices after startup — keep the catalogue fresh.
  if (synth && synth.addEventListener) {
    synth.addEventListener('voiceschanged', () => {
      refresh();
      App.bus.emit('voices:change', voices);
    });
  }

  function forLanguage(code) {
    const target = normalizeLang(code);
    const primary = target.split('-')[0];
    return voices
      .filter((voice) => normalizeLang(voice.lang).split('-')[0] === primary)
      .map((voice) => ({
        voice,
        exact: normalizeLang(voice.lang) === target,
        gender: detectGender(voice),
        score: qualityScore(voice),
      }))
      .sort((a, b) => b.exact - a.exact || b.score - a.score || a.voice.name.localeCompare(b.voice.name));
  }

  const voiceId = (voice) => voice.voiceURI || voice.name;

  /** Voices for a language, shaped for the voice picker. */
  function list(code) {
    return forLanguage(code).map(({ voice, gender, score }) => ({
      id: voiceId(voice),
      name: displayName(voice),
      gender,
      tag: voice.lang.replace('_', '-'),
      quality: score >= 3 ? 'natural' : 'standard',
      local: voice.localService,
    }));
  }

  /** Chrome's Google US English: the one voice the studio speaks with. Null in other browsers. */
  function google() {
    return voices.find((voice) => voice.name === GOOGLE_US) || null;
  }

  /**
   * Picks the voice to speak with: Google US English, or this browser's own voice where it
   * doesn't have it (it comes with Google Chrome). Google US English is female, so Male is the
   * same voice with its pitch lowered.
   */
  function resolve(code, gender) {
    const entries = forLanguage(code);
    if (!entries.length) return { voice: null, pitchFactor: 1, approximated: false, available: false };

    const entry = entries.find((e) => e.voice.name === GOOGLE_US) || entries.find((e) => e.gender === gender) || entries[0];
    const voiceGender = entry.voice.name === GOOGLE_US ? 'female' : entry.gender;
    let pitchFactor = 1;
    if (gender === 'male' && voiceGender !== 'male') pitchFactor = 0.72;
    if (gender === 'female' && voiceGender === 'male') pitchFactor = 1.3;
    return { voice: entry.voice, pitchFactor, approximated: pitchFactor !== 1, available: true };
  }

  App.BrowserVoices = {
    supported: !!synth && typeof window.SpeechSynthesisUtterance === 'function',
    GOOGLE_US,
    load,
    list,
    google,
    resolve,
    displayName,
    detectGender,
    get all() {
      return voices;
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
