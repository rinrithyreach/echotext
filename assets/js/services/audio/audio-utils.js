/**
 * EchoText — Audio utilities
 * Decoding, waveform peaks, MP3 encoding, recording clean-up and file export.
 */
(function (App) {
  'use strict';

  const { clamp, slugify, formatBytes } = App.utils;
  const LAME_SRC = 'assets/vendor/lame.min.js'; // lamejs (LGPL-3.0), loaded only when encoding MP3
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  let context = null;
  let lamePromise = null;

  function audioContext() {
    if (!context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('The Web Audio API is not supported in this browser.');
      context = new Ctor();
    }
    return context;
  }

  async function decode(blob) {
    const buffer = await blob.arrayBuffer();
    // Callback form keeps older Safari happy; newer browsers also return a promise that must be handled.
    return new Promise((resolve, reject) => {
      const pending = audioContext().decodeAudioData(buffer, resolve, reject);
      if (pending && typeof pending.catch === 'function') pending.catch(reject);
    });
  }

  const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** RMS loudness per bar, normalised to 0–1. */
  function computePeaks(audioBuffer, bars) {
    return peaksOf(audioBuffer.getChannelData(0), bars);
  }

  function peaksOf(data, bars) {
    const block = Math.max(1, Math.floor(data.length / bars));
    const stride = Math.max(1, Math.floor(block / 400));
    const peaks = [];
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      let n = 0;
      for (let j = i * block; j < (i + 1) * block && j < data.length; j += stride) {
        sum += data[j] * data[j];
        n++;
      }
      peaks.push(n ? Math.sqrt(sum / n) : 0);
    }
    const max = Math.max(...peaks) || 1;
    return peaks.map((p) => Number(clamp(p / max, 0.06, 1).toFixed(3)));
  }

  /**
   * Deterministic waveform for live browser speech (which has no audio data):
   * dense words read loud, spaces and punctuation dip like natural pauses.
   */
  function textPeaks(text, bars) {
    const chars = Array.from(String(text || ''));
    if (!chars.length) return Array(bars).fill(0.1);
    const size = chars.length / bars;
    const out = [];
    for (let i = 0; i < bars; i++) {
      const start = Math.floor(i * size);
      const segment = chars.slice(start, Math.max(start + 1, Math.floor((i + 1) * size)));
      let letters = 0;
      let pauses = 0;
      let seed = i * 131;
      segment.forEach((ch) => {
        if (/[\p{L}\p{N}]/u.test(ch)) letters++;
        else if (/[.,!?;:។៕]/.test(ch)) pauses++;
        seed += ch.codePointAt(0);
      });
      const wobble = ((seed * 9301 + 49297) % 233280) / 233280;
      const density = letters / segment.length;
      out.push(Number(clamp(0.18 + density * 0.5 + wobble * 0.32 - pauses * 0.2, 0.08, 1).toFixed(3)));
    }
    return out;
  }

  /* ---------- PCM helpers ---------- */

  function channelsOf(audioBuffer) {
    const channels = [];
    for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) channels.push(audioBuffer.getChannelData(c));
    return channels;
  }

  function toMono(audioBuffer) {
    const count = audioBuffer.numberOfChannels;
    if (count === 1) return audioBuffer.getChannelData(0).slice();
    const out = new Float32Array(audioBuffer.length);
    for (let c = 0; c < count; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / count;
    }
    return out;
  }

  /** Cuts leading/trailing silence, keeping a short natural pad. Returns null if it's all silence. */
  function trimSilence(samples, sampleRate, threshold = 0.004) {
    let start = 0;
    let end = samples.length - 1;
    while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
    if (start >= samples.length) return null;
    while (end > start && Math.abs(samples[end]) < threshold) end--;
    const pad = Math.round(sampleRate * 0.15);
    return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad));
  }

  function peakOf(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak;
  }

  async function resample(samples, fromRate, toRate) {
    const ctx = new OfflineAudioContext(1, Math.ceil((samples.length * toRate) / fromRate), toRate);
    const buffer = ctx.createBuffer(1, samples.length, fromRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    return (await ctx.startRendering()).getChannelData(0);
  }

  /* ---------- WAV ---------- */

  function writeString(view, offset, value) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }

  /** 16-bit PCM WAV from one or two Float32 channels. */
  function encodeWavChannels(channels, sampleRate) {
    const count = channels.length;
    const frames = channels[0].length;
    const blockAlign = count * 2;
    const dataSize = frames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++) {
        const sample = clamp(channels[c][i], -1, 1);
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function encodeWav(audioBuffer) {
    return encodeWavChannels(channelsOf(audioBuffer), audioBuffer.sampleRate);
  }

  /**
   * Join our mono PCM WAV sections without allocating a full-length Float32 buffer. Each part's
   * `gapAfter` (seconds, default 0.2) of silence follows it. Returns the gaps used, in seconds.
   */
  async function joinWav(parts) {
    const rate = parts[0].sampleRate;
    if (parts.some((part) => part.sampleRate !== rate)) throw new Error(App.t('The saved audio sections use different sample rates.'));
    const data = [];
    const gaps = [];
    let bytes = 0;
    parts.forEach((part, index) => {
      const pcm = part.blob.slice(44);
      data.push(pcm);
      bytes += pcm.size;
      if (index < parts.length - 1) {
        const frames = Math.round(rate * (Number.isFinite(part.gapAfter) ? Math.max(0, part.gapAfter) : 0.2));
        data.push(new Uint8Array(frames * 2));
        bytes += frames * 2;
        gaps.push(frames / rate);
      } else gaps.push(0);
    });
    const header = await encodeWavChannels([new Float32Array(0)], rate).arrayBuffer();
    const view = new DataView(header);
    view.setUint32(4, 36 + bytes, true);
    view.setUint32(40, bytes, true);
    return { blob: new Blob([header, ...data], { type: 'audio/wav' }), duration: bytes / (rate * 2), gaps };
  }

  /* ---------- MP3 ---------- */

  function loadLame() {
    if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(window.lamejs);
    if (!lamePromise) {
      lamePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LAME_SRC;
        script.async = true;
        script.onload = () =>
          window.lamejs && window.lamejs.Mp3Encoder ? resolve(window.lamejs) : reject(new Error('The MP3 encoder failed to start.'));
        script.onerror = () => reject(new Error('The MP3 encoder could not be loaded.'));
        document.head.appendChild(script);
      });
      lamePromise.catch(() => {
        lamePromise = null;
      });
    }
    return lamePromise;
  }

  /** Mono MP3 from Float32 samples (speech doesn't need stereo). */
  async function encodeMp3(samples, sampleRate, kbps = 128) {
    const lame = await loadLame();
    if (!MP3_RATES.includes(sampleRate)) {
      samples = await resample(samples, sampleRate, 44100);
      sampleRate = 44100;
    }
    const encoder = new lame.Mp3Encoder(1, sampleRate, kbps);
    const BLOCK = 1152;
    const pcm = new Int16Array(BLOCK);
    const parts = [];
    for (let i = 0, n = 0; i < samples.length; i += BLOCK, n++) {
      const chunk = samples.subarray(i, i + BLOCK);
      const view = chunk.length === BLOCK ? pcm : new Int16Array(chunk.length);
      for (let j = 0; j < chunk.length; j++) {
        const s = clamp(chunk[j], -1, 1);
        view[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const out = encoder.encodeBuffer(view);
      if (out.length) parts.push(out);
      if (n % 150 === 149) await yieldToBrowser(); // keep the page responsive on long files
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  function formatOf(mime) {
    const type = String(mime || '').toLowerCase();
    if (/mpeg|mp3/.test(type)) return 'mp3';
    if (/wav|wave/.test(type)) return 'wav';
    if (/ogg|opus/.test(type)) return 'ogg';
    if (/webm/.test(type)) return 'webm';
    if (/aac|mp4|m4a/.test(type)) return 'm4a';
    return 'mp3';
  }

  async function toWav(blob) {
    if (formatOf(blob.type) === 'wav') return blob;
    return encodeWav(await decode(blob));
  }

  async function toMp3(blob) {
    if (formatOf(blob.type) === 'mp3') return blob;
    const buffer = await decode(blob);
    return encodeMp3(toMono(buffer), buffer.sampleRate);
  }

  /**
   * Turns a raw browser-voice recording (WebM/Opus) into a clean MP3:
   * trims silence, rejects silent captures, and encodes it.
   * Returns { stored, duration, mp3Failed } (WAV only if the MP3 encoder can't load).
   */
  async function processRecording(raw) {
    const silent = () =>
      new App.TTSError('No voice was captured. Share your “Entire screen” (not a tab or window) and turn on “Share system audio”.', {
        code: 'silent',
      });
    let buffer;
    try {
      buffer = await decode(raw);
    } catch {
      throw silent(); // an empty or undecodable capture almost always means no audio reached the recorder
    }
    const rate = buffer.sampleRate;
    const voice = trimSilence(toMono(buffer), rate);
    if (!voice || voice.length < rate * 0.3 || peakOf(voice) < 0.01) throw silent();

    let stored;
    let mp3Failed = false;
    try {
      stored = await encodeMp3(voice, rate);
    } catch {
      mp3Failed = true;
      stored = encodeWavChannels([voice], rate);
    }
    return { stored, duration: voice.length / rate, mp3Failed };
  }

  function metadataDuration(blob) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(blob);
      const done = (value) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => done(0);
      audio.src = url;
    });
  }

  /** Duration + waveform for a generated file. Never throws. */
  async function analyze(blob, bars) {
    try {
      const buffer = await decode(blob);
      return { duration: buffer.duration, peaks: computePeaks(buffer, bars) };
    } catch {
      return { duration: await metadataDuration(blob), peaks: null };
    }
  }

  /** A file name without characters Windows, macOS or Android refuse, and without an extension. */
  function sanitizeName(name) {
    const clean = String(name || '')
      .normalize('NFC')
      .trim()
      .replace(/\.(mp3|wav|srt|vtt|zip)$/i, '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.]+$/g, '');
    const short = Array.from(clean).slice(0, 80).join('').trim();
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(short) ? `${short}-audio` : short;
  }

  /** The file name (without extension) the item downloads as: the one the user typed, or one made from its title. */
  function baseNameFor(item) {
    const typed = sanitizeName(item.fileName);
    if (typed) return typed;
    const stamp = new Date(item.createdAt || Date.now()).toISOString().slice(0, 10);
    return `${slugify(item.title, 32)}-${stamp}`;
  }

  function filenameFor(item, ext) {
    return `${baseNameFor(item)}.${ext}`;
  }

  /** Keeps a newly made file on the item (and in History) so it saves instantly next time. */
  async function keepAudio(item, blob, duration) {
    Object.assign(item, { blob, mime: blob.type, duration: duration || item.duration, isEstimate: !duration });
    if (App.History.get(item.id)) await App.History.attachAudio(item.id, blob, item.duration);
  }

  /** Fail before writing if MP3 cannot be encoded; a chosen .mp3 file must never contain WAV bytes. */
  async function asMp3(blob) {
    if (formatOf(blob.type) === 'mp3') return blob;
    try {
      return await toMp3(blob);
    } catch (cause) {
      throw new Error(App.t('MP3 encoder unavailable'), { cause });
    }
  }

  /** Last resort when the AI voice can't make the MP3: offer to record the browser voice. */
  async function offerRecording(item, reason) {
    if (!App.SpeechRecorder.isSupported()) {
      App.toast.warning('Can’t save this voice', reason);
      return false;
    }
    const ok = await App.modal.confirm({
      title: 'Can’t save this voice directly',
      message: `${reason} You can record the voice while it plays instead.`,
      confirmText: 'Record instead',
      cancelText: 'Close',
      icon: 'info',
    });
    return ok ? App.SpeechRecorder.exportBrowserAudio(item, { skipIntro: true }) : false;
  }

  /** What the AI voice is doing, for a progress message: { title, message }. */
  function aiProgress({ phase, loaded, total }) {
    if (phase === 'download') return { title: 'Downloading the AI voice…', message: `${formatBytes(loaded)} of ${formatBytes(total)} · only the first time` };
    if (phase === 'load') return { title: 'Loading the AI voice…', message: 'Almost ready.' };
    if (phase === 'encode') return { title: 'Encoding…', message: 'Almost done.' };
    return { title: 'Making your audio…', message: total > 1 ? `Sentence ${Math.min(loaded + 1, total)} of ${total}` : 'Speaking your text.' };
  }

  /**
   * Speaks the item with its AI voice (services/tts/ai-voice.js) and encodes it.
   * Resolves to { blob, duration, voiceName, peaks }.
   */
  async function speakWithAIVoice(item, { onProgress, signal } = {}) {
    const made = await App.AIVoice.synthesize(item, { onProgress, signal });
    if (onProgress) onProgress({ phase: 'encode' });
    let blob;
    try {
      blob = await encodeMp3(made.samples, made.sampleRate);
    } catch {
      blob = encodeWavChannels([made.samples], made.sampleRate); // convert() explains if MP3 is impossible
    }
    return { blob, duration: made.duration, voiceName: `${made.voice.name} (AI voice)`, peaks: peaksOf(made.samples, App.config.peaks) };
  }

  /** speakWithAIVoice, with its progress in a toast. */
  async function renderWithAIVoice(item) {
    const controller = new AbortController();
    const status = App.toast.show({
      type: 'info',
      title: 'Preparing the AI voice…',
      duration: 0,
      action: { label: 'Cancel', onClick: () => controller.abort() },
    });
    try {
      return await speakWithAIVoice(item, { signal: controller.signal, onProgress: (p) => status.update(aiProgress(p)) });
    } finally {
      status.close();
    }
  }

  /** The stored audio for an item, or null. */
  async function storedAudio(item) {
    return item.blob || (item.hasAudio ? await App.History.getAudio(item.id).catch(() => null) : null);
  }

  /** The item's audio in `format` ('mp3' | 'wav'); older browser-only items make their first file here. */
  async function audioIn(item, format) {
    const needsAudio = !item.blob && !item.hasAudio;
    let blob = await storedAudio(item);
    let voiceNote = '';
    if (!blob && needsAudio && (!item.engine || item.engine === 'browser') && App.AIVoice.supports(item.language)) {
      const rendered = await renderWithAIVoice(item);
      blob = rendered.blob;
      await keepAudio(item, blob, rendered.duration);
      voiceNote = App.t('Voice: {name}.', { name: rendered.voiceName });
    }
    if (!blob) return { blob: null, voiceNote };
    return { blob: format === 'wav' ? await toWav(blob) : await asMp3(blob), voiceNote };
  }

  /** Export the stored audio. Older browser-only entries can still create their first file. */
  async function exportAudio(item, button, format = 'mp3') {
    const needsAudio = !item.blob && !item.hasAudio;
    if (needsAudio && item.engine && item.engine !== 'browser') {
      App.toast.error(App.t('Audio file not found'), App.t('This recording is no longer in browser storage.'));
      return false;
    }
    if (needsAudio && !App.AIVoice.supports(item.language)) {
      return offerRecording(item, App.t('This browser can’t run the AI voice that makes the MP3, so this voice can’t be saved directly.'));
    }
    // The Save window has to open now, while the click still counts as a gesture.
    let target;
    try {
      target = await App.FileSaver.prepare(filenameFor(item, format));
    } catch {
      return false; // the user closed the Save window
    }

    let fallback = null;
    App.utils.setBusy(button, true);
    try {
      const { blob: output, voiceNote } = await audioIn(item, format);
      if (!output) {
        App.toast.error(App.t('Audio file not found'), App.t('This recording is no longer in browser storage.'));
        return false;
      }
      // A chosen file keeps its name; a plain download uses the name of the actual format.
      const finalTarget = target.handle ? target : { ...target, filename: filenameFor(item, formatOf(output.type)) };
      App.FileSaver.announce(await App.FileSaver.commit(finalTarget, output), finalTarget, voiceNote);
      return true;
    } catch (err) {
      if (err.code === 'aborted') App.toast.info(App.t('Download cancelled'));
      else if (err.code === 'no_voice') fallback = () => offerRecording(item, err.message);
      else App.toast.error(App.t('Download failed'), err.message || App.t('The audio couldn’t be saved.'));
      return false;
    } finally {
      App.utils.setBusy(button, false);
      if (fallback) fallback();
    }
  }

  App.AudioUtils = {
    decode,
    computePeaks,
    peaksOf,
    encodeWavChannels,
    joinWav,
    textPeaks,
    encodeMp3,
    toMp3,
    formatOf,
    analyze,
    processRecording,
    filenameFor,
    baseNameFor,
    sanitizeName,
    keepAudio,
    aiProgress,
    speakWithAIVoice,
    exportAudio,
  };
})(window.VoiceAI = window.VoiceAI || {});
