const https = require('https');
const fs = require('fs');

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.DATABASE_ID;

function notionRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/${path}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function safeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(r => r.plain_text || '').join('');
}

function parseLineWithLink(line) {
  const mdLink = line.match(/^(.*?)\s*\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (mdLink) {
    const prefix = mdLink[1].replace(/\\\|/g, '|').replace(/｜/g, '|').replace(/\|$/, '').trim();
    const url = mdLink[3];
    return { name: prefix || mdLink[2], url };
  }
  const cleaned = line.replace(/\\\|/g, '|').replace(/｜/g, '|');
  const pipeIndex = cleaned.indexOf('|');
  if (pipeIndex === -1) return { name: cleaned.trim(), url: '' };
  return {
    name: cleaned.slice(0, pipeIndex).trim(),
    url: cleaned.slice(pipeIndex + 1).trim(),
  };
}

function getYoutubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&?/]+)/);
  return m ? m[1] : null;
}

async function main() {
  const result = await notionRequest(`databases/${DB_ID}/query`, {
    filter: { property: '公開', checkbox: { equals: true } },
    sorts: [{ property: '公開日', direction: 'descending' }]
  });

  const posts = result.results.map(page => {
    const p = page.properties;
    return {
      id: page.id.replace(/-/g, ''),
      title: richTextToPlain(p['タイトル']?.title),
      cat: p['カテゴリー']?.select?.name || '',
      date: (p['公開日']?.date?.start || '').replace(/-/g, '.'),
      youtubeUrl: p['YouTube URL']?.url || '',
      point: richTextToPlain(p['動画について']?.rich_text),
      tools: richTextToPlain(p['使った道具']?.rich_text),
      memo: richTextToPlain(p['ひとこと']?.rich_text),
      menu: richTextToPlain(p['献立メモ']?.rich_text),
      pickup: p['ピックアップ']?.checkbox || false,
    };
  });

  console.log(`Fetched ${posts.length} posts`);

  function cardHTML(p) {
    const ytId = getYoutubeId(p.youtubeUrl);
    const img = ytId
      ? `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="${safeHtml(p.title)}">`
      : `<div class="no-img">サムネイルなし</div>`;
    return `<div class="card" data-id="${p.id}"><div class="card-img">${img}</div><div class="card-cat">${safeHtml(p.cat)}</div><div class="card-title">${safeHtml(p.title)}</div><div class="card-date">${safeHtml(p.date)}</div></div>`;
  }

  function textToHtml(str) {
    if (!str) return '';
    return safeHtml(str).replace(/\n/g, '<br>');
  }

  function detailHTML(p) {
    const ytId = getYoutubeId(p.youtubeUrl);
    const ytHtml = ytId
      ? `<div class="yt-wrap"><iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen></iframe></div>`
      : '';

    const toolLines = p.tools ? p.tools.split('\n').filter(Boolean) : [];
    const toolsHtml = toolLines.map(line => {
      const { name, url } = parseLineWithLink(line);
      const link = url ? `<a class="tool-link" href="${safeHtml(url)}" target="_blank">Rakuten ROOM →</a>` : '';
      return `<div class="tool-item"><span class="tool-name">${safeHtml(name)}</span>${link}</div>`;
    }).join('');

  　const menuLines = p.menu ? p.menu.split('\n').filter(Boolean) : [];
    const menuHtml = menuLines.map(line => {
      const cleaned = line.replace(/｜/g, '|').replace(/\\\|/g, '|');
      const parts = cleaned.split('|').map(s => s.trim());
      const name = parts[0] || '';
      const desc = parts[1] || '';
      const url = parts[2] || '';
      const link = url ? `<a class="menu-link" href="${safeHtml(url)}" target="_blank">レシピを見る →</a>` : '';
      return `<div class="menu-item"><span class="menu-name">${safeHtml(name)}</span>${desc ? `<span class="menu-desc">${safeHtml(desc)}</span>` : ''}${link}</div>`;
    }).join('');

    return `<div class="detail-inner" data-id="${p.id}" style="display:none">
      <div class="detail-cat">${safeHtml(p.cat)}</div>
      <div class="detail-title">${safeHtml(p.title)}</div>
      <div class="detail-date">${safeHtml(p.date)}</div>
      ${ytHtml}
      ${p.point ? `<div class="dl-section-label">動画について</div><div class="body-text">${textToHtml(p.point)}</div>` : ''}
      ${menuHtml ? `<div class="dl-section-label">今週の献立</div><div class="menu-list">${menuHtml}</div>` : ''}
      ${toolsHtml ? `<div class="dl-section-label">使った道具</div><div class="tools-list">${toolsHtml}</div>` : ''}
      ${p.memo ? `<div class="dl-section-label">ひとこと</div><div class="memo">${textToHtml(p.memo)}</div>` : ''}
    </div>`;
  }

  const newCards = posts.slice(0, 3).map(cardHTML).join('');
  const pickupCards = posts.filter(p => p.pickup).map(cardHTML).join('');
  const allCards = posts.map(cardHTML).join('');
  const allDetails = posts.map(detailHTML).join('');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="format-detection" content="telephone=no, date=no, email=no, address=no">
  <title>mameの穏やかなキッチン</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', sans-serif; background: #fff; color: #1a1a1a; line-height: 1.7; }
    .site { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; }
    .site-header { border-bottom: 0.5px solid #e0e0e0; padding-bottom: 2rem; margin-bottom: 2rem; }
    .site-title { font-size: 22px; font-weight: 500; letter-spacing: 0.04em; }
    .site-desc { font-size: 13px; margin-top: 1rem; line-height: 2.1; }
    .site-desc .profile { margin-top: 0.75rem; font-size: 12px; color: #888; }
    .nav-row { display: flex; align-items: center; justify-content: space-between; margin-top: 1.5rem; gap: 1rem; flex-wrap: wrap; }
    .nav { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .nav a { font-size: 13px; color: #888; text-decoration: none; cursor: pointer; }
    .nav a.active { color: #1a1a1a; border-bottom: 1px solid #1a1a1a; padding-bottom: 2px; }
    .search-wrap { position: relative; }
    .search-wrap input { font-size: 13px; padding: 6px 12px 6px 30px; border: 0.5px solid #ccc; border-radius: 20px; background: #f7f7f7; color: #1a1a1a; width: 180px; outline: none; }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: 0.35; pointer-events: none; }
    .section-heading { margin-bottom: 1.25rem; }
    .section-heading .ja { font-size: 14px; font-weight: 500; }
    .section-heading .en { font-size: 11px; color: #999; letter-spacing: 0.08em; margin-left: 8px; }
    .section-divider { border: none; border-top: 0.5px solid #e0e0e0; margin: 2.5rem 0; }
    .scroll-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1.25rem; margin-bottom: 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2rem; }
    .card { cursor: pointer; }
    .card-img { width: 100%; aspect-ratio: 16/10; background: #f3f3f3; border-radius: 8px; overflow: hidden; }
    .card-img img { width: 100%; height: 100%; object-fit: cover; }
    .card-img .no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #bbb; }
    .card-cat { font-size: 11px; color: #999; margin-top: 8px; letter-spacing: 0.05em; }
    .card-title { font-size: 14px; font-weight: 500; margin-top: 4px; line-height: 1.5; }
    .card-date { font-size: 11px; color: #bbb; margin-top: 5px; }
    .no-results { font-size: 14px; color: #999; padding: 2rem 0; }
    .detail { display: none; }
    .detail.open { display: block; }
    .back-btn { font-size: 13px; color: #888; cursor: pointer; margin-bottom: 2rem; display: inline-flex; align-items: center; gap: 6px; }
    .detail-cat { font-size: 12px; color: #999; letter-spacing: 0.05em; }
    .detail-title { font-size: 22px; font-weight: 500; margin-top: 6px; line-height: 1.5; }
    .detail-date { font-size: 12px; color: #bbb; margin-top: 8px; }
    .yt-wrap { margin: 1.5rem 0; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; }
    .yt-wrap iframe { width: 100%; height: 100%; border: none; }
    .dl-section-label { font-size: 11px; color: #999; letter-spacing: 0.08em; border-bottom: 0.5px solid #e0e0e0; padding-bottom: 6px; margin-bottom: 1rem; margin-top: 1.5rem; }
    .body-text { font-size: 14px; line-height: 1.9; }
    .tools-list { display: flex; flex-direction: column; gap: 10px; }
    .tool-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: #f7f7f7; border-radius: 8px; font-size: 13px; }
    .tool-name { flex: 1; }
    .tool-link { font-size: 12px; color: #888; text-decoration: underline; white-space: nowrap; }
    .memo { background: #f7f7f7; border-radius: 8px; padding: 1rem 1.25rem; font-size: 14px; line-height: 1.8; }
    .menu-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 0.5rem; }
　　 .menu-item { display: flex; flex-direction: column; padding: 10px 12px; background: #f7f7f7; border-radius: 8px; gap: 3px; }
    .menu-name { font-size: 13px; font-weight: 500; color: #1a1a1a; }
    .menu-desc { font-size: 12px; color: #888; }
    .menu-link { font-size: 12px; color: #888; text-decoration: underline; margin-top: 2px; }
    @media (max-width: 768px) {
      .site { padding: 1.25rem 1rem; }
      .site-title { font-size: 18px; }
      .site-desc { font-size: 12px; margin-top: 0.75rem; line-height: 1.9; }
      .site-desc .profile { font-size: 11px; }
      .nav-row { flex-direction: column; align-items: flex-start; gap: 0.75rem; margin-top: 1rem; }
      .nav { gap: 1rem; }
      .search-wrap input { width: 100%; }
      .scroll-row { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; gap: 1.25rem; }
      .section-divider { margin: 1.75rem 0; }
      .detail-title { font-size: 18px; }
      .body-text { font-size: 13px; }
      .tool-item { font-size: 12px; padding: 8px 10px; }
      .memo { font-size: 13px; }
      .card-title { font-size: 13px; }
    }
  </style>
</head>
<body>
<div class="site">
  <div class="site-header">
    <div class="site-title">mameの穏やかなキッチン</div>
    <div class="site-desc">
      毎日の暮らしの中で、 ごはんを作って、食べる記録です。<br>
      YouTubeで紹介しているレシピや工夫を、 少しだけ丁寧にまとめています。<br>
      がんばりすぎず、ちゃんと食べることを大切に。
      <div class="profile">管理栄養士。 夫と0歳の息子と暮らしています。</div>
    </div>
    <div class="nav-row">
      <nav class="nav">
        <a class="active" onclick="filterCat('all',this)">すべて</a>
        <a onclick="filterCat('1週間献立',this)">1週間献立</a>
        <a onclick="filterCat('せいろごはん',this)">せいろごはん</a>
        <a onclick="filterCat('暮らし',this)">暮らし</a>
      </nav>
      <div class="search-wrap">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#1a1a1a" stroke-width="1.5">
          <circle cx="6" cy="6" r="4"/><line x1="9.5" y1="9.5" x2="13" y2="13"/>
        </svg>
        <input type="text" id="search-input" placeholder="タイトルで検索" oninput="onSearch()">
      </div>
    </div>
  </div>

  <div id="list-view">
    <div id="featured-sections">
      <div class="section-heading"><span class="ja">新着記事</span><span class="en">– New post –</span></div>
      <div class="scroll-row">${newCards}</div>
      <hr class="section-divider">
      <div class="section-heading"><span class="ja">ピックアップ</span><span class="en">– Pick up –</span></div>
      <div class="scroll-row">${pickupCards}</div>
      <hr class="section-divider">
      <div class="section-heading"><span class="ja">すべての記事</span><span class="en">– All posts –</span></div>
    </div>
    <div class="grid" id="card-grid">${allCards}</div>
    <div class="no-results" id="no-results" style="display:none">該当する記事が見つかりませんでした。</div>
  </div>

  <div class="detail" id="detail-view">
    <span class="back-btn" onclick="closeDetail()">← 一覧に戻る</span>
    <div id="detail-content">${allDetails}</div>
  </div>
</div>

<script>
const cards = document.querySelectorAll('.card');
let currentCat = 'all', currentQuery = '';

cards.forEach(card => {
  card.addEventListener('click', () => openDetail(card.dataset.id));
});

function filterCat(cat, el) {
  currentCat = cat;
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  el.classList.add('active');
  renderGrid();
}

function onSearch() {
  currentQuery = document.getElementById('search-input').value.trim();
  renderGrid();
}

function renderGrid() {
  const isFiltering = currentCat !== 'all' || currentQuery !== '';
  document.getElementById('featured-sections').style.display = isFiltering ? 'none' : '';
  let found = 0;
  cards.forEach(card => {
    const cat = card.querySelector('.card-cat').textContent;
    const title = card.querySelector('.card-title').textContent;
    const show = (currentCat === 'all' || cat === currentCat) && (!currentQuery || title.includes(currentQuery));
    card.style.display = show ? '' : 'none';
    if (show) found++;
  });
  document.getElementById('no-results').style.display = found === 0 ? '' : 'none';
}

function openDetail(id) {
  document.getElementById('list-view').style.display = 'none';
  document.getElementById('detail-view').classList.add('open');
  document.querySelectorAll('.detail-inner').forEach(el => {
    el.style.display = el.dataset.id === id ? '' : 'none';
  });
}

function closeDetail() {
  document.getElementById('list-view').style.display = '';
  document.getElementById('detail-view').classList.remove('open');
}
</script>
</body>
</html>`;

  fs.writeFileSync('index.html', html);
  console.log(`Built with ${posts.length} posts.`);
}

main().catch(console.error);
