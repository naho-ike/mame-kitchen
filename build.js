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

function escape(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
      title: p['タイトル']?.title?.[0]?.plain_text || '',
      cat: p['カテゴリー']?.select?.name || '',
      date: (p['公開日']?.date?.start || '').replace(/-/g, '.'),
      youtubeUrl: p['YouTube URL']?.url || '',
      point: p['動画について']?.rich_text?.[0]?.plain_text || '',
      tools: p['使った道具']?.rich_text?.[0]?.plain_text || '',
      memo: p['ひとこと']?.rich_text?.[0]?.plain_text || '',
      pickup: p['ピックアップ']?.checkbox || false,
    };
  });

  console.log(`Fetched ${posts.length} posts`);

  // カードHTML生成
  function cardHTML(p) {
    const ytId = getYoutubeId(p.youtubeUrl);
    const img = ytId
      ? `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="${escape(p.title)}">`
      : `<div class="no-img">サムネイルなし</div>`;
    return `<div class="card" data-id="${p.id}"><div class="card-img">${img}</div><div class="card-cat">${escape(p.cat)}</div><div class="card-title">${escape(p.title)}</div><div class="card-date">${escape(p.date)}</div></div>`;
  }

  const newCards = posts.slice(0, 3).map(cardHTML).join('');
  const pickupCards = posts.filter(p => p.pickup).map(cardHTML).join('');
  const allCards = posts.map(cardHTML).join('');

  // 記事詳細HTML生成
  function detailHTML(p) {
    const ytId = getYoutubeId(p.youtubeUrl);
    const ytHtml = ytId ? `<div class="yt-wrap"><iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen></iframe></div>` : '';
    const toolLines = p.tools ? p.tools.split('\n').filter(Boolean) : [];
    const toolsHtml = toolLines.map(t => `<div class="tool-item"><span class="tool-name">${escape(t)}</span></div>`).join('');
    return `<div class="detail-inner" data-id="${p.id}" style="display:none">
      <div class="detail-cat">${escape(p.cat)}</div>
      <div class="detail-title">${escape(p.title)}</div>
      <div class="detail-date">${escape(p.date)}</div>
      ${ytHtml}
      ${p.point ? `<div class="dl-section-label">動画について</div><div class="body-text">${escape(p.point).replace(/\n/g,'<br>')}</div>` : ''}
      ${toolsHtml ? `<div class="dl-section-label">使った道具</div><div class="tools-list">${toolsHtml}</div>` : ''}
      ${p.memo ? `<div class="dl-section-label">ひとこと</div><div class="memo">${escape(p.memo).replace(/\n/g,'<br>')}</div>` : ''}
    </div>`;
  }

  const allDetails = posts.map(detailHTML).join('');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mameの穏やかなキッチン</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', sans-serif; background: #fff; color: #1a1a1a; line-height: 1.7; }
    .site { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; }
    .site-header { border-bottom: 0.5px solid #e0e0e0; padding-bottom: 2rem; margin-bottom: 2rem; }
    .site-title { font-size: 18px; font-weight: 500; letter-spacing: 0.04em; }
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
    .scroll-row { display: grid; grid-t
