/** Generate once; play and export the same audio. Checkpoint each completed section. */
(function (App) {
  'use strict';
  const { uid, titleFromText, clamp, formatNumber } = App.utils;
  const t = (text, params) => App.t(text, params);
  const abort = () => new App.TTSError(t('Generation stopped. Completed sections are saved.'), { code: 'aborted' });
  const check = (signal) => { if (signal && signal.aborted) throw abort(); };
  let generating = false;

  /** Seconds of silence after each cue of section `index` (the last one is the gap before the next section). */
  function gapsFor(job, index) {
    const ends = (job.breaks && job.breaks[index]) || [];
    const pauses = (job.pauses && job.pauses[index]) || [];
    return job.sections[index].map((_, j) => App.TextSegments.pauseFor({ paragraphEnd: ends[j], pauseAfter: pauses[j] }, job.input));
  }

  /** Voice settings from the studio, each kept within its range. */
  function voiceSettings(input) {
    const selected = App.AIVoice.voiceFor(input);
    if (!selected) throw new App.TTSError(t('Choose an available voice.'), { code: 'no_voice' });
    const within = (key) => {
      const range = App.config.ranges[key];
      const value = Number(input[key]);
      return clamp(Number.isFinite(value) ? value : App.config.voiceDefaults[key], range.min, range.max);
    };
    return {
      language: selected.language, gender: selected.gender, voiceId: selected.id,
      rate: within('rate'), pitch: within('pitch'), volume: 1,
      sentencePause: within('sentencePause'), paragraphPause: within('paragraphPause'),
      ...(selected.engine === 'mms' ? { synthesisProfile: 'khmer-clear-v3' } : {}), // saved with the job (see ai-voice.js)
    };
  }

  const TTS = {
    isBusy: () => generating,
    lock() {
      if (generating) throw new App.TTSError(t('Another generation is still running.'), { code: 'busy' });
      generating = true;
      App.bus.emit('tts:busy', true);
      let released = false;
      return () => { if (!released) { released = true; generating = false; App.bus.emit('tts:busy', false); } };
    },
    provider: () => ({ id: 'piper', name: t('Local AI voices'), capabilities: { download: true, pitch: true, rate: [0.5, 2] } }),

    validate(text, language) {
      const value = String(text || '').trim();
      if (!value) throw new App.TTSError(t('Please enter some text to convert to speech.'), { code: 'empty_text' });
      if (value.length > App.config.maxChars) throw new App.TTSError(t('Use up to {n} characters per project. Your text has not been shortened.', { n: formatNumber(App.config.maxChars) }), { code: 'too_long' });
      if (!/[\p{L}\p{N}]/u.test(value)) throw new App.TTSError(t('Add some readable words first.'), { code: 'no_words' });
      if (language === 'km-KH' && !/[ក-៿0-9០-៩]/.test(value)) {
        throw new App.TTSError(t('The Khmer voice reads Khmer script. Add Khmer text, or choose an English voice.'), { code: 'wrong_script' });
      }
      return value;
    },

    listJobs() { return App.GenerationStore.list(); },

    async generate(input, { signal, onProgress, resumeId, onJob } = {}) {
      const release = this.lock();
      try {
        check(signal);
        if (!App.AIVoice.isSupported()) throw new App.TTSError(t('This browser cannot run local AI voices. Try a recent Chrome, Edge, Firefox or Safari.'), { code: 'unsupported' });
        let job;
        if (resumeId) {
          job = await App.GenerationStore.get(resumeId);
          if (!job) throw new App.TTSError(t('This saved generation is no longer available.'), { code: 'missing_job' });
        } else {
          const voice = voiceSettings(input);
          const text = this.validate(input.text, voice.language);
          const { sections, breaks, pauses } = App.TextSegments.plan(text, voice.language);
          job = {
            id: uid('aud'), title: titleFromText(text), input: { text, ...voice },
            sections, breaks, pauses, completed: 0, createdAt: Date.now(), project: input.project || null,
          };
          await App.GenerationStore.create(job);
        }
        if (onJob) await onJob(job.id);
        if (onProgress) onProgress({ phase: 'load', jobId: job.id, completed: job.completed, sections: job.sections.length });
        const parts = [];
        for (let index = 0; index < job.completed; index++) {
          check(signal);
          const part = await App.GenerationStore.part(job.id, index);
          if (!part) throw new App.TTSError(t('A saved section is missing. Start a new generation from the original text.'), { code: 'missing_audio' });
          parts.push(part);
        }
        for (let index = job.completed; index < job.sections.length; index++) {
          check(signal);
          const report = (progress) => onProgress && onProgress({ ...progress, jobId: job.id, section: index + 1, sections: job.sections.length, completed: index });
          report({ phase: 'load' });
          const labels = job.sections[index];
          const gaps = gapsFor(job, index);
          // Older checkpoints keep their original delivery when unfinished sections resume.
          const synthesisProfile = job.input.synthesisProfile || 'original';
          const made = await App.AIVoice.synthesize({ ...job.input, synthesisProfile, text: labels.join(' '), cueTexts: labels, cueLabels: labels, gaps }, { signal, onProgress: report });
          check(signal);
          const part = {
            index, blob: App.AudioUtils.encodeWavChannels([made.samples], made.sampleRate),
            duration: made.duration, sampleRate: made.sampleRate, cues: made.cues,
            peaks: App.AudioUtils.peaksOf(made.samples, 72), gapAfter: gaps[gaps.length - 1],
          };
          const updated = { ...job, completed: index + 1 };
          await App.GenerationStore.save(updated, part);
          job = updated;
          parts.push(part);
          if (onProgress) onProgress({ phase: 'section', jobId: job.id, completed: job.completed, section: job.completed, sections: job.sections.length });
        }
        check(signal);
        if (onProgress) onProgress({ phase: 'assemble', jobId: job.id, completed: job.completed, sections: job.sections.length });
        const { blob, duration, gaps } = await App.AudioUtils.joinWav(parts);
        check(signal);
        let offset = 0;
        const cues = parts.flatMap((part, i) => {
          const list = part.cues.map((cue) => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
          offset += part.duration + (gaps[i] || 0);
          return list;
        });
        const allPeaks = parts.flatMap((part) => part.peaks);
        const peaks = Array.from({ length: App.config.peaks }, (_, i) => allPeaks[Math.floor(i * allPeaks.length / App.config.peaks)] || 0.06);
        const voice = App.AIVoice.voiceFor(job.input);
        const { pronunciations, ...settings } = job.input;
        return {
          ...settings, id: job.id, title: job.title, createdAt: job.createdAt, project: job.project || null,
          engine: voice.engine === 'mms' ? 'mms' : 'piper', engineName: t('Local AI voices'), voiceName: voice.name,
          languageName: t(App.config.getLanguage(job.input.language).name),
          blob, mime: blob.type, duration, isEstimate: false, peaks, cues,
          narrationSegments: cues.map((cue) => ({ ...cue })), revision: 1,
        };
      } catch (err) {
        if (signal && signal.aborted) throw abort();
        if (err.name === 'QuotaExceededError') throw new App.TTSError(t('Browser storage is full. Free some space, then continue your saved generation.'), { code: 'storage' });
        throw err;
      } finally { release(); }
    },

    async openPlayback(item) {
      let blob = item.blob || null;
      if (!blob && item.hasAudio) blob = await App.History.getAudio(item.id).catch(() => null);
      if (blob) return new App.AudioPlayback(blob, { duration: item.duration });
      // Old browser-only history remains playable until regenerated in the studio.
      if (item.engine && item.engine !== 'browser') throw new App.TTSError(t('This audio is no longer stored on this device.'), { code: 'missing_audio' });
      await App.BrowserVoices.load();
      const match = App.BrowserVoices.resolve(item.language, item.gender);
      return new App.SpeechPlayback({ text: item.text, voice: match.voice, lang: item.language, rate: item.rate, pitch: clamp(item.pitch * match.pitchFactor, 0, 2), volume: 1, cps: item.cps || App.config.getLanguage(item.language).cps });
    },

    /** Speaks a short sample (or `text`) with the voice settings, for previews. */
    async preview(voice, { signal, text, onProgress } = {}) {
      const settings = voiceSettings(voice);
      const sample = text || App.config.getLanguage(settings.language).sample;
      const units = App.TextSegments.units(sample, undefined, settings.language);
      const labels = units.map((unit) => unit.text);
      const gaps = units.map((unit) => App.TextSegments.pauseFor(unit, settings));
      const made = await App.AIVoice.synthesize({ ...settings, text: labels.join(' '), cueTexts: labels, cueLabels: labels, gaps }, { signal, onProgress });
      check(signal);
      return new App.AudioPlayback(App.AudioUtils.encodeWavChannels([made.samples], made.sampleRate), { duration: made.duration });
    },
  };
  App.TTS = TTS;
})(window.VoiceAI = window.VoiceAI || {});
