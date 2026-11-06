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

// ---------- layout ----------
const ICON_CART = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>';

function layout({ title, description, urlPath, body, schema = [], ogType = 'website', ogImage, noindex = false, bodyClass = '' }) {
  const canonical = site.url + urlPath;
  const img = abs(ogImage || site.ogImage);
  const nav = site.nav
    .map((n) => `<li><a href="${n.href}"${urlPath.startsWith(n.href) ? ' aria-current="page"' : ''}>${esc(n.label)}</a></li>`)
    .join('');
  const graph = { '@context': 'https://schema.org', '@graph': [orgSchema, ...schema] };
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
<meta name="theme-color" content="#1f7a4d">
<link rel="icon" href="/img/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/img/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/css/site.css">
${jsonLd(graph)}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<div class="promo">Free shipping on US orders of ${money(site.freeShippingThreshold).replace('.00', '')}+ &middot; Made in the USA</div>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="${esc(site.name)} home"><img src="${site.logo}" alt="${esc(site.name)}" width="150" height="48"></a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav id="site-nav" aria-label="Main"><ul>${nav}</ul></nav>
    <a class="cart-link" href="/cart/" aria-label="Cart">${ICON_CART}<span class="cart-count" data-cart-count hidden>0</span></a>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <img src="${site.logo}" alt="${esc(site.name)}" width="140" height="45" loading="lazy">
      <p>${esc(site.description)}</p>
      <p><a href="mailto:${site.email}">${site.email}</a></p>
    </div>
    <div>
      <h2 class="footer-h">Shop</h2>
      <ul>${products.map((p) => `<li><a href="/supplements/${p.slug}/">${esc(p.name)} <span class="muted">${esc(p.subtitle)}</span></a></li>`).join('')}</ul>
    </div>
    <div>
      <h2 class="footer-h">Help</h2>
      <ul><li><a href="/faq/">FAQ</a></li><li><a href="/contact/">Contact</a></li><li><a href="/learn/">Learn</a></li>${site.footerLinks.map((l) => `<li><a href="${l.href}">${esc(l.label)}</a></li>`).join('')}</ul>
    </div>
  </div>
  <div class="wrap fda">
    <p>*${esc(site.fdaDisclaimer)}</p>
    <p>&copy; ${new Date().getFullYear()} ${esc(site.name)}. All rights reserved.</p>
  </div>
</footer>
<script src="/js/site.js" defer></script>
</body>
</html>`;
}

// ---------- components ----------
const productCard = (p, headingLevel = 3) => `
<article class="card product-card">
  <a href="/supplements/${p.slug}/" class="card-img"><img src="${p.image}" alt="${esc(p.name)} ${esc(p.subtitle)} bottle" width="400" height="400" loading="lazy"></a>
  <div class="card-body">
    <p class="eyebrow">${esc(p.category)}</p>
    <h${headingLevel} class="card-title"><a href="/supplements/${p.slug}/">${esc(p.name)}</a></h${headingLevel}>
    <p class="card-sub">${esc(p.subtitle)}</p>
    <p class="card-summary">${esc(p.summary)}</p>
    <div class="card-foot">
      <span class="price">${money(p.price)}</span>
      <button class="btn btn-sm" data-add-to-cart="${p.slug}">Add to cart</button>
    </div>
  </div>
</article>`;

const trustBar = `
<section class="trust" aria-label="Quality standards">
  <div class="wrap trust-grid">
    <div><strong>Made in the USA</strong><span>Produced domestically</span></div>
    <div><strong>GMP-Certified</strong><span>Good Manufacturing Practice facility</span></div>
    <div><strong>FDA-Registered Facility</strong><span>Registered manufacturing site</span></div>
    <div><strong>Third-Party Tested</strong><span>Checked for purity</span></div>
  </div>
</section>`;

const catalogScript = `<script>window.VC_PRODUCTS=${JSON.stringify(
  Object.fromEntries(products.map((p) => [p.slug, { name: p.name, subtitle: p.subtitle, price: p.price, image: p.image }]))
)};window.VC_SHIPPING=${JSON.stringify({ free: site.freeShippingThreshold, flat: site.flatShipping })};</script>`;

// ---------- pages ----------
function homePage() {
  const goals = [
    ['stress', 'Calm & Stress', 'calm-essence'],
    ['sleep', 'Sleep', 'tranquil-nights'],
    ['immune', 'Immune Support', 'shieldberry-vitality'],
    ['joints', 'Joint Health', 'flexiease'],
    ['daily', 'Daily Nutrition', 'vitality-spectrum'],
  ];
  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="eyebrow">Gummy supplements for adults</p>
      <h1>Daily supplements you will look forward to taking</h1>
      <p class="lead">Great-tasting gummies for calm, sleep, immune support, joint health and complete daily nutrition. Made in the USA and third-party tested.*</p>
      <div class="hero-cta"><a class="btn" href="/shop/">Shop all gummies</a><a class="btn btn-ghost" href="/learn/">How to choose</a></div>
      <p class="small muted">Free US shipping on orders of $75+</p>
    </div>
    <div class="hero-img"><img src="/img/products-lineup.png" alt="The Vitality Chews gummy supplement lineup" width="640" height="520" fetchpriority="high"></div>
  </div>
</section>
${trustBar}
<section class="section">
  <div class="wrap">
    <h2 class="center">Shop by goal</h2>
    <p class="center muted">Pick the gummy that fits what you care about most.</p>
    <ul class="goal-grid">
      ${goals.map(([g, label, slug]) => `<li><a href="/supplements/${slug}/"><img src="${bySlug[slug].image}" alt="" width="120" height="120" loading="lazy"><span>${label}</span><small>${esc(bySlug[slug].name)}</small></a></li>`).join('')}
    </ul>
  </div>
</section>
<section class="section alt">
  <div class="wrap">
    <h2 class="center">Our gummy supplements</h2>
    <div class="product-grid">${products.map((p) => productCard(p)).join('')}</div>
  </div>
</section>
<section class="section">
  <div class="wrap split">
    <div>
      <h2>Why gummies work better for most people</h2>
      <p>The best supplement is the one you take every day. Big pills, chalky powders and complicated routines are easy to skip. Our chewable gummies taste good and take seconds, so building a daily habit is easy.</p>
      <ul class="checks">
        <li>No pills to swallow</li>
        <li>Natural flavors and colors</li>
        <li>Simple servings: most products are two gummies a day</li>
        <li>Clear labels with suggested use</li>
      </ul>
    </div>
    <div>
      <h2>Quality you can check</h2>
      <p>Every Vitality Chews product is made in the USA in a GMP-certified, FDA-registered facility and third-party tested for purity, including heavy metals and microbials. We describe what each formula is designed to support and we do not overpromise.*</p>
      <p><a href="/about/">Learn more about us &rarr;</a></p>
    </div>
  </div>
</section>
<section class="section alt">
  <div class="wrap">
    <h2 class="center">From our Learn library</h2>
    <div class="learn-grid">${learnCards()}</div>
  </div>
</section>`;
  return layout({
    title: 'Vitality Chews | Gummy Vitamins & Supplements Made in the USA',
    description: site.description,
    urlPath: '/',
    body: body + catalogScript,
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

function shopPage() {
  const body = `
<section class="page-head"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span>Shop</span></nav>
  <h1>Shop gummy supplements</h1>
  <p class="lead">Five focused formulas for adults: stress, sleep, immune support, joint health and daily nutrition.* Free US shipping on orders of $75+.</p>
</div></section>
<section class="section"><div class="wrap"><div class="product-grid">${products.map((p) => productCard(p, 2)).join('')}</div></div></section>
${trustBar}`;
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
  const images = [p.image, ...p.gallery];
  const related = p.related.map((s) => bySlug[s]).filter(Boolean);
  const guide = learnArticles.find((a) => a.meta.product === p.slug);
  const body = `
<section class="section product">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/shop/">Shop</a> / <span>${esc(p.name)}</span></nav>
    <div class="product-grid-2">
      <div class="gallery">
        <img class="gallery-main" src="${p.image}" alt="${esc(p.name)} ${esc(p.subtitle)}, ${esc(p.count)}" width="600" height="600" fetchpriority="high">
        ${images.length > 1 ? `<div class="thumbs">${images.map((src, i) => `<button type="button" data-thumb="${src}" aria-label="View image ${i + 1}"><img src="${src}" alt="" width="80" height="80" loading="lazy"></button>`).join('')}</div>` : ''}
      </div>
      <div class="buy">
        <p class="eyebrow">${esc(p.category)}</p>
        <h1>${esc(p.name)} <span class="h1-sub">${esc(p.subtitle)}</span></h1>
        <p class="lead">${esc(p.summary)}</p>
        <p class="price big">${money(p.price)} <span class="muted small">${esc(p.count)}</span></p>
        <ul class="checks">${p.benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        <div class="buy-row">
          <label class="qty"><span class="sr">Quantity</span><input type="number" min="1" max="12" value="1" data-qty></label>
          <button class="btn btn-lg" data-add-to-cart="${p.slug}" data-with-qty>Add to cart</button>
        </div>
        <p class="small muted">Free US shipping on orders of $75+. Ships in 1&ndash;2 business days.</p>
        <ul class="mini-trust"><li>Made in the USA</li><li>GMP-certified facility</li><li>Third-party tested</li></ul>
      </div>
    </div>
  </div>
</section>
<section class="section alt">
  <div class="wrap prose">
    <h2>About ${esc(p.name)}</h2>
    ${p.body.map((t) => `<p>${esc(t)}</p>`).join('')}
    <h2>Key ingredients</h2>
    <dl class="ingredients">${p.ingredients.map((i) => `<dt>${esc(i.name)}</dt><dd>${esc(i.about)}</dd>`).join('')}</dl>
    <h2>Suggested use</h2>
    <p>${esc(p.suggestedUse)} Do not exceed the suggested serving.</p>
    <h2>Cautions</h2>
    <p>For adults 18 and older. Pregnant or nursing women, and anyone with a medical condition or taking medication, should consult a physician before use. Keep out of reach of children. Do not use if the safety seal is damaged or missing. Store in a cool, dry place.</p>
    <p class="small muted">See the product label for the complete Supplement Facts panel and allergen information. *${esc(site.fdaDisclaimer)}</p>
    ${guide ? `<p><a href="/learn/${guide.slug}/">Read our guide: ${esc(guide.meta.title)} &rarr;</a></p>` : ''}
  </div>
</section>
<section class="section">
  <div class="wrap prose">
    <h2>${esc(p.name)} FAQ</h2>
    ${p.faq.map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
  </div>
</section>
${related.length ? `<section class="section alt"><div class="wrap"><h2 class="center">Pairs well with</h2><div class="product-grid two">${related.map((r) => productCard(r)).join('')}</div></div></section>` : ''}`;
  return layout({
    title: `${p.seoTitle} | Vitality Chews`,
    description: p.metaDescription,
    urlPath: url,
    ogType: 'product',
    ogImage: p.image,
    body: body + catalogScript,
    schema: [
      breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Shop', url: '/shop/' }, { name: p.name, url }]),
      {
        '@type': 'Product',
        '@id': site.url + url + '#product',
        name: `${p.name} ${p.subtitle}`,
        sku: p.sku,
        mpn: p.sku,
        image: images.map(abs),
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
<section class="page-head"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span>${esc(meta.title)}</span></nav>
  <h1>${esc(meta.title)}</h1>
</div></section>
<section class="section"><div class="wrap prose">
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
      return `<article class="card learn-card">${p ? `<img src="${p.image}" alt="" width="120" height="120" loading="lazy">` : ''}<div><h3><a href="/learn/${a.slug}/">${esc(a.meta.title)}</a></h3><p>${esc(a.meta.description)}</p></div></article>`;
    })
    .join('');
}

function learnIndex() {
  const body = `
<section class="page-head"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span>Learn</span></nav>
  <h1>Learn: supplement guides</h1>
  <p class="lead">Straightforward guides to the ingredients in our gummies, how to use them and what to look for on a label.</p>
</div></section>
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
  const body = `
<article>
<section class="page-head"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/learn/">Learn</a> / <span>${esc(a.meta.title)}</span></nav>
  <h1>${esc(a.meta.title)}</h1>
  <p class="small muted">By the Vitality Chews team &middot; <time datetime="${a.meta.date}">${new Date(a.meta.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time></p>
</div></section>
<section class="section"><div class="wrap prose">
${markdown(a.body)}
<p class="small muted">This article is for general information and is not medical advice. *${esc(site.fdaDisclaimer)}</p>
</div></section>
</article>
${p ? `<section class="section alt"><div class="wrap"><div class="product-grid one">${productCard(p, 2)}</div></div></section>` : ''}`;
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
<section class="page-head"><div class="wrap"><h1>Your cart</h1></div></section>
<section class="section"><div class="wrap cart-wrap">
  <div id="cart-items" class="cart-items"><p class="muted">Loading your cart&hellip;</p></div>
  <aside class="cart-summary card" aria-label="Order summary">
    <h2>Order summary</h2>
    <dl>
      <div><dt>Subtotal</dt><dd data-subtotal>$0.00</dd></div>
      <div><dt>Shipping</dt><dd data-shipping>Calculated at checkout</dd></div>
    </dl>
    <p class="small" data-free-note></p>
    <button class="btn btn-lg btn-block" data-checkout disabled>Secure checkout</button>
    <p class="small muted center">Payments are processed securely by Stripe. Sales tax, if any, is calculated at checkout.</p>
    <p class="small muted" data-checkout-error role="alert"></p>
  </aside>
</div></section>`;
  return layout({ title: 'Cart | Vitality Chews', description: 'Your Vitality Chews cart.', urlPath: '/cart/', body: body + catalogScript, noindex: true, bodyClass: 'page-cart' });
}

function successPage() {
  const body = `
<section class="page-head"><div class="wrap center">
  <h1>Thank you for your order!</h1>
  <p class="lead" data-order-msg>We are confirming your payment&hellip;</p>
</div></section>
<section class="section"><div class="wrap prose center">
  <p>You will get an email confirmation shortly, and another email with tracking as soon as your order ships (usually within 1&ndash;2 business days).</p>
  <p>Questions? Email <a href="mailto:${site.email}">${site.email}</a>.</p>
  <p><a class="btn" href="/shop/">Continue shopping</a></p>
</div></section>`;
  return layout({ title: 'Order confirmed | Vitality Chews', description: 'Thank you for your order.', urlPath: '/order/success/', body, noindex: true, bodyClass: 'page-success' });
}

function notFoundPage() {
  const body = `
<section class="page-head"><div class="wrap center">
  <h1>Page not found</h1>
  <p class="lead">The page you are looking for has moved or no longer exists.</p>
  <p><a class="btn" href="/shop/">Shop our gummies</a></p>
</div></section>
<section class="section alt"><div class="wrap"><div class="product-grid">${products.map((p) => productCard(p, 2)).join('')}</div></div></section>`;
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
write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /cart/\nDisallow: /order/\nDisallow: /api/\n\nSitemap: ${site.url}/sitemap.xml\n`);

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
