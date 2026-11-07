# EchoText — Text to Speech

A text-to-speech web app built with plain HTML, CSS and JavaScript. It has no build step, and every voice runs inside the browser: no server, account or API key. Google Fonts are fetched from the internet; the voice models are included in the project.

- **Voice:** one built-in default per speech language: Kristin for English and Khmer (MMS) for Khmer. The default is selected automatically and has a Preview button. Both voices work offline.
- **English and Khmer:** both the speech language and the interface language. The top bar switches the interface between English and ខ្មែរ.
- **One audio file per generation:** it's made once, and the same file is used for playback, History and every download.
- **Long texts:** up to 50,000 characters, split into sections. Progress is shown per section, and you can Cancel and Continue later, even after closing the tab.
- **Controls:** speed and pitch.
- **Downloads:** MP3 or WAV audio. You can edit the file name.
- **History:** search, rename, favourites and projects, plus replay, open in the studio, download, and delete with undo.
- **Import:** .txt, .docx and text-based .pdf. Word and PDF text is shown for checking (and editing) before it's used.
- **Models & storage:** model sizes, download and loading progress, free storage, and Load, Unload, Repair and Remove for each voice. The device is checked before a voice loads.

## Run it

**Open `index.html` in Chrome, Edge, Firefox or Safari.** There's nothing to install or start. The built-in voices load from `assets/voices` the first time they're used, which takes a few seconds.

Downloads go to the browser's download folder. To save them on the Desktop, open `chrome://settings/downloads` (in Edge, `edge://settings/downloads`), choose **Change** next to **Location**, pick **Desktop**, and keep **Ask where to save each file** off. If EchoText is served from a website instead of opened as a file, Download opens a Save window on the Desktop.

## Voices

| Voice | Language | Size | Where it comes from | Licence |
| --- | --- | --- | --- | --- |
| Kristin (female) | English (US) | 61 MB | Built in | Public domain |
| Khmer (MMS) (male) | Khmer | 109 MB | Built in | **CC BY-NC 4.0** |

