// Lists every interface string passed to t() / App.t() in assets/js, so tests can check that
// each one has a Khmer translation. Run: node tools/i18n-keys.cjs  (prints the strings, one per line)
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'assets', 'js');

// Strings used through a variable (labels in tables, names in config) rather than written in t(...).
const INDIRECT = [
  'Speed', 'Pitch', 'Voice', 'Controls',
  'Female', 'Male', 'Gender-neutral', 'English', 'Khmer',
  'Loading your voice…', 'Downloading voice files…', 'Generating your audio…', 'Section saved', 'Preparing your audio…',
  'Unsupported file', 'File too large', 'Empty file', 'No text found', 'Password-protected PDF', 'Couldn’t read file',
  'Use Khmer', 'Use English',
];

// Literals inside t(...) that are compared, not shown.
const IGNORE = new Set(['light', 'use-khmer']);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return entry.name.endsWith('.js') && entry.name !== 'i18n-km.js' ? [full] : [];
  });
}

/** String literals in the first argument of each t( / App.t( call. */
function keysIn(source) {
  const keys = [];
  const call = /(?:^|[^\w.$])(?:App\.)?t\(/g;
  let match;
  while ((match = call.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        let text = '';
        while (j < source.length && source[j] !== ch) {
          if (source[j] === '\\') {
            text += source[j + 1];
            j += 2;
          } else text += source[j++];
        }
        if (/[A-Za-z]/.test(text)) keys.push(text);
        i = j;
      } else if (ch === '`') {
        break; // template literals are not translation keys
      } else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
  }
  return keys;
}

function allKeys() {
  const set = new Set(INDIRECT);
  for (const file of files(root)) keysIn(fs.readFileSync(file, 'utf8')).forEach((key) => set.add(key));
  return [...set].filter((key) => !IGNORE.has(key)).sort();
}

module.exports = { allKeys };
if (require.main === module) console.log(allKeys().join('\n'));
