/**
 * EchoText — File saver
 *
 * Web pages can't write to the Desktop on their own. Chrome and Edge offer a
 * "Save as" window (File System Access API) that we open straight on the
 * Desktop, but they refuse it for pages opened from disk (file://), which is
 * how EchoText runs. There the MP3 is a normal download into the browser's
 * download folder — set that folder to the Desktop once (see
 * copyDownloadSettings) and every MP3 lands on the Desktop by itself.
 *
 * Usage (prepare MUST run directly from a click — browsers require a user gesture):
 *   const target = await App.FileSaver.prepare('voice.mp3'); // throws AbortError if the user cancels
 *   …build the blob…
 *   App.FileSaver.announce(await App.FileSaver.commit(target, blob), target);
 */
(function (App) {
  'use strict';

  const MP3 = { description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } };
  const TYPES = {
    mp3: MP3,
    wav: { description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } },
    zip: { description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } },
  };
  const TIP_KEY = 'desktopTipDone'; // the user has seen how to make the download folder the Desktop

  const isFileProtocol = () => window.location.protocol === 'file:';
  const hasPicker = () => typeof window.showSaveFilePicker === 'function' && window.isSecureContext && window.self === window.top;

  const FileSaver = {
    /** True when this page can show a Save window (never when opened as a file). */
    supported() {
      return hasPicker() && !isFileProtocol();
    },

    /** The browser's download settings page: { browser, url }. */
    downloadSettings() {
      return /\bEdg\//.test(navigator.userAgent)
        ? { browser: 'Edge', url: 'edge://settings/downloads' }
        : { browser: 'Chrome', url: 'chrome://settings/downloads' };
    },

    /**
     * Pages can't open the browser's settings, so this copies the address and says
     * what to change there to make downloads land on the Desktop.
     */
    async copyDownloadSettings() {
      const { browser, url } = this.downloadSettings();
      App.storage.set(TIP_KEY, true);
      let copied = true;
      try {
        await App.utils.copyToClipboard(url);
      } catch {
        copied = false;
      }
      App.toast.info(
        App.t(copied ? 'Link copied' : 'Open your download settings'),
        App.t(copied
          ? 'Paste {url} into the address bar. Next to Location, choose Change and pick Desktop, and keep “Ask where to save each file” off. {browser} then saves every download on your Desktop.'
          : 'Type {url} into the address bar. Next to Location, choose Change and pick Desktop, and keep “Ask where to save each file” off. {browser} then saves every download on your Desktop.', { url, browser }),
        { duration: 15000 }
      );
    },

    /**
     * Opens the Save window on the Desktop (when this page can).
     * Resolves to a target for commit(); rejects with an AbortError only if the user cancels.
     */
    async prepare(filename) {
      if (!this.supported()) return { filename, handle: null };
      try {
        const type = TYPES[filename.split('.').pop().toLowerCase()] || MP3;
        const handle = await window.showSaveFilePicker({ suggestedName: filename, startIn: 'desktop', types: [type] });
        return { filename: handle.name, handle };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        console.warn('[EchoText] Save window unavailable, using a normal download.', err);
        return { filename, handle: null };
      }
    },

    /** Writes the blob to the chosen file, or downloads it. Returns 'saved' or 'downloaded'. */
    async commit(target, blob) {
      if (target.handle) {
        const writable = await target.handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'saved';
      }
      App.utils.downloadBlob(blob, target.filename);
      return 'downloaded';
    },

    /** Tells the user where the file went (and, until they've seen it, how to make that the Desktop). */
    announce(result, target, extra = '') {
      const tail = extra ? ` ${extra}` : '';
      if (result === 'saved') {
        App.toast.success(App.t('File saved'), `${App.t('{name} was saved where you chose.', { name: target.filename })}${tail}`);
        return;
      }
      if (App.storage.get(TIP_KEY, false)) {
        App.toast.success(App.t('File downloaded'), `${target.filename}${tail}`);
        return;
      }
      App.toast.success(App.t('File downloaded'), `${App.t('{name} is in your browser’s download folder.', { name: target.filename })}${tail}`, {
        action: { label: App.t('Use Desktop'), onClick: () => this.copyDownloadSettings() },
      });
    },
  };

  App.FileSaver = FileSaver;
})(window.VoiceAI = window.VoiceAI || {});
