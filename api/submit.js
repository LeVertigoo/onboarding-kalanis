// api/submit.js — Vercel Serverless Function
// Reçoit le formulaire (multipart), génère le PDF via Browserless,
// upload sur Supabase Storage, forward vers n8n

const { createClient } = require('@supabase/supabase-js');
const { generatePDFHtml } = require('./pdf-template');

// ── CONFIG ────────────────────────────────────────────────────────────────
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BROWSERLESS_TOKEN    = process.env.BROWSERLESS_TOKEN;
const N8N_WEBHOOK_URL      = process.env.N8N_WEBHOOK_URL;
const SUPABASE_BUCKET      = 'onboarding-files';

// ── PARSER MULTIPART ──────────────────────────────────────────────────────
function splitBuffer(buffer, delimiter) {
  const result = [];
  let start = 0;
  let pos = buffer.indexOf(delimiter, start);
  while (pos !== -1) {
    const part = buffer.slice(start, pos);
    if (part.length > 2) result.push(part.slice(2));
    start = pos + delimiter.length;
    pos = buffer.indexOf(delimiter, start);
  }
  return result;
}

async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return reject(new Error('No boundary found'));

    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const fields = {};
      const files = {};
      const delimiter = Buffer.from('--' + boundary);
      const parts = splitBuffer(body, delimiter);

      for (const part of parts) {
        if (!part || part.length === 0) continue;
        const doubleCRLF = part.indexOf('\r\n\r\n');
        if (doubleCRLF === -1) continue;

        const headerStr = part.slice(0, doubleCRLF).toString('utf8');
        const content = part.slice(doubleCRLF + 4);
        const data = content.slice(0, content.length - 2);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

        if (!nameMatch) continue;
        const name = nameMatch[1];

        if (filenameMatch) {
          files[name] = {
            filename: filenameMatch[1],
            mimetype: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream',
            data,
          };
        } else {
          fields[name] = data.toString('utf8');
        }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// ── UPLOAD SUPABASE ───────────────────────────────────────────────────────
async function uploadToSupabase(supabase, fileBuffer, filename, mimetype, folder) {
  const path = folder + '/' + Date.now() + '-' + filename;
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, fileBuffer, { contentType: mimetype, upsert: false });

  if (error) throw new Error('Supabase upload error: ' + error.message);

  const { data: urlData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(path);

  return urlData.publicUrl;
}

// ── GÉNÉRATION PDF via Browserless ───────────────────────────────────────
async function generatePDFViaBrowserless(htmlContent) {
  const url = 'https://chrome.browserless.io/pdf?token=' + BROWSERLESS_TOKEN;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: htmlContent,
      options: {
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      },
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: 25000,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Browserless error ' + response.status + ': ' + errText);
  }

  const pdfBuffer = await response.arrayBuffer();
  return Buffer.from(pdfBuffer);
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 1. Parser le formulaire
    const { fields, files } = await parseMultipart(req);
    let answers = {};
    if (fields.answers) {
      try { answers = JSON.parse(fields.answers); } catch(e) {}
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const clientSlug = (answers.name || 'client')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const dateSlug = new Date().toISOString().slice(0, 10);
    const folder = clientSlug + '-' + dateSlug;

    // 2. Upload photo
    let photoUrl = null;
    if (files.photo) {
      photoUrl = await uploadToSupabase(
        supabase, files.photo.data, files.photo.filename, files.photo.mimetype, folder
      );
    }

    // 3. Générer le PDF
    const htmlContent = generatePDFHtml(answers, photoUrl);
    const pdfBuffer = await generatePDFViaBrowserless(htmlContent);

    // 4. Upload PDF
    const pdfFilename = 'onboarding-' + clientSlug + '-' + dateSlug + '.pdf';
    const pdfUrl = await uploadToSupabase(
      supabase, pdfBuffer, pdfFilename, 'application/pdf', folder
    );

    // 5. Sauvegarder dans Supabase
    await supabase.from('onboarding_responses').insert({
      client_name: answers.name || null,
      linkedin_url: answers.linkedin_url || null,
      submitted_at: new Date().toISOString(),
      answers,
      pdf_url: pdfUrl,
      photo_url: photoUrl,
    });

    // 6. Forward vers n8n
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'kalanis-onboarding-form',
          submitted_at: new Date().toISOString(),
          ...answers,
          pdf_url: pdfUrl,
          photo_url: photoUrl,
          pdf_filename: pdfFilename,
        }),
      });
    }

    return res.status(200).json({ ok: true, pdf_url: pdfUrl, photo_url: photoUrl });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
