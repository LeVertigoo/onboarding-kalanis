// Template HTML → PDF — DA Kalanis complète
// Rendu par Puppeteer côté serveur → PDF pixel-perfect

const SECTION_LABELS = {
  'PRÉSENTATION':      '01 — Présentation',
  'TON OFFRE':         '02 — Ton offre',
  'ACQUISITION':       '03 — Acquisition',
  'PROFIL & IDENTITÉ': '04 — Profil & identité',
  'OBJECTIFS':         '05 — Objectifs',
};

const SECTIONS_ORDER = [
  'PRÉSENTATION',
  'TON OFFRE',
  'ACQUISITION',
  'PROFIL & IDENTITÉ',
  'OBJECTIFS',
];

// Map val → label pour les questions à choix
const OPTION_LABELS = {
  setting_xp: {
    oui_souvent: 'Oui — souvent',
    oui_peu:     'Oui — mais pas souvent',
    non:         'Non — jamais',
  },
  main_blocker: {
    volume:    'Le volume',
    qualite:   'La qualité des réponses',
    booking:   "Le passage à l'appel",
    pas_clair: 'Pas encore clair pour moi',
  },
  manages_convos: {
    oui: 'Oui, je gère tout',
    non: "Non, j'ai quelqu'un",
  },
  has_followups: {
    oui:     'Oui — une séquence de relance',
    non:     'Non — je passe au suivant',
    parfois: 'Parfois — non structuré',
  },
  outreach_method: {
    dm_froid:     'DM à froid',
    commentaires: 'Commentaires sur les posts',
    connexions:   'Demandes de connexion + message',
    inmail:       'InMail (Sales Nav)',
    autre:        'Autre',
  },
  ma_selection: {
    site:     'Site web',
    calendly: 'Calendly / prise de RDV',
    lead:     'Lead magnet / ressource gratuite',
    autre:    'Autre',
  },
  has_brand: {
    oui: 'Oui — identité visuelle existante',
    non: 'Non, on part de zéro',
  },
};

function displayValue(id, val) {
  if (!val && val !== 0) return null;
  if (Array.isArray(val)) {
    if (val.length === 0) return null;
    const map = OPTION_LABELS[id] || {};
    return val.map(v => map[v] || v).join(', ');
  }
  const map = OPTION_LABELS[id];
  if (map) return map[val] || val;
  return String(val).trim() || null;
}

// Questions par section dans l'ordre du formulaire
const QUESTIONS_META = [
  { id: 'name',           section: 'PRÉSENTATION',      label: 'Nom complet' },
  { id: 'linkedin_url',   section: 'PRÉSENTATION',      label: 'Profil LinkedIn' },
  { id: 'bio',            section: 'PRÉSENTATION',      label: 'Qui es-tu et que fais-tu ?' },
  { id: 'distinctive',    section: 'PRÉSENTATION',      label: 'Ce qui te définit au quotidien' },
  { id: 'offer',          section: 'TON OFFRE',         label: 'Ton offre' },
  { id: 'promise',        section: 'TON OFFRE',         label: 'La promesse de ton offre' },
  { id: 'icp',            section: 'TON OFFRE',         label: 'Ton client idéal (ICP)' },
  { id: 'icp_detail',     section: 'TON OFFRE',         label: 'Âge, domaine, revenus' },
  { id: 'setting_xp',     section: 'ACQUISITION',       label: 'Expérience setting LinkedIn' },
  { id: 'setting_results',section: 'ACQUISITION',       label: 'Résultats setting actuels' },
  { id: 'prospects_week', section: 'ACQUISITION',       label: 'Prospects contactés / semaine' },
  { id: 'outreach_method',section: 'ACQUISITION',       label: 'Méthode de contact' },
  { id: 'response_rate',  section: 'ACQUISITION',       label: 'Taux de réponse' },
  { id: 'rdv_week',       section: 'ACQUISITION',       label: 'RDV générés / semaine' },
  { id: 'main_blocker',   section: 'ACQUISITION',       label: 'Principal blocage' },
  { id: 'manages_convos', section: 'ACQUISITION',       label: 'Gestion des conversations' },
  { id: 'has_followups',  section: 'ACQUISITION',       label: 'Relances en place' },
  { id: 'rdv_target',     section: 'ACQUISITION',       label: 'Objectif RDV qualifiés / semaine' },
  { id: 'banner_content', section: 'PROFIL & IDENTITÉ', label: 'Contenu bannière LinkedIn' },
  { id: 'social_proof',   section: 'PROFIL & IDENTITÉ', label: 'Preuve sociale' },
  { id: 'ma_selection',   section: 'PROFIL & IDENTITÉ', label: 'Section "Ma sélection"' },
  { id: 'link_site',      section: 'PROFIL & IDENTITÉ', label: 'Lien site web' },
  { id: 'link_calendly',  section: 'PROFIL & IDENTITÉ', label: 'Lien Calendly' },
  { id: 'link_lead',      section: 'PROFIL & IDENTITÉ', label: 'Lien lead magnet' },
  { id: 'link_autre_sel', section: 'PROFIL & IDENTITÉ', label: 'Autre lien sélection' },
  { id: 'has_brand',      section: 'PROFIL & IDENTITÉ', label: 'Identité visuelle existante' },
  { id: 'brand_link',     section: 'PROFIL & IDENTITÉ', label: 'Lien charte graphique' },
  { id: 'color_prefs',    section: 'PROFIL & IDENTITÉ', label: 'Couleurs & univers visuel' },
  { id: 'photo',          section: 'PROFIL & IDENTITÉ', label: 'Photo de profil', isFile: true },
  { id: 'inspirations',   section: 'PROFIL & IDENTITÉ', label: 'Inspirations visuelles' },
  { id: 'objective',      section: 'OBJECTIFS',         label: 'Objectif à 3 mois' },
  { id: 'free_field',     section: 'OBJECTIFS',         label: 'Champ libre' },
];

