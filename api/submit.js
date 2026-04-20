// api/submit.js — Vercel Serverless Function
// 1. Parse le formulaire multipart
// 2. Upload photo → Supabase Storage
// 3. Génère fichier HTML brandé → Supabase Storage
// 4. Crée une page Notion avec les réponses structurées
// 5. Forward vers n8n (JSON + URLs)

const { createClient } = require('@supabase/supabase-js');
const { generateHTML }  = require('./html-template');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const N8N_WEBHOOK_URL      = process.env.N8N_WEBHOOK_URL;
const NOTION_TOKEN         = process.env.NOTION_TOKEN;
const NOTION_DB_ID         = process.env.NOTION_DB_ID; // ID de la database "Client" dans le hub équipe
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

// ── NOTION : créer une page avec les réponses ─────────────────────────────
const OPTION_LABELS = {
  setting_xp:      { oui_souvent:'Oui, souvent', oui_peu:'Oui, mais peu souvent', non:'Non, jamais' },
  main_blocker:    { volume:'Le volume', qualite:'La qualité des réponses', booking:"Le passage à l'appel", pas_clair:'Pas encore clair' },
  manages_convos:  { oui:'Oui, je gère tout', non:"Non, j'ai quelqu'un" },
  has_followups:   { oui:'Oui — séquence de relance', non:'Non — je passe au suivant', parfois:'Parfois, non structuré' },
  outreach_method: { dm_froid:'DM à froid', commentaires:'Commentaires sur les posts', connexions:'Demandes de connexion + message', inmail:'InMail (Sales Nav)', autre:'Autre' },
  ma_selection:    { site:'Site web', calendly:'Calendly / prise de RDV', lead:'Lead magnet / ressource gratuite', autre:'Autre' },
  has_brand:       { oui:'Oui — identité visuelle existante', non:'Non, on part de zéro' },
};

function displayValue(id, val) {
  if (!val && val !== 0) return null;
  if (Array.isArray(val)) {
    if (!val.length) return null;
    const m = OPTION_LABELS[id] || {};
    return val.map(v => m[v] || v).join(', ');
  }
  const m = OPTION_LABELS[id];
  if (m) return m[val] || val;
  return String(val).trim() || null;
}

const SECTIONS = [
  {
    key: 'PRÉSENTATION', label: '01 — Présentation',
    questions: [
      { id:'name',         label:'Nom complet' },
      { id:'linkedin_url', label:'Profil LinkedIn' },
      { id:'bio',          label:'Qui es-tu et que fais-tu ?' },
      { id:'distinctive',  label:'Ce qui te définit au quotidien' },
    ],
  },
  {
    key: 'TON OFFRE', label: '02 — Ton offre',
    questions: [
      { id:'offer',      label:'Ton offre' },
      { id:'promise',    label:"Promesse de l'offre" },
      { id:'icp',        label:'Client idéal (ICP)' },
      { id:'icp_detail', label:'Âge, domaine, revenus' },
    ],
  },
  {
    key: 'ACQUISITION', label: '03 — Acquisition',
    questions: [
      { id:'setting_xp',      label:'Expérience setting' },
      { id:'setting_results', label:'Résultats setting' },
      { id:'prospects_week',  label:'Prospects / semaine' },
      { id:'outreach_method', label:'Méthode de contact' },
      { id:'response_rate',   label:'Taux de réponse' },
      { id:'rdv_week',        label:'RDV générés / semaine' },
      { id:'main_blocker',    label:'Principal blocage' },
      { id:'manages_convos',  label:'Gestion des conversations' },
      { id:'has_followups',   label:'Relances en place' },
      { id:'rdv_target',      label:'Objectif RDV / semaine' },
    ],
  },
  {
    key: 'PROFIL & IDENTITÉ', label: '04 — Profil & identité',
    questions: [
      { id:'banner_content', label:'Contenu bannière LinkedIn' },
      { id:'social_proof',   label:'Preuve sociale' },
      { id:'ma_selection',   label:'Section Ma sélection' },
      { id:'link_site',      label:'Site web' },
      { id:'link_calendly',  label:'Calendly' },
      { id:'link_lead',      label:'Lead magnet' },
      { id:'link_autre_sel', label:'Autre lien sélection' },
      { id:'has_brand',      label:'Identité visuelle' },
      { id:'brand_link',     label:'Charte graphique' },
      { id:'color_prefs',    label:'Couleurs & univers' },
      { id:'inspirations',   label:'Inspirations visuelles' },
    ],
  },
  {
    key: 'OBJECTIFS', label: '05 — Objectifs',
    questions: [
      { id:'objective',  label:'Objectif à 3 mois' },
      { id:'free_field', label:'Champ libre' },
    ],
  },
];

