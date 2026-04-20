// api/submit.js — Vercel Serverless Function
// Reçoit le formulaire (multipart), génère le PDF, upload sur Supabase, forward vers n8n

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
const { generatePDFHtml } = require('./pdf-template');

// ── CONFIG (variables d'environnement Vercel) ──────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const N8N_WEBHOOK_URL     = process.env.N8N_WEBHOOK_URL;
const SUPABASE_BUCKET     = 'onboarding-files'; // nom du bucket à créer dans Supabase

// ── HELPER : parser le multipart/form-data manuellement ───────────────────
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

      const delimiter = Buffer.from(`--${boundary}`);
      const parts = splitBuffer(body, delimiter);

      for (const part of parts) {
        if (!part || part.length === 0) continue;

        const doubleCRLF = part.indexOf('\r\n\r\n');
        if (doubleCRLF === -1) continue;

        const headerStr = part.slice(0, doubleCRLF).toString('utf8');
        const content = part.slice(doubleCRLF + 4);

        // Enlever le CRLF final
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
            data: data,
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

function splitBuffer(buffer, delimiter) {
  const result = [];
  let start = 0;
  let pos = buffer.indexOf(delimiter, start);

  while (pos !== -1) {
    const part = buffer.slice(start, pos);
    if (part.length > 2) {
      // Enlever le CRLF avant le délimiteur
      result.push(part.slice(2));
    }
    start = pos + delimiter.length;
    pos = buffer.indexOf(delimiter, start);
  }

  return result;
}

// ── HELPER : upload fichier vers Supabase Storage ─────────────────────────
async function uploadToSupabase(supabase, fileBuffer, filename, mimetype, folder) {
  const path = `${folder}/${Date.now()}-${filename}`;

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, fileBuffer, {
      contentType: mimetype,
      upsert: false,
    });

  if (error) throw new Error(`Supabase upload error: ${error.message}`);

  const { data: urlData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(path);

  return urlData.publicUrl;
}

// ── HELPER : générer le PDF avec Puppeteer ────────────────────────────────
async function generatePDF(htmlContent) {
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 794, height: 1123 },
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });

  const page = await browser.newPage();

  // Charger le HTML + attendre les fonts Google
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

  // Attendre Parkinsans
  await page.evaluateHandle('document.fonts.ready');

  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  await browser.close();
  return pdf;
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — autoriser le domaine du formulaire
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Parser le formulaire multipart
    const { fields, files } = await parseMultipart(req);

    // Désérialiser les answers (envoyées en JSON string dans un champ)
    let answers = {};
    if (fields.answers) {
      try { answers = JSON.parse(fields.answers); } catch(e) {}
    }

    // Init Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Créer un slug propre pour le dossier client
    const clientSlug = (answers.name || 'client')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const dateSlug = new Date().toISOString().slice(0, 10);
    const folder = `${clientSlug}-${dateSlug}`;

    // 2. Upload photo si présente
    let photoUrl = null;
    if (files.photo) {
      photoUrl = await uploadToSupabase(
        supabase,
        files.photo.data,
        files.photo.filename,
        files.photo.mimetype,
        folder
      );
    }

    // 3. Générer le PDF (HTML → Puppeteer → PDF)
    const htmlContent = generatePDFHtml(answers, photoUrl);
    const pdfBuffer = await generatePDF(htmlContent);

    // 4. Upload le PDF sur Supabase
    const pdfFilename = `onboarding-${clientSlug}-${dateSlug}.pdf`;
    const pdfUrl = await uploadToSupabase(
      supabase,
      pdfBuffer,
      pdfFilename,
      'application/pdf',
      folder
    );

    // 5. Sauvegarder les réponses dans Supabase (table onboarding_responses)
    await supabase
      .from('onboarding_responses')
      .insert({
        client_name: answers.name || null,
        linkedin_url: answers.linkedin_url || null,
        submitted_at: new Date().toISOString(),
        answers: answers,
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

    // 7. Retourner succès + URL du PDF au formulaire (pour téléchargement client)
    return res.status(200).json({
      ok: true,
      pdf_url: pdfUrl,
      photo_url: photoUrl,
    });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Désactiver le body parser Vercel (on parse manuellement le multipart)
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
