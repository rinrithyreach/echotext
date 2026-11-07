/**
 * EchoText — Browser-voice recorder
 *
 * The Web Speech API plays speech straight to the speakers and never exposes
 * the audio, so it can't be downloaded directly. This service records it
 * instead: it asks the browser to share the screen *with system audio*
 * (getDisplayMedia), speaks the text, records the audio track with
 * MediaRecorder, then trims and encodes it to MP3.
 *
 * Works in Chrome and Edge on Windows/ChromeOS (and recent macOS versions);
 * the user must pick "Entire screen" and enable "Share system audio".
 */
(function (App) {
  'use strict';

  const { formatTime } = App.utils;
  const LEAD_IN_MS = 400;
  const TAIL_MS = 700;
  let busy = false;

  function isSupported() {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getDisplayMedia &&
      window.MediaRecorder &&
      App.BrowserVoices.supported &&
      !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    );
  }

  function recorderMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function captureSystemAudio() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        monitorTypeSurfaces: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new App.TTSError('Recording cancelled — screen and audio sharing wasn’t allowed.', { code: 'aborted' });
      }
      throw new App.TTSError('Your browser couldn’t start audio capture.', { code: 'capture_failed', cause: err });
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new App.TTSError('No audio was shared. Choose “Entire screen” and turn on “Share system audio”, then try again.', {
        code: 'no_audio',
      });
    }
    return stream;
  }

  /** Records the browser voice reading `item`. Resolves to the raw recording Blob. */
  async function record(item, { signal, onProgress } = {}) {
    const stream = await captureSystemAudio();
    let playback = null;
    try {
      if (signal && signal.aborted) throw new App.TTSError('Recording cancelled.', { code: 'aborted' });
      playback = await App.TTS.openPlayback({ ...item, blob: null, hasAudio: false, engine: 'browser' });

      const mime = recorderMime();
      const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });

      await new Promise((resolve, reject) => {
        stream.getAudioTracks()[0].addEventListener('ended', () =>
          reject(new App.TTSError('Sharing stopped before the recording finished.', { code: 'capture_ended' }))
        );
        if (signal) {
          signal.addEventListener('abort', () => reject(new App.TTSError('Recording cancelled.', { code: 'aborted' })), { once: true });
        }
        playback.on('progress', (snap) => onProgress && onProgress(snap));
        playback.on('error', reject);
        playback.on('state', (state) => state === 'ended' && setTimeout(resolve, TAIL_MS));
        recorder.start(250);
        setTimeout(() => {
          if (!(signal && signal.aborted)) playback.play();
        }, LEAD_IN_MS);
      });

      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      return new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    } finally {
      if (playback) playback.destroy();
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  /**
   * Record-and-save flow for browser voices — the fallback when this browser
   * can't run the AI voice (see AudioUtils.exportAudio).
   * skipIntro: the caller already explained the steps and got the click.
   */
  async function exportBrowserAudio(item, { skipIntro = false } = {}) {
    if (!isSupported()) {
      App.toast.error('Recording isn’t available here', 'Recording browser voices needs Chrome or Edge on a computer.');
      return false;
    }
    if (busy) {
      App.toast.info('A recording is already in progress');
      return false;
    }

    if (!skipIntro) {
      const ok = await App.modal.confirm({
        title: 'Record this voice as MP3',
        message:
          `EchoText records the voice while it plays (about ${formatTime(item.duration)}). ` +
          'When your browser asks what to share, choose “Entire screen” and turn on “Share system audio”. Keep other sounds muted until it finishes.',
        confirmText: 'Start recording',
        icon: 'mic',
      });
      if (!ok) return false;
    }

    busy = true;
    const controller = new AbortController();
    const status = App.toast.show({
      type: 'info',
      title: 'Waiting for screen & audio sharing…',
      message: 'Choose “Entire screen” and turn on “Share system audio”.',
      duration: 0,
      action: { label: 'Cancel', onClick: () => controller.abort() },
    });

    try {
      const raw = await record(item, {
        signal: controller.signal,
        onProgress: (snap) =>
          status.update({
            title: 'Recording browser voice…',
            message: `${formatTime(snap.currentTime)} / ~${formatTime(snap.duration)} — keep this tab open`,
          }),
      });
      status.update({ title: 'Encoding MP3…', message: 'Almost done.' });
      const { stored, duration, mp3Failed } = await App.AudioUtils.processRecording(raw);
      await App.AudioUtils.keepAudio(item, stored, duration);
      status.close();
      if (mp3Failed) {
        App.toast.warning('Saved as WAV', 'The MP3 encoder couldn’t load, so the recording was saved as WAV.');
      }

      const outExt = App.AudioUtils.formatOf(stored.type);
      const filename = App.AudioUtils.filenameFor(item, outExt);
      if (!App.FileSaver.supported()) {
        // No Save window possible here: download now and explain where it went.
        const target = await App.FileSaver.prepare(filename);
        App.FileSaver.announce(await App.FileSaver.commit(target, stored), target, 'It’s also saved in History.');
        return true;
      }

      // Recording took a while, so the original click no longer counts as a gesture:
      // ask for one more click before opening the Save window on the Desktop.
      const save = await App.modal.confirm({
        title: `Your ${outExt.toUpperCase()} is ready`,
        message: `Recorded ${formatTime(duration)} of audio. Choose where to save it — the Save window opens on your Desktop.`,
        confirmText: `Save ${outExt.toUpperCase()}`,
        cancelText: 'Not now',
        icon: 'download',
      });
      if (!save) {
        App.toast.info('Saved to History', 'Download it anytime from the player or the History page.');
        return true;
      }
      try {
        const target = await App.FileSaver.prepare(filename);
        App.FileSaver.announce(await App.FileSaver.commit(target, stored), target, 'It’s also saved in History.');
      } catch (err) {
        if (err && err.name === 'AbortError') App.toast.info('Save cancelled', 'The recording is still in History — download it anytime.');
        else throw err;
      }
      return true;
    } catch (err) {
      status.close();
      if (err.code === 'aborted') App.toast.info('Recording cancelled');
      else App.toast.error('Recording failed', err.message || 'Please try again.');
      return false;
    } finally {
      busy = false;
    }
  }

  App.SpeechRecorder = { isSupported, record, exportBrowserAudio };
})(window.VoiceAI = window.VoiceAI || {});