The English default is a [Piper](https://github.com/rhasspy/piper) voice from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). Older saved voice choices and presets fall back to the default for their speech language.

**The Khmer voice is for non-commercial use only.** It is Meta's [MMS-TTS Khmer](https://huggingface.co/facebook/mms-tts-khm) model, licensed CC BY-NC 4.0, and the studio says so when it's selected. Replace it before using EchoText commercially.

## Khmer

- **Speech:** the Khmer voice reads Khmer script. Sentences end at ។ ៕ ! and ?. A full stop inside Khmer text (ក.ម.) is treated as an abbreviation. Over-long sentences are split at dictionary word breaks, because Khmer has no spaces between words.
- **Numbers** in Khmer (០–៩) or Western (0–9) digits are read as Khmer words: ២០២៦ → ពីរពាន់ម្ភៃប្រាំមួយ, 1,250 → មួយពាន់ពីររយហាសិប, and 3.5% → បី ចុច ប្រាំ ភាគរយ. Numbers with a leading zero, such as phone numbers, are read digit by digit. Latin letters are skipped; write words in Khmer script for this voice.
- **Interface:** every label, message and dialog has a Khmer translation (`assets/js/core/i18n-km.js`), using the Kantumruy Pro font. `tests/features.test.cjs` fails if a new string has no translation. The translations should be checked by a native speaker before release.
- **Text handling:** the studio notices Khmer text typed with an English voice selected (and the reverse) and offers to switch.

## Controls

- **Speed and pitch:** adjust the speaking speed and pitch in the Controls tab. Sentence and paragraph pauses are handled automatically.
- **Presets:** save the voice, speed, pitch and pauses under a name, and apply them with one click.

## Models & storage

The database button in the top bar opens it. For each voice and the speech engine it shows the size, where it is (built in, downloaded, partly downloaded or not downloaded), whether it's loaded in memory, and progress while it downloads or loads.

- **Download / Load / Unload:** fetch a voice ahead of time, warm it up, or free its memory.
- **Repair:** unloads the voice, deletes and downloads its files again (built-in files are re-read), loads it, and speaks a test sentence.
- **Remove:** deletes a downloaded voice. Built-in voices can only be unloaded.
- **Device check:** WebAssembly, browser storage and reported memory. Before a voice loads, EchoText checks there's enough free storage for its download and that the device isn't offline. A device reporting under 4 GB of memory gets a warning that can be accepted.
- **Keep my files** asks the browser not to clear EchoText's storage when space runs low.

## How it works

`services/tts/ai-voice.js` runs both engines with [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.18.0:

- **Piper (English):** text becomes phonemes through espeak-ng (`piper_phonemize.wasm`), and the model turns them into audio.
- **MMS (Khmer):** text is normalised (`services/tts/khmer-text.js`) and becomes character tokens, the same ones the official tokenizer makes (checked by a test). The model turns them into audio.

Neither engine has a pitch control. Pitch is applied by speaking slower or faster and then changing the sample rate.

Generation (`services/tts/tts-service.js`) splits the text into sections of about 900 characters (`services/tts/text-segments.js`). Each finished section is saved in IndexedDB together with its progress, so Cancel, a crash or a closed tab loses at most the section in progress. The sections are joined into one WAV. MP3 is encoded from that WAV only when you download it.

Pages opened as files can't use ES modules, `fetch()` of local files or workers. So the vendor scripts are classic scripts, and the built-in models are stored as base64 scripts in `assets/voices/`: 22 files of up to 22 MB. pdf.js runs on the page instead of in a worker.

### Rebuilding the Khmer voice

`tools/convert-mms-khmer.py` exports `facebook/mms-tts-khm` to ONNX with the same inputs as Piper. `tools/bundle-voice.cjs` writes the result as `assets/voices` scripts. Instructions are at the top of the Python script.

## Project structure

```
index.html                 App shell + script order
assets/css/
  base.css                 Design tokens (dark default + light theme), reset, layout, motion
  components.css           Buttons, glass cards, form controls, navbar, toasts, modal…
  pages.css                Studio, player, history…
  features.css             Voice list, tabs, presets, exports, History tools, Models & storage, menus, Khmer type
assets/vendor/
  lame.min.js              MP3 encoder (lamejs, LGPL-3.0)
  ort.wasm.min.js          ONNX Runtime Web 1.18.0 (MIT)
  piper_phonemize.js       espeak-ng phonemizer loader (MIT)
  pdf.min.js, pdf.worker.min.js   pdf.js 3.11.174 (Apache-2.0, see pdfjs.LICENSE), loaded only to import a PDF
assets/voices/             Engine + default voice models (base64 scripts)
assets/js/
  core/                    utils, storage + event bus, icons, router, i18n (+ Khmer strings), zip
  config/app-config.js     Speech languages, limits, voice defaults, ranges
  services/
    settings-service.js    Look, interface language, last voice, presets
    history-service.js     History metadata, favourites, projects (localStorage)
    audio-store.js         History audio (IndexedDB)
    generation-store.js    Saved sections of unfinished generations (IndexedDB)
    document-import.js     .txt / .docx / .pdf → text
    file-saver.js          Downloads (Save window when served from a website)
    audio/                 WAV/MP3 encoding, audio exports, playback
    tts/
      tts-service.js       Generate once, checkpoint sections, preview
      ai-voice.js          Voice catalogue, Piper + MMS engines, downloads, status, repair, device check
      text-segments.js     Sentences, paragraphs, sections
      khmer-text.js        Khmer numbers and symbols as words
  ui/                      toast, modal (confirm, prompt, wide dialogs), menu, scroll reveal
  components/              navbar, generator (studio), player, history-list, models-panel
  pages/                   home (studio + history), not-found
  app.js                   Bootstrap
tools/                     i18n string check, Khmer model conversion and bundling
tests/                     jsdom tests (npm test) and real-model synthesis (npm run test:synthesis)
```

Every script registers itself on `window.VoiceAI`, so the app runs without a bundler.

## Tests

```
npm install
npm test                 # studio, recovery, imports, exports and Khmer
npm run test:synthesis   # real Kristin and Khmer speech and MP3
```

## Licences

EchoText's own code has no licence file yet. Bundled third-party parts:

- ONNX Runtime Web: MIT.
- piper-phonemize loader: MIT.
- espeak-ng data: GPL-3.0 ([source](https://github.com/espeak-ng/espeak-ng)).
- lamejs: LGPL-3.0.
- pdf.js: Apache-2.0.
- Voices: see the table above.
