/**
 * EchoText — Document import
 *
 *   App.DocumentImport.extract(file, { onProgress }) → { text, kind, pages?, warnings: [] }
 *
 * .txt   read as UTF-8.
 * .docx  the ZIP is opened in the browser (core/zip.js) and word/document.xml's
 *        paragraphs, tables and text boxes become paragraphs separated by blank lines.
 * .pdf   text-based PDFs only, read with pdf.js (Mozilla, Apache-2.0, assets/vendor),
 *        which is loaded the first time a PDF is opened. Lines are joined back into
 *        paragraphs; scanned PDFs (images of text) have nothing to read.
 * Nothing is uploaded anywhere: files are read on this device.
 */
(function (App) {
  'use strict';

  const t = (text, params) => App.t(text, params);
  const PDF_SRC = 'assets/vendor/pdf.min.js'; // pdf.js 3.11.174, the last release with classic scripts
  const PDF_WORKER_SRC = 'assets/vendor/pdf.worker.min.js';
  const KHMER = /[ក-៿]/;

  const ACCEPT = [
    '.txt', '.docx', '.pdf', 'text/plain', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ].join(',');

  function kindOf(file) {
    const name = String(file && file.name || '').toLowerCase();
    const type = String(file && file.type || '').toLowerCase();
    if (/\.txt$/.test(name) || type === 'text/plain') return 'txt';
    if (/\.docx$/.test(name) || type.includes('wordprocessingml')) return 'docx';
    if (/\.pdf$/.test(name) || type === 'application/pdf') return 'pdf';
    if (/\.doc$/.test(name) || type === 'application/msword') return 'doc';
    return null;
  }

  const fail = (message, code) => Object.assign(new Error(message), { code });

  /** Blank lines between paragraphs, no stray spaces, Windows line ends gone. */
  function tidy(text) {
    return String(text)
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ---------- .docx ---------- */

  const SKIP = new Set(['pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'sectPr', 'instrText', 'delText', 'fldChar', 'Fallback', 'footnoteReference', 'endnoteReference', 'commentReference']);

  function docxText(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw fail(t('This Word file is damaged and can’t be read.'), 'damaged');
    const paragraphs = [];
    let current = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        const name = child.localName;
        if (SKIP.has(name)) continue;
        if (name === 't') current += child.textContent;
        else if (name === 'tab') current += '\t';
        else if (name === 'br' || name === 'cr') current += '\n';
        else if (name === 'noBreakHyphen') current += '-';
        else if (name === 'p') {
          const outer = current;
          current = '';
          walk(child);
          if (current.trim()) paragraphs.push(current.replace(/[ \t]+/g, ' ').trim());
          current = outer;
        } else walk(child);
      }
    };
    const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
    walk(body);
    return paragraphs.join('\n\n');
  }

  async function readDocx(file) {
    let files;
    try {
      files = await App.Zip.read(file);
    } catch (err) {
      throw fail(t('This Word file is damaged and can’t be read.'), 'damaged');
    }
    const main = files.get('word/document.xml');
    if (!main) throw fail(t('This file isn’t a Word document (.docx).'), 'not_docx');
    const xml = await (await main.blob()).text();
    return { text: docxText(xml), warnings: [] };
  }

  /* ---------- .pdf ---------- */

  let pdfPromise = null;

  function runScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        reject(new Error(`${src} couldn’t be loaded.`));
      };
      document.head.appendChild(script);
    });
  }

  /** pdf.js, running on this page: Chrome won't start workers for pages opened from disk. */
  function loadPdf() {
    if (!pdfPromise) {
      pdfPromise = (async () => {
        if (!window.pdfjsWorker) await runScript(PDF_WORKER_SRC);
        if (!window.pdfjsLib) await runScript(PDF_SRC);
        if (!window.pdfjsLib || !window.pdfjsWorker) throw new Error(t('The PDF reader couldn’t start.'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        return window.pdfjsLib;
      })();
      pdfPromise.catch(() => {
        pdfPromise = null;
      });
    }
    return pdfPromise;
  }

  /** Joins two wrapped lines of one paragraph. */
  function joinLines(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // hyphenated at the line end
    const last = a[a.length - 1];
    const first = b[0];
    if (KHMER.test(last) && KHMER.test(first)) return a + b; // Khmer has no spaces between words
    return `${a.replace(/\s+$/, '')} ${b.replace(/^\s+/, '')}`;
  }

  /** Lines → paragraphs: a gap clearly taller than a line starts a new paragraph. */
  function pageText(items) {
    const lines = [];
    let line = { text: '', y: null, height: 0 };
    const finish = () => {
      if (line.text.trim()) lines.push({ ...line, text: line.text.trim() });
      line = { text: '', y: null, height: 0 };
    };
    for (const item of items) {
      if (!('str' in item)) continue; // marked-content markers
      const y = item.transform ? item.transform[5] : null;
      if (line.y !== null && y !== null && Math.abs(y - line.y) > Math.max(item.height || 0, line.height || 0) * 0.6 && line.text.trim()) finish();
      if (line.y === null) line.y = y;
      line.height = Math.max(line.height, item.height || 0);
      line.text += item.str;
      if (item.hasEOL) finish();
    }
    finish();

    const paragraphs = [];
    let current = '';
    lines.forEach((l, i) => {
      const prev = lines[i - 1];
      const gap = prev && prev.y !== null && l.y !== null ? prev.y - l.y : 0;
      const height = Math.max(l.height, prev ? prev.height : 0) || 12;
      // A tall gap, or a jump back up the page (the next column), starts a new paragraph.
      const newParagraph = prev && (gap > height * 1.7 || gap < -height);
      if (newParagraph) {
        paragraphs.push(current);
        current = l.text;
      } else current = joinLines(current, l.text);
    });
    if (current) paragraphs.push(current);
    return paragraphs.join('\n\n');
  }

  async function readPdf(file, onProgress) {
    const pdfjs = await loadPdf();
    const data = new Uint8Array(await file.arrayBuffer());
    let doc;
    try {
      doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true, useWorkerFetch: false, stopAtErrors: false }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw fail(t('This PDF is password-protected. Remove the password, then try again.'), 'password');
      throw fail(t('This PDF is damaged and can’t be read.'), 'damaged');
    }
    try {
      const pages = [];
      for (let n = 1; n <= doc.numPages; n++) {
        if (onProgress) onProgress({ page: n, pages: doc.numPages });
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        pages.push(pageText(content.items));
        page.cleanup();
      }
      const text = pages.filter((p) => p.trim()).join('\n\n');
      const warnings = [];
      if (!text.trim()) {
        throw fail(t('This PDF has no text to read. It may be a scanned image; use a PDF with selectable text, or copy the text in.'), 'no_text');
      }
      const broken = (text.match(/[�-]/g) || []).length;
      if (broken > 3) warnings.push(t('Some characters couldn’t be read from this PDF. Check the text before generating.'));
      if (KHMER.test(text)) warnings.push(t('Khmer text from PDFs can come out in the wrong order. Check the preview carefully.'));
      return { text, pages: doc.numPages, warnings };
    } finally {
      doc.destroy();
    }
  }

  /* ---------- Public API ---------- */

  async function extract(file, { onProgress } = {}) {
    const kind = kindOf(file);
    if (kind === 'doc') throw fail(t('Old Word files (.doc) can’t be read. Save it as .docx or .pdf first.'), 'unsupported');
    if (!kind) throw fail(t('Choose a .txt, .docx or .pdf file.'), 'unsupported');
    const limit = App.config.maxFileBytes[kind];
    if (file.size > limit) throw fail(t('Choose a file under {size}.', { size: App.utils.formatBytes(limit) }), 'too_large');
    let result;
    if (kind === 'txt') {
      try {
        result = { text: await file.text(), warnings: [] };
      } catch {
        throw fail(t('The file may be damaged or use an unsupported encoding.'), 'damaged');
      }
    } else if (kind === 'docx') result = await readDocx(file);
    else result = await readPdf(file, onProgress);
    const text = tidy(result.text);
    if (!text) throw fail(t('{name} doesn’t contain any text.', { name: file.name }), 'empty');
    return { ...result, text, kind, name: file.name };
  }

  App.DocumentImport = { ACCEPT, kindOf, extract, docxText, pageText, joinLines };
})(window.VoiceAI = window.VoiceAI || {});
