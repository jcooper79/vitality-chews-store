// Static site generator for vitalitychews.com
// Reads site/data + site/content, writes a fully static site to dist/.
// The Worker (src/worker.js) serves dist/ and handles /api/* routes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');

const site = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'data/site.json'), 'utf8'));
const products = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'data/products.json'), 'utf8'));
const bySlug = Object.fromEntries(products.map((p) => [p.slug, p]));
const BUILD_DATE = new Date().toISOString().slice(0, 10);
const BUILD_ID = Date.now().toString(36); // cache-busting query for CSS/JS

// ---------- helpers ----------
const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (p) => (p.startsWith('http') ? p : site.url + p);
const money = (n) => '$' + Number(n).toFixed(2);
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function inline(md) {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
}

// Minimal markdown: ## / ### headings, paragraphs, - and 1. lists
function markdown(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split(/\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^(#{2,3})\s+(.*)$/))) {
      close();
      const lvl = m[1].length;
      const id = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${lvl} id="${id}">${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^-\s+(.*)$/))) {
      if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('\n');
}

function readMd(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const l of m[1].split('\n')) {
      const i = l.indexOf(':');
      if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return { meta, body: m ? m[2] : src };
}

function write(rel, html) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    e.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
  }
}

// ---------- shared schema ----------
const orgSchema = {
  '@type': 'Organization',
  '@id': site.url + '/#organization',
  name: site.name,
  url: site.url,
  logo: abs(site.logo),
  email: site.email,
  ...(site.social.length ? { sameAs: site.social } : {}),
};
const returnPolicy = {
  '@type': 'MerchantReturnPolicy',
  applicableCountry: 'US',
  returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
  merchantReturnDays: 30,
  returnMethod: 'https://schema.org/ReturnByMail',
  returnFees: 'https://schema.org/ReturnShippingFees',
};
const shippingDetails = (price) => ({
  '@type': 'OfferShippingDetails',
  shippingRate: {
    '@type': 'MonetaryAmount',
    value: price >= site.freeShippingThreshold ? 0 : site.flatShipping,
    currency: 'USD',
  },
  shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
  deliveryTime: {
    '@type': 'ShippingDeliveryTime',
    handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 2, unitCode: 'DAY' },
    transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 7, unitCode: 'DAY' },
  },
});
const breadcrumbs = (items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.url) })),
});