function buildSectionsHTML(answers, photoUrl) {
  let html = '';

  for (const sectionKey of SECTIONS_ORDER) {
    const qs = QUESTIONS_META.filter(q => q.section === sectionKey);

    // Filtrer les questions vides
    const filled = qs.filter(q => {
      if (q.isFile) return !!photoUrl;
      const val = displayValue(q.id, answers[q.id]);
      return val !== null;
    });

    if (filled.length === 0) continue;

    html += `
      <div class="section">
        <div class="section-pill">${SECTION_LABELS[sectionKey]}</div>
        <div class="cards">
    `;

    for (const q of filled) {
      if (q.isFile && photoUrl) {
        html += `
          <div class="card card--photo">
            <div class="card-label">${q.label}</div>
            <img src="${photoUrl}" alt="Photo de profil" class="photo-preview" />
          </div>
        `;
      } else {
        const val = displayValue(q.id, answers[q.id]);
        if (!val) continue;

        // Détecter les URLs
        const isUrl = val.startsWith('http');
        const displayVal = isUrl
          ? `<a href="${val}" class="url-val">${val}</a>`
          : `<span class="answer-text">${val}</span>`;

        html += `
          <div class="card">
            <div class="card-label">${q.label}</div>
            <div class="card-value">${displayVal}</div>
          </div>
        `;
      }
    }

    html += `</div></div>`;
  }

  return html;
}

