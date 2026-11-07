/**
 * EchoText — ZIP files (no library)
 *
 *   App.Zip.create([{ name, blob }])  → Blob (application/zip), files stored uncompressed.
 *   App.Zip.read(blob)                → Map(name → { blob(): Promise<Blob>, size }) for reading
 *                                       .docx files; inflates with DecompressionStream.
 */
(function (App) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, crc = 0xffffffff) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  /** DOS date and time for the ZIP headers. */
  function dosTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  async function create(entries, { date = new Date() } = {}) {
    const encoder = new TextEncoder();
    const { time, day } = dosTime(date);
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = new Uint8Array(await entry.blob.arrayBuffer());
      const crc = (crc32(data) ^ 0xffffffff) >>> 0;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, data);

      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, 0x0800, true);
      record.setUint16(10, 0, true);
      record.setUint16(12, time, true);
      record.setUint16(14, day, true);
      record.setUint32(16, crc, true);
      record.setUint32(20, data.length, true);
      record.setUint32(24, data.length, true);
      record.setUint16(28, name.length, true);
      record.setUint32(42, offset, true);
      central.push(record.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + (part.byteLength ?? part.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error(App.t('This browser can’t open Word files. Update it, or save the document as .txt.'));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).blob();
  }

  async function read(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(App.t('This file isn’t a valid document.'));
    const count = view.getUint16(end + 10, true);
    let pos = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(pos, true) !== 0x02014b50) throw new Error(App.t('This file isn’t a valid document.'));
      const method = view.getUint16(pos + 10, true);
      const compressed = view.getUint32(pos + 20, true);
      const size = view.getUint32(pos + 24, true);
      const nameLength = view.getUint16(pos + 28, true);
      const extra = view.getUint16(pos + 30, true);
      const comment = view.getUint16(pos + 32, true);
      const local = view.getUint32(pos + 42, true);
      const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
      pos += 46 + nameLength + extra + comment;
      files.set(name, {
        size,
        blob() {
          const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
          const data = bytes.subarray(start, start + compressed);
          if (method === 0) return Promise.resolve(new Blob([data]));
          if (method === 8) return inflate(data);
          return Promise.reject(new Error(App.t('This document uses a compression EchoText can’t read.')));
        },
      });
    }
    return files;
  }

  App.Zip = { create, read, crc32: (bytes) => (crc32(bytes) ^ 0xffffffff) >>> 0 };
})(window.VoiceAI = window.VoiceAI || {});