function buildNotionBlocks(answers, htmlUrl, photoUrl) {
  const blocks = [];

  // Callout intro
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: 'Formulaire d\'onboarding complété — La Méthode Kalanis™' } }],
      icon: { emoji: '✅' },
      color: 'blue_background',
    },
  });

  // Lien vers le fichier HTML
  if (htmlUrl) {
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: '📄 Fichier onboarding complet : ' } },
          { type: 'text', text: { content: htmlUrl, link: { url: htmlUrl } },
            annotations: { color: 'blue', underline: true } },
        ],
      },
    });
  }

  if (photoUrl) {
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: '📸 Photo de profil : ' } },
          { type: 'text', text: { content: photoUrl, link: { url: photoUrl } },
            annotations: { color: 'blue', underline: true } },
        ],
      },
    });
  }

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Une section par thème
  for (const section of SECTIONS) {
    const filled = section.questions.filter(q => displayValue(q.id, answers[q.id]) !== null);
    if (!filled.length) continue;

    // Heading de section
    blocks.push({
      object: 'block', type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: section.label } }],
        color: 'blue',
      },
    });

    for (const q of filled) {
      const val = displayValue(q.id, answers[q.id]);
      if (!val) continue;

      // Label en gras + valeur
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: q.label + ' : ' },
              annotations: { bold: true, color: 'gray' } },
            { type: 'text', text: { content: val } },
          ],
        },
      });
    }

    blocks.push({ object: 'block', type: 'divider', divider: {} });
  }

  return blocks;
}

async function createNotionPage(answers, htmlUrl, photoUrl) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) return null;

  const clientName = answers.name || 'Nouveau client';
  const blocks = buildNotionBlocks(answers, htmlUrl, photoUrl);

  // Notion API : max 100 blocs par requête
  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + NOTION_TOKEN,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ID },
      icon: { emoji: '📋' },
      properties: {
        // Titre de la page dans la database
        Name: { title: [{ text: { content: 'Onboarding — ' + clientName } }] },
      },
      children: blocks.slice(0, 100),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Notion: ' + err);
  }

  const page = await response.json();

  // Si plus de 100 blocs, append le reste
  if (blocks.length > 100) {
    await fetch('https://api.notion.com/v1/blocks/' + page.id + '/children', {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + NOTION_TOKEN,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ children: blocks.slice(100) }),
    });
  }

  return page.url;
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
      photoUrl = await uploadToSupabase(supabase, files.photo.data, files.photo.filename, files.photo.mimetype, folder);
    }

    // 2. Générer + upload fichier HTML
    const htmlContent = generateHTML(answers, photoUrl);
    const htmlBuffer  = Buffer.from(htmlContent, 'utf-8');
    const htmlFilename = 'onboarding-' + slug + '-' + date + '.html';
    const htmlUrl = await uploadToSupabase(supabase, htmlBuffer, htmlFilename, 'text/html; charset=utf-8', folder);

    // 3. Créer la page Notion
    const notionUrl = await createNotionPage(answers, htmlUrl, photoUrl);

    // 4. Sauvegarder dans Supabase
    await supabase.from('onboarding_responses').insert({
      client_name: answers.name || null,
      linkedin_url: answers.linkedin_url || null,
      submitted_at: new Date().toISOString(),
      answers,
      html_url: htmlUrl,
      photo_url: photoUrl,
      notion_url: notionUrl,
    });

    // 5. Forward n8n
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'kalanis-onboarding-form',
          submitted_at: new Date().toISOString(),
          ...answers,
          html_url: htmlUrl,
          photo_url: photoUrl,
          notion_url: notionUrl,
          html_filename: htmlFilename,
        }),
      });
    }

    return res.status(200).json({ ok: true, html_url: htmlUrl, notion_url: notionUrl });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
