'use strict';

// Vedlegg til kommentarer. Filene ligger på disk ved siden av state.json
// (data/attachments/<avvik-id>/<tilfeldig id>) og kommentaren husker bare
// metadata (id, navn, størrelse) - samme "lokal tilstand"-valg som
// persistence.js: filene overlever en omstart, men ikke en redeploy på Minato,
// der filsystemet er flyktig.
//
// Filene lagres under en tilfeldig id uten brukerens filnavn i stien, og de
// leveres alltid som nedlasting (application/octet-stream + nosniff), så en
// opplastet HTML/SVG-fil aldri kjøres i appens egen origin.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistence = require('./persistence');

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Litt luft over filene for selve skjemafeltene og multipart-rammen.
const MAX_REQUEST_BYTES = MAX_FILES * MAX_FILE_BYTES + 100_000;
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'msg', 'eml', 'zip',
]);

function attachmentsDir() {
  return path.join(path.dirname(persistence.stateFilePath()), 'attachments');
}

// Avvik-id er et tall eller 16 hex-tegn, vedleggs-id en uuid - alt annet er
// aldri noe vi har laget, og skal ikke ende opp i en filsti.
function isSafeSegment(value) {
  return /^[A-Za-z0-9-]{1,64}$/.test(String(value));
}

function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim();
  return cleaned.slice(0, 150) || 'vedlegg';
}

function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// Returnerer en feilmelding (norsk, vises til brukeren) eller null.
function validateFiles(files) {
  if (files.length > MAX_FILES) return `Maks ${MAX_FILES} vedlegg per kommentar.`;
  for (const file of files) {
    const name = cleanFileName(file.name);
    if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) {
      return `Filtypen til «${name}» er ikke tillatt (tillatt: ${[...ALLOWED_EXTENSIONS].join(', ')}).`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `«${name}» er større enn ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
    }
  }
  return null;
}

async function saveFiles(avvikId, files) {
  if (!files.length) return [];
  if (!isSafeSegment(avvikId)) throw new Error('unsafe avvik id');
  const dir = path.join(attachmentsDir(), String(avvikId));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  try {
    for (const file of files) {
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, id), Buffer.from(await file.arrayBuffer()));
      saved.push({ id, name: cleanFileName(file.name), size: file.size });
    }
  } catch (err) {
    removeFiles(avvikId, saved);
    throw err;
  }
  return saved;
}

function filePath(avvikId, attachmentId) {
  if (!isSafeSegment(avvikId) || !isSafeSegment(attachmentId)) return null;
  return path.join(attachmentsDir(), String(avvikId), attachmentId);
}

function removeFiles(avvikId, attachments) {
  for (const att of attachments) {
    const file = filePath(avvikId, att.id);
    if (file) fs.rmSync(file, { force: true });
  }
}

module.exports = {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  ALLOWED_EXTENSIONS,
  cleanFileName,
  validateFiles,
  saveFiles,
  filePath,
  removeFiles,
};
