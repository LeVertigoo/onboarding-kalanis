// api/submit.js — Vercel Serverless Function
// 1. Parse le formulaire multipart
// 2. Upload photo → Supabase Storage
// 3. Génère fichier HTML brandé → Supabase Storage
// 4. Sauvegarde dans Supabase
// 5. Forward vers n8n (qui gère tout Notion)

const { createClient } = require('@supabase/supabase-js');
const { generateHTML }  = require('./html-template');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const N8N_WEBHOOK_URL      = process.env.N8N_WEBHOOK_URL;
const SUPABASE_BUCKET      = 'onboarding-files';

// ── MULTIPART PARSER ──────────────────────────────────────────────────────
function splitBuffer(buf, delim) {
  const parts = [];
  let start = 0, pos = buf.indexOf(delim, start);
  while (pos !== -1) {
    const part = buf.slice(start, pos);
    if (part.length > 2) parts.push(part.slice(2));
    start = pos + delim.length;
    pos = buf.indexOf(delim, start);
  }
  return parts;
}

async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return reject(new Error('No boundary'));
    const boundary = bm[1];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const fields = {}, files = {};
      const delim = Buffer.from('--' + boundary);
      for (const part of splitBuffer(body, delim)) {
        if (!part.length) continue;
        const sep = part.indexOf('\r\n\r\n');
        if (sep === -1) continue;
        const header = part.slice(0, sep).toString('utf8');
        const data   = part.slice(sep + 4, part.length - 2);
        const nm = header.match(/name="([^"]+)"/);
        const fm = header.match(/filename="([^"]+)"/);
        const mm = header.match(/Content-Type:\s*([^\r\n]+)/i);
        if (!nm) continue;
        if (fm) {
          files[nm[1]] = { filename: fm[1], mimetype: mm ? mm[1].trim() : 'application/octet-stream', data };
        } else {
          fields[nm[1]] = data.toString('utf8');
        }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// ── SUPABASE UPLOAD ───────────────────────────────────────────────────────
async function uploadToSupabase(supabase, buffer, filename, mimetype, folder) {
  const path = folder + '/' + Date.now() + '-' + filename;
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, { contentType: mimetype, upsert: false });
  if (error) throw new Error('Supabase: ' + error.message);
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── HANDLER ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fields, files } = await parseMultipart(req);
    let answers = {};
    if (fields.answers) try { answers = JSON.parse(fields.answers); } catch(e) {}

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const slug = (answers.name || 'client')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const date = new Date().toISOString().slice(0, 10);
    const folder = slug + '-' + date;

    // 1. Upload photo
    let photoUrl = null;
    if (files.photo) {
      photoUrl = await uploadToSupabase(
        supabase, files.photo.data, files.photo.filename, files.photo.mimetype, folder
      );
    }

    // 2. Générer + upload fichier HTML brandé
    const htmlContent  = generateHTML(answers, photoUrl);
    const htmlBuffer   = Buffer.from(htmlContent, 'utf-8');
    const htmlFilename = 'onboarding-' + slug + '-' + date + '.html';
    const htmlUrl      = await uploadToSupabase(
      supabase, htmlBuffer, htmlFilename, 'text/html; charset=utf-8', folder
    );

    // 3. Sauvegarder dans Supabase
    await supabase.from('onboarding_responses').insert({
      client_name:  answers.name || null,
      linkedin_url: answers.linkedin_url || null,
      submitted_at: new Date().toISOString(),
      answers,
      html_url:  htmlUrl,
      photo_url: photoUrl,
    });

    // 4. Forward vers n8n — c'est n8n qui gère tout Notion
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source:       'kalanis-onboarding-form',
          submitted_at: new Date().toISOString(),
          ...answers,
          html_url:     htmlUrl,
          photo_url:    photoUrl,
          html_filename: htmlFilename,
        }),
      });
    }

    return res.status(200).json({ ok: true, html_url: htmlUrl });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