function generatePDFHtml(answers, photoUrl) {
  const clientName = answers.name || 'Client';
  const dateStr = new Date().toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const sectionsHTML = buildSectionsHTML(answers, photoUrl);

  // SVG icône Kalanis (inline, couleur crème sur fond bleu)
  const KALANIS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" width="36" height="36">
    <path fill="#FAF9F2" d="M1329.14,1161.24c8.55,0,16.96.65,25.17,1.89-13.62-18.82-28.81-36.66-45.25-53.1-40.11-40.11-86.84-71.61-138.9-93.63-17.31-7.32-34.96-13.47-52.89-18.46l230.68-230.68-152.65-152.65-416.52,416.52v-468.22h-215.87v874.16h215.87v-17.99c0-121.97,99.23-221.21,221.21-221.21,34.93,0,68.36,7.94,99.37,23.61,26.72,13.5,50.78,32.65,70.11,55.67,21.94-67.22,85.21-115.93,159.66-115.93Z"/>
    <path fill="#FAF9F2" d="M1337.94,1221.56c-66.43-5.29-121.68,49.96-116.39,116.39,4.16,52.27,46.51,94.62,98.79,98.79,66.43,5.29,121.68-49.96,116.39-116.39-4.16-52.27-46.51-94.62-98.79-98.79Z"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Onboarding — ${clientName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Parkinsans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:    #FAF9F2;
    --blue:  #018EBB;
    --ink:   #121C28;
    --body:  #2D3748;
    --muted: #718096;
    --r:     12px;
  }

  body {
    font-family: 'Parkinsans', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--ink);
    width: 794px;
    margin: 0;
    padding: 0;
  }

  /* ── HEADER ── */
  .header {
    background: var(--blue);
    padding: 40px 52px 36px;
    position: relative;
    overflow: hidden;
  }

  /* Blobs déco dans le header */
  .header::before {
    content: '';
    position: absolute;
    width: 360px; height: 360px;
    border-radius: 50%;
    background: rgba(255,255,255,0.08);
    top: -120px; right: -80px;
  }
  .header::after {
    content: '';
    position: absolute;
    width: 220px; height: 220px;
    border-radius: 50%;
    background: rgba(255,255,255,0.05);
    bottom: -80px; left: -40px;
  }

  .header-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 24px;
    position: relative;
    z-index: 1;
  }
  .header-brand-text {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(250,249,242,0.7);
  }

  .header-title {
    font-size: 32px;
    font-weight: 800;
    color: #FAF9F2;
    line-height: 1.1;
    margin-bottom: 10px;
    position: relative;
    z-index: 1;
  }

  .header-meta {
    font-size: 13px;
    font-weight: 500;
    color: rgba(250,249,242,0.6);
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .header-meta-dot {
    width: 3px; height: 3px;
    border-radius: 50%;
    background: rgba(250,249,242,0.4);
  }

  /* ── BODY ── */
  .body {
    padding: 40px 52px 52px;
  }

  /* ── SECTION ── */
  .section {
    margin-bottom: 36px;
  }

  .section-pill {
    display: inline-flex;
    align-items: center;
    padding: 6px 14px;
    border-radius: 99px;
    background: var(--blue);
    color: #FAF9F2;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 16px;
  }

  /* ── CARDS ── */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .card {
    background: #FAF9F2;
    border: 1.5px solid rgba(18,28,40,0.08);
    border-radius: var(--r);
    padding: 14px 18px 14px 22px;
    position: relative;
    page-break-inside: avoid;
  }

  /* Trait bleu à gauche */
  .card::before {
    content: '';
    position: absolute;
    left: 0; top: 6px; bottom: 6px;
    width: 3px;
    border-radius: 99px;
    background: var(--blue);
  }

  .card-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 5px;
  }

  .card-value {
    font-size: 13px;
    font-weight: 500;
    color: var(--body);
    line-height: 1.55;
  }

  .url-val {
    color: var(--blue);
    text-decoration: none;
    word-break: break-all;
    font-size: 12px;
  }

  .answer-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── PHOTO CARD ── */
  .card--photo {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .photo-preview {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid rgba(1,142,187,0.2);
  }

  /* ── FOOTER ── */
  .footer {
    background: var(--blue);
    padding: 14px 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .footer-text {
    font-size: 10px;
    font-weight: 600;
    color: rgba(250,249,242,0.6);
    letter-spacing: 0.06em;
  }

  /* Grain overlay via SVG filter */
  .grain-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    opacity: 0.06;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 180px 180px;
    z-index: 999;
  }
</style>
</head>
<body>

<div class="grain-overlay"></div>

<div class="header">
  <div class="header-brand">
    ${KALANIS_ICON_SVG}
    <span class="header-brand-text">La Méthode Kalanis™</span>
  </div>
  <div class="header-title">Formulaire d'onboarding</div>
  <div class="header-meta">
    <span>${clientName}</span>
    <div class="header-meta-dot"></div>
    <span>${dateStr}</span>
  </div>
</div>

<div class="body">
  ${sectionsHTML}
</div>

<div class="footer">
  <span class="footer-text">La Méthode Kalanis™ · kalanis.fr</span>
  <span class="footer-text">${dateStr}</span>
</div>

</body>
</html>`;
}

module.exports = { generatePDFHtml };