// ---------- images ----------
const IMG_DIR = path.join(SITE_DIR, 'static/img');
// Lifestyle photo from site/static/img/photos (-900 and, when the source was big enough, -1800)
function photo(name, alt, { sizes = '100vw', cls = '', eager = false, w = 900, h = 600 } = {}) {
  const big = fs.existsSync(path.join(IMG_DIR, `photos/${name}-1800.webp`));
  const srcset = `/img/photos/${name}-900.webp 900w${big ? `, /img/photos/${name}-1800.webp 1800w` : ''}`;
  return `<img class="${cls}" src="/img/photos/${name}-900.webp" srcset="${srcset}" sizes="${sizes}" alt="${esc(alt)}" width="${w}" height="${h}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
}
const bottle = (p, { sizes = '(max-width: 700px) 60vw, 300px', eager = false, cls = '' } = {}) =>
  `<img class="${cls}" src="${p.img.sm}" srcset="${p.img.sm} 600w, ${p.img.lg} 1200w" sizes="${sizes}" alt="${esc(p.name)} ${esc(p.subtitle)}, ${esc(p.count)} bottle" width="600" height="600"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
const themeVars = (p) => `--accent:${p.theme.accent};--tint:${p.theme.tint};--tint2:${p.theme.tint2}`;
const servings = (p) => Math.round(parseInt(p.count, 10) / parseInt(p.serving, 10)) || 30;
const perDay = (p) => money(p.price / servings(p));

const SEALS = [
  ['made-in-usa', 'Made in the USA'],
  ['gmp', 'GMP certified'],
  ['fda-registered', 'Made in an FDA-registered facility'],
  ['lab-tested', 'Third-party lab tested'],
];
const seal = ([file, alt], size = 88) =>
  `<img src="/img/badges/${file}.webp" alt="${esc(alt)}" width="${size}" height="${size}" loading="lazy" decoding="async">`;

// ---------- layout ----------
function layout({ title, description, urlPath, body, schema = [], ogType = 'website', ogImage, noindex = false, bodyClass = '', preload = '' }) {
  const canonical = site.url + urlPath;
  const img = abs(ogImage || site.ogImage);
  const nav = site.nav
    .map((n) => `<li><a href="${n.href}"${urlPath.startsWith(n.href) ? ' aria-current="page"' : ''}>${esc(n.label)}</a></li>`)
    .join('');
  const graph = { '@context': 'https://schema.org', '@graph': [orgSchema, ...schema] };
  const free = money(site.freeShippingThreshold).replace('.00', '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#229b5e">
<link rel="icon" href="/img/icon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/img/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/img/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/css/site.css?v=${BUILD_ID}">
${preload}
${jsonLd(graph)}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<div class="promo"><p>Free US shipping on orders over ${free} <span class="dot">&bull;</span> Made in the USA<span class="promo-extra"> <span class="dot">&bull;</span> Ships in 1&ndash;2 business days</span></p></div>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="${esc(site.name)} home"><img src="/img/logo-h.webp" alt="${esc(site.name)}" width="720" height="128"></a>
    <nav id="site-nav" aria-label="Main"><ul>${nav}</ul></nav>
    <a class="cart-pill" href="/cart/">Cart <span class="cart-count" data-cart-count>0</span></a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav"><span></span><span></span><span></span><span class="sr">Menu</span></button>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-top">
    <div class="footer-brand">
      <img src="/img/logo-h-white.webp" alt="${esc(site.name)}" width="720" height="128" loading="lazy">
      <p>Great-tasting gummy supplements for calm, sleep, immune support, joints and daily nutrition. Made in the USA.</p>
      <p><a href="mailto:${site.email}">${site.email}</a></p>
    </div>
    <div>
      <h2 class="footer-h">Shop</h2>
      <ul>${products.map((p) => `<li><a href="/supplements/${p.slug}/">${esc(p.name)}</a></li>`).join('')}<li><a href="/shop/">Shop all</a></li></ul>
    </div>
    <div>
      <h2 class="footer-h">Help</h2>
      <ul><li><a href="/faq/">FAQ</a></li><li><a href="/contact/">Contact us</a></li><li><a href="/shipping-policy/">Shipping</a></li><li><a href="/refund-policy/">Returns &amp; refunds</a></li><li><a href="/learn/">Supplement guides</a></li></ul>
    </div>
    <div class="footer-seals">
      ${SEALS.map((s) => seal(s, 64)).join('')}
    </div>
  </div>
  <div class="wrap fda">
    <p>*${esc(site.fdaDisclaimer)}</p>
    <p class="legal-links">&copy; ${new Date().getFullYear()} ${esc(site.name)} &middot; ${site.footerLinks.map((l) => `<a href="${l.href}">${esc(l.label)}</a>`).join(' &middot; ')}</p>
  </div>
</footer>
<script src="/js/site.js?v=${BUILD_ID}" defer></script>
</body>
</html>`;
}

// ---------- components ----------
const productCard = (p, headingLevel = 3) => `
<article class="pcard" style="${themeVars(p)}">
  <a href="/supplements/${p.slug}/" class="pcard-stage" tabindex="-1" aria-hidden="true">
    <span class="pcard-tag">${esc(p.theme.label)}</span>
    ${bottle(p, { sizes: '(max-width: 600px) 70vw, 260px' })}
  </a>
  <div class="pcard-body">
    <h${headingLevel} class="pcard-title"><a href="/supplements/${p.slug}/">${esc(p.name)}</a></h${headingLevel}>
    <p class="pcard-sub">${esc(p.subtitle)}</p>
    <ul class="pcard-points">${p.benefits.slice(0, 2).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <div class="pcard-foot">
      <p class="price">${money(p.price)}<small>${esc(p.count)}</small></p>
      <button class="btn btn-accent" data-add-to-cart="${p.slug}">Add to cart</button>
    </div>
  </div>
</article>`;

const sealsBand = `
<section class="seals" aria-label="Quality standards">
  <div class="wrap seals-grid">
    ${SEALS.map((s) => `<div class="seal">${seal(s, 96)}<span>${esc(s[1])}</span></div>`).join('')}
  </div>
</section>`;

const catalogScript = `<script>window.VC_PRODUCTS=${JSON.stringify(
  Object.fromEntries(products.map((p) => [p.slug, { name: p.name, subtitle: p.subtitle, price: p.price, image: p.img.sm, accent: p.theme.accent, tint: p.theme.tint }]))
)};window.VC_SHIPPING=${JSON.stringify({ free: site.freeShippingThreshold, flat: site.flatShipping })};</script>`;

// ---------- pages ----------
function homePage() {
  const free = money(site.freeShippingThreshold).replace('.00', '');
  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="pill">Gummy supplements for adults</p>
      <h1>Savor health.<br><span>Embrace vitality.</span></h1>
      <p class="lead">Five great-tasting gummies for calm, sleep, immune support, joint comfort and daily nutrition. Two gummies a day, made in the USA and third-party tested.*</p>
      <div class="hero-cta"><a class="btn btn-lg" href="/shop/">Shop the gummies</a><a class="btn btn-lg btn-outline" href="#goals">Find your fit</a></div>
      <ul class="hero-facts"><li><strong>${free}+</strong> free shipping</li><li><strong>30</strong> servings per bottle</li><li><strong>30-day</strong> returns</li></ul>
    </div>
    <div class="hero-art">
      <div class="hero-photo">${photo('park-stretch', 'Friends stretching together in a sunny park', { sizes: '(max-width: 900px) 100vw, 560px', eager: true, w: 1800, h: 1200 })}</div>
      <img class="hero-lineup" src="/img/lineup-900.webp" srcset="/img/lineup-900.webp 900w, /img/lineup-1600.webp 1600w" sizes="(max-width: 900px) 92vw, 620px" alt="The five Vitality Chews gummy supplements: ShieldBerry Vitality, Tranquil Nights, Calm Essence, Flexiease and Vitality Spectrum" width="1600" height="742" fetchpriority="high">
    </div>
  </div>
</section>
${sealsBand}
<section class="section" id="goals">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Shop by goal</p>
      <h2>One gummy for every part of your day</h2>
      <p class="muted">Pick the formula that fits what you care about most, or mix two for a simple routine.</p>
    </div>
    <div class="pgrid">${products.map((p) => productCard(p)).join('')}</div>
  </div>
</section>
<section class="band">
  ${photo('park-warmup', '', { cls: 'band-bg', w: 1800, h: 1200 })}
  <div class="wrap band-inner">
    <p class="eyebrow light">Why gummies</p>
    <h2>The best supplement is the one you actually take</h2>
    <p>Big pills and chalky powders are easy to skip. Our gummies taste good and take seconds, so the habit sticks. Two a day, no water needed.</p>
    <a class="btn btn-lg btn-light" href="/shop/">Start your routine</a>
  </div>
</section>
<section class="section">
  <div class="wrap split">
    <div class="split-media">${photo('superfoods', 'Colorful whole foods: salmon, berries, citrus, greens and nuts', { sizes: '(max-width: 900px) 100vw, 520px', w: 1200, h: 1800 })}</div>
    <div>
      <p class="eyebrow">How we make them</p>
      <h2>Quality you can check</h2>
      <ol class="steps">
        <li><strong>Made in the USA.</strong> Every bottle comes from a GMP-certified, FDA-registered facility.</li>
        <li><strong>Third-party tested.</strong> Independent labs check each formula for purity and potency, including heavy metals and microbials.</li>
        <li><strong>Clear labels.</strong> The full Supplement Facts panel is on every product page, so you know what you are taking.</li>
        <li><strong>Honest claims.</strong> We say what each formula is designed to support and stop there.*</li>
      </ol>
      <a class="text-link" href="/about/">More about Vitality Chews &rarr;</a>
    </div>
  </div>
</section>
<section class="section tint">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Learn</p>
      <h2>Straight answers about supplements</h2>
    </div>
    <div class="learn-grid">${learnCards()}</div>
  </div>
</section>
<section class="cta-strip">
  <div class="wrap cta-inner">
    <img src="/img/lineup-900.webp" alt="" width="900" height="417" loading="lazy">
    <div>
      <h2>Free shipping over ${free}</h2>
      <p>Mix and match any gummies. Orders ship from our US fulfillment center in 1&ndash;2 business days.</p>
      <a class="btn btn-lg" href="/shop/">Shop all gummies</a>
    </div>
  </div>
</section>`;
  return layout({
    title: 'Vitality Chews | Gummy Vitamins & Supplements Made in the USA',
    description: site.description,
    urlPath: '/',
    body: body + catalogScript,
    preload: '<link rel="preload" as="image" href="/img/lineup-900.webp" imagesrcset="/img/lineup-900.webp 900w, /img/lineup-1600.webp 1600w" imagesizes="(max-width: 900px) 92vw, 620px">',
    schema: [
      { '@type': 'WebSite', '@id': site.url + '/#website', name: site.name, url: site.url, publisher: { '@id': site.url + '/#organization' } },
      {
        '@type': 'ItemList',
        name: 'Vitality Chews gummy supplements',
        itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${site.url}/supplements/${p.slug}/` })),
      },
    ],
  });
}

function pageHead({ title, lead = '', crumbs = [], photoName = '', eyebrow = '' }) {
  const trail = [['Home', '/'], ...crumbs];
  return `
<section class="page-head${photoName ? ' has-photo' : ''}">
  ${photoName ? photo(photoName, '', { cls: 'page-head-bg', w: 1800, h: 1200, eager: true }) : ''}
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">${trail.map(([n, u], i) => (i === trail.length - 1 && crumbs.length ? `<span>${esc(n)}</span>` : `<a href="${u}">${esc(n)}</a>`)).join(' <span aria-hidden="true">/</span> ')}${crumbs.length ? '' : ` <span aria-hidden="true">/</span> <span>${esc(title)}</span>`}</nav>
    ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
    <h1>${esc(title)}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ''}
  </div>
</section>`;
}

function shopPage() {
  const body = `
${pageHead({ title: 'Shop gummy supplements', crumbs: [['Shop', '/shop/']], photoName: 'park-couple', lead: `Five focused formulas for stress, sleep, immune support, joints and daily nutrition.* Free US shipping on orders over ${money(site.freeShippingThreshold).replace('.00', '')}.` })}
<section class="section"><div class="wrap"><div class="pgrid">${products.map((p) => productCard(p, 2)).join('')}</div></div></section>
${sealsBand}`;
  return layout({
    title: 'Shop Gummy Vitamins & Supplements | Vitality Chews',
    description: 'Shop Vitality Chews gummy supplements: ashwagandha, melatonin sleep, elderberry immune, glucosamine joint and multivitamin gummies. Made in the USA.',
    urlPath: '/shop/',
    body: body + catalogScript,
    schema: [
      breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Shop', url: '/shop/' }]),
      {
        '@type': 'CollectionPage',
        name: 'Shop gummy supplements',
        url: site.url + '/shop/',
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${site.url}/supplements/${p.slug}/`, name: p.name })),
        },
      },
    ],
  });
}

