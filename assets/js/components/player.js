/**
 * EchoText — Audio player
 * Play/pause, waveform, seekable progress bar, duration and downloads for a
 * generation result. Works with both file audio and live browser speech.
 */
(function (App) {
  'use strict';

  const { $, escapeHtml, formatTime, clamp } = App.utils;
  const icon = App.icon;

  function bars(peaks) {
    return peaks.map((p) => `<span style="--h:${Math.round(p * 100)}%"></span>`).join('');
  }

  const t = (text, params) => App.t(text, params);
  let counter = 0;

  function noteHtml(item) {
    const voice = App.AIVoice.supports(item.language) ? App.AIVoice.voiceFor(item) : null;
    if (voice) {
      return `${icon('info', 15)}<span>${escapeHtml(t('Browsers can’t save this voice, so Download makes the file with the AI voice {name}, which sounds different.', { name: voice.name }))}</span>`;
    }
    return `${icon('info', 15)}<span>${escapeHtml(t('This browser can’t run the AI voice, so Download records this voice while it plays.'))}</span>`;
  }

  function template(item, uid) {
    const lang = App.config.getLanguage(item.language);
    const isLive = item.engine === 'browser' && !item.blob && !item.hasAudio;
    const peaks = item.peaks || App.AudioUtils.textPeaks(item.text, App.config.peaks);

    return `
      <div class="player" data-player>
        <div class="player-top">
          <button class="player-play" type="button" aria-label="${escapeHtml(t('Play audio'))}" data-play>${icon('play', 22)}</button>
          <div class="player-info">
            <p class="player-title" title="${escapeHtml(item.title)}" lang="${lang.code}">${escapeHtml(item.title)}</p>
            <div class="player-meta">
              <span class="chip"><span class="chip-code">${lang.short}</span>${escapeHtml(t(lang.name))}</span>
              <span>${escapeHtml(item.voiceName || '')}</span>
              ${item.revision > 1 ? `<span class="chip">${escapeHtml(t('Version {n}', { n: item.revision }))}</span>` : ''}
              ${item.project ? `<span class="meta-text">${icon('folder', 13)} ${escapeHtml(item.project)}</span>` : ''}
            </div>
          </div>
          <div class="player-dl">
            <button class="btn btn-outline btn-sm" type="button" data-download aria-label="${escapeHtml(t('Download audio'))}">
              <span>${icon('download', 16)}</span><span data-download-label>${escapeHtml(t('Download MP3'))}</span>
            </button>
          </div>
        </div>

        <div class="wave" data-wave aria-hidden="true">
          <div class="wave-layer">${bars(peaks)}</div>
          <div class="wave-layer wave-fill">${bars(peaks)}</div>
        </div>

        <div class="player-progress">
          <span class="time" data-current>0:00</span>
          <div class="progress" role="slider" tabindex="0" aria-label="${escapeHtml(t('Seek'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-progress>
            <div class="progress-fill"></div>
            <div class="progress-thumb"></div>
          </div>
          <span class="time" data-duration>${item.isEstimate ? '~' : ''}${formatTime(item.duration)}</span>
        </div>

        <section class="player-exports" aria-label="${escapeHtml(t('Downloads'))}">
          <div class="export-row">
            <div class="field export-name">
              <label class="field-label" for="export-name-${uid}">${icon('pencil', 14)} ${escapeHtml(t('File name'))}</label>
              <div class="input-suffix">
                <input class="input input-sm" id="export-name-${uid}" data-filename value="${escapeHtml(App.AudioUtils.baseNameFor(item))}" maxlength="80" autocomplete="off" spellcheck="false" />
                <span class="input-suffix-text" data-ext>.mp3</span>
              </div>
            </div>
          </div>
        </section>
        ${isLive ? `<p class="player-note" data-live-note>${noteHtml(item)}</p>` : `<p class="player-note">${escapeHtml(t('Playback and downloads use the same generated audio.'))}</p>`}
      </div>`;
  }

  /**
   * @param {HTMLElement} container
   * @param {object} item  generation result (see TTS.generate)
   * @param {{autoplay?: boolean, onMeasured?: (seconds:number, cps?:number) => void}} options
   */
  function create(container, item, { autoplay = false, onMeasured } = {}) {
    container.innerHTML = template(item, ++counter);
    const root = $('[data-player]', container);
    const playBtn = $('[data-play]', root);
    const progress = $('[data-progress]', root);
    const wave = $('[data-wave]', root);
    const currentEl = $('[data-current]', root);
    const durationEl = $('[data-duration]', root);

    let playback = null;
    let opening = null;
    let destroyed = false;
    let seeking = false;
    let painted = 0; // the progress last drawn, 0–1

    function paint(ratio, current, duration, estimate) {
      const next = clamp(ratio, 0, 1);
      const pct = `${(next * 100).toFixed(2)}%`;
      // Going back (playing again, seeking back) lands at once; only forward movement glides.
      const back = next < painted - 0.005;
      if (back) root.classList.add('is-snapping');
      root.style.setProperty('--p', pct);
      if (back) {
        void root.offsetWidth;
        root.classList.remove('is-snapping');
      }
      painted = next;
      progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      progress.setAttribute('aria-valuetext', t('{current} of {total}', { current: formatTime(current), total: formatTime(duration) }));
      currentEl.textContent = formatTime(current);
      durationEl.textContent = `${estimate ? '~' : ''}${formatTime(duration)}`;
    }

    function setPlayingUI(state) {
      const playing = state === 'playing';
      root.classList.toggle('is-playing', playing);
      playBtn.innerHTML = icon(playing ? 'pause' : 'play', 22);
      playBtn.setAttribute('aria-label', t(playing ? 'Pause audio' : 'Play audio'));
    }

    function ensurePlayback() {
      if (playback) return Promise.resolve(playback);
      if (!opening) {
        opening = App.TTS.openPlayback(item).then((pb) => {
          if (destroyed) { pb.destroy(); throw new Error(t('Player closed.')); }
          playback = pb;
          pb.on('state', setPlayingUI);
          pb.on('progress', (snap) => !seeking && paint(snap.progress, snap.currentTime, snap.duration, snap.isEstimate));
          pb.on('error', (err) => App.toast.error(t('Playback problem'), err.message));
          pb.on('measured', (seconds) => {
            paint(1, seconds, seconds, false);
            if (onMeasured) onMeasured(seconds, pb.cps); // cps: the real speaking pace, for live speech
          });
          return pb;
        });
        opening.catch((err) => {
          opening = null;
          if (!destroyed) App.toast.error(t('Can’t play this audio'), err.message);
        });
      }
      return opening;
    }

    playBtn.addEventListener('click', () => ensurePlayback().then((pb) => pb.toggle()).catch(() => {}));

    // Seeking: drag on the progress bar or the waveform; commit on release.
    function ratioFrom(event, el) {
      const rect = el.getBoundingClientRect();
      return clamp((event.clientX - rect.left) / rect.width, 0, 1);
    }

    function bindSeek(el) {
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        seeking = true;
        root.classList.add('is-seeking');
        el.setPointerCapture(event.pointerId);
        const preview = (e) => {
          const ratio = ratioFrom(e, el);
          const duration = playback ? playback.duration : item.duration;
          paint(ratio, ratio * duration, duration, playback ? playback.snapshot().isEstimate : item.isEstimate);
          return ratio;
        };
        preview(event);
        const move = (e) => preview(e);
        const up = (e) => {
          const ratio = preview(e);
          seeking = false;
          root.classList.remove('is-seeking');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          ensurePlayback().then((pb) => pb.seek(ratio)).catch(() => {});
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }

    bindSeek(progress);
    bindSeek(wave);

    progress.addEventListener('keydown', (event) => {
      const steps = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 };
      let target = null;
      const current = playback ? playback.snapshot().progress : 0;
      if (event.key in steps) target = current + steps[event.key];
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = 0.999;
      else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        playBtn.click();
        return;
      }
      if (target === null) return;
      event.preventDefault();
      ensurePlayback().then((pb) => pb.seek(clamp(target, 0, 1))).catch(() => {});
    });

    // The typed file name goes with the item and into History for later audio downloads.
    const nameInput = $('[data-filename]', root);
    function commitName() {
      const typed = App.AudioUtils.sanitizeName(nameInput.value);
      const fallback = App.AudioUtils.baseNameFor({ ...item, fileName: null });
      const fileName = typed && typed !== fallback ? typed : null;
      if (fileName !== (item.fileName || null)) {
        item.fileName = fileName;
        if (App.History.get(item.id)) App.History.update(item.id, { fileName });
      }
      nameInput.value = App.AudioUtils.baseNameFor(item);
    }
    nameInput.addEventListener('change', commitName);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitName();
      }
    });
    const withName = (fn) => (event) => {
      commitName();
      fn(event.currentTarget);
    };
    $('[data-download]', root).addEventListener('click', withName((button) => App.AudioUtils.exportAudio(item, button, 'mp3')));

    paint(0, 0, item.duration, item.isEstimate);
    if (autoplay) ensurePlayback().then((pb) => pb.play()).catch(() => {});

    return {
      stop() {
        if (playback) playback.stop();
      },
      destroy() {
        destroyed = true;
        if (playback) playback.destroy();
        playback = null;
        container.innerHTML = '';
      },
    };
  }

  App.components.Player = { create };
})(window.VoiceAI = window.VoiceAI || {});