function productPage(p) {
  const url = `/supplements/${p.slug}/`;
  const related = p.related.map((s) => bySlug[s]).filter(Boolean);
  const guide = learnArticles.find((a) => a.meta.product === p.slug);
  const views = [
    { sm: p.img.sm, lg: p.img.lg, alt: `${p.name} bottle`, cls: '' },
    { sm: p.facts.sm, lg: p.facts.lg, alt: `${p.name} Supplement Facts panel`, cls: 'is-facts' },
  ];
  const free = money(site.freeShippingThreshold).replace('.00', '');
  const body = `
<section class="product" style="${themeVars(p)}">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span aria-hidden="true">/</span> <a href="/shop/">Shop</a> <span aria-hidden="true">/</span> <span>${esc(p.name)}</span></nav>
    <div class="product-layout">
      <div class="gallery">
        <div class="stage">
          <img class="gallery-main" src="${p.img.lg}" alt="${esc(p.name)} ${esc(p.subtitle)}, ${esc(p.count)}" width="1200" height="1200" fetchpriority="high">
        </div>
        <div class="thumbs" role="group" aria-label="Product images">
          ${views.map((v, i) => `<button type="button" class="${v.cls}" data-thumb="${v.lg}" data-thumb-class="${v.cls}" aria-label="Show ${esc(v.alt)}"${i === 0 ? ' aria-current="true"' : ''}><img src="${v.sm}" alt="" width="96" height="96" loading="lazy"></button>`).join('')}
        </div>
      </div>
      <div class="buy">
        <p class="pill accent">${esc(p.theme.label)}</p>
        <h1>${esc(p.name)}</h1>
        <p class="buy-sub">${esc(p.subtitle)}</p>
        <p class="buy-summary">${esc(p.summary)}</p>
        <div class="price-row"><span class="price big">${money(p.price)}</span><span class="per">${esc(p.count)} &middot; ${servings(p)} servings &middot; about ${perDay(p)} a day</span></div>
        <ul class="benefits">${p.benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        <div class="buy-row">
          <div class="stepper"><button type="button" data-step="-1" aria-label="Decrease quantity">&minus;</button><input type="number" min="1" max="12" value="1" data-qty aria-label="Quantity"><button type="button" data-step="1" aria-label="Increase quantity">+</button></div>
          <button class="btn btn-lg btn-accent btn-grow" data-add-to-cart="${p.slug}" data-with-qty>Add to cart &middot; ${money(p.price)}</button>
        </div>
        <p class="ship-note">Free US shipping on orders over ${free}. Ships in 1&ndash;2 business days. 30-day returns.</p>
        <div class="buy-seals">${SEALS.map((s) => seal(s, 58)).join('')}</div>
      </div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap detail-grid">
    <div class="prose">
      <h2>About ${esc(p.name)}</h2>
      ${p.body.map((t) => `<p>${esc(t)}</p>`).join('')}
      <h2>What&rsquo;s inside</h2>
      <div class="ingredients">${p.ingredients.map((i) => `<div class="ingredient" style="${themeVars(p)}"><h3>${esc(i.name)}</h3><p>${esc(i.about)}</p></div>`).join('')}</div>
      <h2>How to take it</h2>
      <p>${esc(p.suggestedUse)} Do not exceed the suggested serving.</p>
      ${p.allergens ? `<p class="allergen"><strong>Allergen information:</strong> ${esc(p.allergens)}</p>` : ''}
      <h3>Cautions</h3>
      <p>For adults 18 and older. If you are pregnant or nursing, have a medical condition or take medication, talk with your doctor before use. Keep out of reach of children. Do not use if the safety seal is damaged or missing. Store in a cool, dry place.</p>
      ${guide ? `<p><a class="text-link" href="/learn/${guide.slug}/">Read our guide: ${esc(guide.meta.title)} &rarr;</a></p>` : ''}
    </div>
    <aside class="facts-card" aria-label="Supplement Facts">
      <h2>Supplement Facts</h2>
      <a href="${p.facts.lg}" target="_blank" rel="noopener"><img src="${p.facts.sm}" srcset="${p.facts.sm} 600w, ${p.facts.lg} 1200w" sizes="(max-width: 900px) 100vw, 380px" alt="${esc(p.name)} Supplement Facts panel and other ingredients" width="600" height="600" loading="lazy"></a>
      <p class="small muted">Tap to enlarge. ${p.coa ? `<a href="${p.coa}" target="_blank" rel="noopener">View a third-party lab certificate of analysis</a>.` : ''}</p>
    </aside>
  </div>
</section>
<section class="section tint">
  <div class="wrap prose">
    <h2>${esc(p.name)} FAQ</h2>
    ${p.faq.map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
    <p class="small muted">*${esc(site.fdaDisclaimer)}</p>
  </div>
</section>
${related.length ? `<section class="section"><div class="wrap"><div class="section-head"><p class="eyebrow">Pairs well with</p><h2>Build your routine</h2></div><div class="pgrid pgrid-2">${related.map((r) => productCard(r)).join('')}</div></div></section>` : ''}`;
  return layout({
    title: `${p.seoTitle} | Vitality Chews`,
    description: p.metaDescription,
    urlPath: url,
    ogType: 'product',
    ogImage: p.image,
    body: body + catalogScript,
    bodyClass: 'page-product',
    schema: [
      breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Shop', url: '/shop/' }, { name: p.name, url }]),
      {
        '@type': 'Product',
        '@id': site.url + url + '#product',
        name: `${p.name} ${p.subtitle}`,
        sku: p.sku,
        mpn: p.sku,
        image: [p.image, p.img.lg, p.facts.lg].map(abs),
        description: p.metaDescription,
        category: p.category,
        brand: { '@type': 'Brand', name: site.name },
        offers: {
          '@type': 'Offer',
          url: site.url + url,
          priceCurrency: 'USD',
          price: p.price.toFixed(2),
          availability: 'https://schema.org/InStock',
          itemCondition: 'https://schema.org/NewCondition',
          seller: { '@id': site.url + '/#organization' },
          shippingDetails: shippingDetails(p.price),
          hasMerchantReturnPolicy: returnPolicy,
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ],
  });
}

const PAGE_PHOTOS = { about: 'park-couple', contact: 'morning-workout', faq: 'heart-healthy' };

const contactForm = `
<form class="contact-form" data-contact-form novalidate>
  <h2>Send us a message</h2>
  <div class="cf-row">
    <label>Your name<input type="text" name="name" autocomplete="name" maxlength="120"></label>
    <label>Email<input type="email" name="email" autocomplete="email" required maxlength="200"></label>
  </div>
  <label>Order number <span class="muted">(optional, starts with VC-)</span><input type="text" name="order" maxlength="40"></label>
  <label>Message<textarea name="message" required maxlength="5000" rows="6"></textarea></label>
  <label class="hp" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
  <button class="btn btn-lg" type="submit">Send message</button>
  <p class="small" data-contact-status role="status"></p>
</form>`;

function contentPage(slug, { meta, body }) {
  const url = `/${slug}/`;
  let html = markdown(body);
  const schema = [breadcrumbs([{ name: 'Home', url: '/' }, { name: meta.title, url }])];
  if (meta.faq === 'true') {
    // Turn "## question" + following paragraphs into <details> and FAQPage schema
    const qa = [];
    const parts = body.split(/^## /m).slice(1);
    for (const part of parts) {
      const [q, ...rest] = part.split('\n');
      qa.push({ q: q.trim(), a: rest.join('\n').trim() });
    }
    html = qa.map((x) => `<details class="faq"><summary>${inline(x.q)}</summary>${markdown(x.a)}</details>`).join('\n');
    schema.push({
      '@type': 'FAQPage',
      mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') } })),
    });
  }
  const page = `
${pageHead({ title: meta.title, photoName: PAGE_PHOTOS[slug] || '' })}
<section class="section"><div class="wrap prose">
${slug === 'contact' ? contactForm : ''}
${html}
${meta.updated ? `<p class="small muted">Last updated: ${esc(meta.updated)}</p>` : ''}
</div></section>`;
  return layout({ title: meta.seoTitle || `${meta.title} | ${site.name}`, description: meta.description, urlPath: url, body: page, schema });
}

const learnDir = path.join(SITE_DIR, 'content/learn');
const learnArticles = fs
  .readdirSync(learnDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ slug: f.replace(/\.md$/, ''), ...readMd(path.join(learnDir, f)) }))
  .sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

function learnCards() {
  return learnArticles
    .map((a) => {
      const p = bySlug[a.meta.product];
      return `<article class="lcard">
  <a class="lcard-media" href="/learn/${a.slug}/" tabindex="-1" aria-hidden="true">${a.meta.image ? photo(a.meta.image, '', { sizes: '(max-width: 700px) 100vw, 540px' }) : ''}${p ? `<span class="lcard-bottle" style="${themeVars(p)}"><img src="${p.img.sm}" alt="" width="120" height="120" loading="lazy"></span>` : ''}</a>
  <div class="lcard-body"><p class="eyebrow">Guide</p><h3><a href="/learn/${a.slug}/">${esc(a.meta.title)}</a></h3><p>${esc(a.meta.description)}</p></div>
</article>`;
    })
    .join('');
}

function learnIndex() {
  const body = `
${pageHead({ title: 'Supplement guides', crumbs: [['Learn', '/learn/']], photoName: 'stethoscope-produce', lead: 'Plain-English guides to the ingredients in our gummies, how to use them and what to look for on a label.' })}
<section class="section"><div class="wrap"><div class="learn-grid">${learnCards()}</div></div></section>`;
  return layout({
    title: 'Supplement Guides | Learn | Vitality Chews',
    description: 'Guides to ashwagandha, melatonin and other gummy supplement ingredients: how they work, when to take them and what to look for.',
    urlPath: '/learn/',
    body,
    schema: [breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Learn', url: '/learn/' }])],
  });
}

function learnArticle(a) {
  const url = `/learn/${a.slug}/`;
  const p = bySlug[a.meta.product];
  const date = new Date(a.meta.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const body = `
<article>
${pageHead({ title: a.meta.title, crumbs: [['Learn', '/learn/'], [a.meta.title, url]], photoName: a.meta.image || '', eyebrow: 'Guide' })}
<section class="section"><div class="wrap article-grid">
<div class="prose">
<p class="small muted">By the Vitality Chews team &middot; <time datetime="${a.meta.date}">${date}</time></p>
${markdown(a.body)}
<p class="small muted">This article is for general information and is not medical advice. *${esc(site.fdaDisclaimer)}</p>
</div>
${p ? `<aside class="article-aside"><p class="eyebrow">Featured in this guide</p>${productCard(p, 2)}</aside>` : ''}
</div></section>
</article>`;
  return layout({
    title: `${a.meta.seoTitle || a.meta.title} | Vitality Chews`,
    description: a.meta.description,
    urlPath: url,
    ogType: 'article',
    ogImage: p?.image,
    body: body + catalogScript,
    schema: [
      breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Learn', url: '/learn/' }, { name: a.meta.title, url }]),
      {
        '@type': 'Article',
        headline: a.meta.title,
        description: a.meta.description,
        datePublished: a.meta.date,
        dateModified: a.meta.date,
        author: { '@type': 'Organization', name: site.name, url: site.url },
        publisher: { '@id': site.url + '/#organization' },
        mainEntityOfPage: site.url + url,
        ...(p ? { image: abs(p.image) } : {}),
      },
    ],
  });
}

function cartPage() {
  const body = `
<section class="page-head slim"><div class="wrap"><h1>Your cart</h1></div></section>
<section class="section"><div class="wrap cart-wrap">
  <div>
    <div class="ship-meter" data-ship-meter hidden><p data-free-note></p><div class="meter"><span data-meter-fill></span></div></div>
    <div id="cart-items" class="cart-items"><p class="muted">Loading your cart&hellip;</p></div>
  </div>
  <aside class="cart-summary" aria-label="Order summary">
    <h2>Order summary</h2>
    <dl>
      <div><dt>Subtotal</dt><dd data-subtotal>$0.00</dd></div>
      <div><dt>Shipping</dt><dd data-shipping>Calculated at checkout</dd></div>
    </dl>
    <button class="btn btn-lg btn-block" data-checkout disabled>Secure checkout</button>
    <p class="small muted center">Payments are processed securely by Stripe. Sales tax, if any, is calculated at checkout.</p>
    <p class="small error" data-checkout-error role="alert"></p>
    <div class="cart-seals">${SEALS.map((s) => seal(s, 52)).join('')}</div>
  </aside>
</div></section>
<section class="section tint" data-cart-upsell hidden><div class="wrap"><div class="section-head"><h2>Complete your routine</h2></div><div class="pgrid">${products.map((p) => productCard(p, 3).replace('<article class="pcard"', `<article data-upsell="${p.slug}" class="pcard"`)).join('')}</div></div></section>`;
  return layout({ title: 'Cart | Vitality Chews', description: 'Your Vitality Chews cart.', urlPath: '/cart/', body: body + catalogScript, noindex: true, bodyClass: 'page-cart' });
}

function successPage() {
  const body = `
<section class="page-head slim"><div class="wrap center">
  <img class="success-art" src="/img/lineup-900.webp" alt="" width="900" height="417">
  <h1>Thank you for your order!</h1>
  <p class="lead" data-order-msg>We are confirming your payment&hellip;</p>
</div></section>
<section class="section"><div class="wrap prose center">
  <p>You will get an email confirmation shortly, and another email with tracking as soon as your order ships (usually within 1&ndash;2 business days).</p>
  <p>Questions? Email <a href="mailto:${site.email}">${site.email}</a>.</p>
  <p><a class="btn btn-lg" href="/shop/">Continue shopping</a></p>
</div></section>`;
  return layout({ title: 'Order confirmed | Vitality Chews', description: 'Thank you for your order.', urlPath: '/order/success/', body, noindex: true, bodyClass: 'page-success' });
}

function notFoundPage() {
  const body = `
<section class="page-head slim"><div class="wrap center">
  <h1>Page not found</h1>
  <p class="lead">The page you are looking for has moved or no longer exists.</p>
  <p><a class="btn btn-lg" href="/shop/">Shop our gummies</a></p>
</div></section>
<section class="section"><div class="wrap"><div class="pgrid">${products.map((p) => productCard(p, 2)).join('')}</div></div></section>`;
  return layout({ title: 'Page not found | Vitality Chews', description: 'Page not found.', urlPath: '/404', body: body + catalogScript, noindex: true });
}

// ---------- build ----------
fs.rmSync(DIST, { recursive: true, force: true });
copyDir(path.join(SITE_DIR, 'static'), DIST);

const urls = [];
const add = (rel, html, url, priority = '0.6') => { write(rel, html); if (url) urls.push({ url, priority }); };

add('index.html', homePage(), '/', '1.0');
add('shop/index.html', shopPage(), '/shop/', '0.9');
for (const p of products) add(`supplements/${p.slug}/index.html`, productPage(p), `/supplements/${p.slug}/`, '0.9');

const pagesDir = path.join(SITE_DIR, 'content/pages');
for (const f of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md'))) {
  const slug = f.replace(/\.md$/, '');
  const policy = /policy|terms|disclaimer/.test(slug);
  add(`${slug}/index.html`, contentPage(slug, readMd(path.join(pagesDir, f))), `/${slug}/`, policy ? '0.3' : '0.6');
}

add('learn/index.html', learnIndex(), '/learn/', '0.7');
for (const a of learnArticles) add(`learn/${a.slug}/index.html`, learnArticle(a), `/learn/${a.slug}/`, '0.7');

add('cart/index.html', cartPage());
add('order/success/index.html', successPage());
add('404.html', notFoundPage());

write(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${site.url}${u.url}</loc><lastmod>${BUILD_DATE}</lastmod><priority>${u.priority}</priority></url>`)
    .join('\n')}\n</urlset>\n`
);
write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /cart/\nDisallow: /order/\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: ${site.url}/sitemap.xml\n`);

// Products manifest used by the Worker for server-side pricing (never trust cart prices from the browser)
fs.mkdirSync(path.join(ROOT, 'src/generated'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'src/generated/catalog.js'),
  `// Generated by scripts/build.mjs. Do not edit.\nexport const CATALOG = ${JSON.stringify(
    Object.fromEntries(products.map((p) => [p.slug, { sku: p.sku, name: `${p.name} ${p.subtitle}`, price: Math.round(p.price * 100), weightOz: p.weightOz, image: p.image }])),
    null,
    2
  )};\nexport const SHIPPING = ${JSON.stringify({ freeThresholdCents: site.freeShippingThreshold * 100, flatCents: Math.round(site.flatShipping * 100) })};\n`
);

console.log(`Built ${urls.length} indexable pages + cart, success and 404 into dist/`);
