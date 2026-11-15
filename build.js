const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.DATABASE_ID;
const TOOLS_DB_ID = process.env.TOOLS_DATABASE_ID;

// 道具の写真を保存するフォルダ（Notionの画像URLは1時間ほどで切れるため、
// ビルド時にダウンロードしてリポジトリに置く）
const IMAGE_DIR = 'images/tools';
const POST_IMAGE_DIR = 'images/posts';

// 道具ページのカテゴリー表示順。Notionのカテゴリー名とそろえること
const TOOL_CATEGORIES = [
  { name: 'せいろと蒸しもの', en: '– Steaming –' },
  { name: '鍋とフライパン', en: '– Pots &amp; pans –' },
  { name: '下ごしらえと保存', en: '– Prep &amp; storage –' },
  { name: '調味料', en: '– Seasonings –' },
  { name: '暮らしの道具', en: '– Living –' },
];

// ステマ規制（景品表示法）とAmazonアソシエイトで必要な広告の表示。
// サイトの説明（全ページ）と、広告リンクを含む記事の両方で同じ文言を使う
const AD_NOTICE = 'このサイトはアフィリエイト広告（Amazonアソシエイト含む）を掲載しています。';

// SNSに貼ったときのリンクプレビューや、記事ごとのURLに使う
const SITE_URL = 'https://mamegurashi.com';
const SITE_NAME = 'mameの穏やかなキッチン';

// サイトの中のファイルは、どの階層のページから参照しても届くように / から書く。
// 記事ページは /posts/xxx/ にあるので、相対パスだと画像にたどり着けない
function asset(p) {
  return p ? `/${String(p).replace(/^\/+/, '')}` : '';
}

// 記事ごとのURL。Notionの「URL名」があればそれを使い、
// 無ければページのidから作る。あとから変えると前のURLが開けなくなる
const warnedSlugs = new Set();
function postSlug(p) {
  const custom = (p.slug || '').trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,60}$/.test(custom)) return custom;
  if (custom && !warnedSlugs.has(p.id)) {
    warnedSlugs.add(p.id);
    console.error(`「URL名」は英小文字・数字・ハイフンだけで書いてください。既定のURLを使います: ${p.title}（${custom}）`);
  }
  // NotionのページIDは、先頭が作った時期で決まるため近い時期の記事どうしで似通う。
  // ランダムに決まる末尾を使う。万一ほかの記事と重なったら、IDをまるごと使う
  const short = p.id.slice(-12);
  return slugOwners.get(short) && slugOwners.get(short) !== p.id ? p.id : short;
}

// 末尾12文字が重なる記事がないかを、記事ページを書き出す前に調べておく
const slugOwners = new Map();
function reserveSlugs(posts) {
  const seen = new Map();
  for (const p of posts) {
    const short = p.id.slice(-12);
    seen.set(short, seen.has(short) ? null : p.id);
  }
  slugOwners.clear();
  for (const [k, v] of seen) if (v) slugOwners.set(k, v); else slugOwners.set(k, '#dup');
}

function postPath(p) {
  return `/posts/${postSlug(p)}/`;
}

// 本文のHTMLから、リンクプレビューに出す説明文を作る。見出しや道具カード、
// ボタンの文字が混ざらないよう、段落（<p>）の文章だけを使う
function leadText(html, limit = 110) {
  const paras = [...String(html || '').matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1]);
  return excerpt(paras.join(' '), limit);
}

// HTMLの文字を取り除いて、短くする
function excerpt(html, limit = 110) {
  const text = String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 本文のいちばん上に出る見出し。Notionの「本文の見出し」が空の記事はこれになる。
// 料理以外の記事では、記事ごとに書き換えられる
const LEAD_LABEL = 'このごはんについて';

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
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 画像を1件ダウンロードして保存する。中身が前回と同じならgitが差分なしと判断するので、
// 毎回上書きして問題ない
function downloadImage(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('リダイレクトが多すぎます'));
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadImage(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          fs.writeFileSync(dest, Buffer.concat(chunks));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// 写真はスマホで撮ったままだと数MBあるので、ビルド時に縮小して軽くする。
// ImageMagick が見つからないときは元のまま使う（ビルドは止めない）
const PHOTO_MAX_PX = 1200;
const PHOTO_QUALITY = 82;

function findImageMagick() {
  for (const cmd of ['magick', 'convert']) {
    try {
      execFileSync(cmd, ['-version'], { stdio: 'ignore' });
      return cmd;
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function shrinkImage(magick, src, dest) {
  execFileSync(magick, [
    src,
    '-auto-orient',                       // スマホの回転情報を反映してから縮小する
    '-resize', `${PHOTO_MAX_PX}x${PHOTO_MAX_PX}>`, // 大きいものだけ縮める
    '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-strip',                             // 撮影場所などのメタ情報を落とす
    '-interlace', 'Plane',                // 粗い絵から段階的に表示される
    '-quality', String(PHOTO_QUALITY),
    dest,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function imageExt(url) {
  const m = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
}

// もしもアフィリエイトのリンクは、URLだけでなく <a href="..."><img ...> のHTMLごと
// 貼られることがある。その場合は href の中身だけを取り出して使う
function normalizeShopUrl(value, shop, toolName) {
  if (!value) return '';
  let url = String(value).trim();

  const href = url.match(/href\s*=\s*["']([^"']+)["']/i);
  if (href) url = href[1].trim();

  // HTMLエンティティを戻す。&amp; のまま出力すると二重エスケープになる
  url = url
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  // //af.moshimo.com/... のようにスキームが省略された形を補う
  if (url.startsWith('//')) url = `https:${url}`;

  if (!/^https?:\/\//i.test(url)) {
    console.error(`${toolName} の「${shop}」がURLとして読めないため、ボタンを出しません: ${url.slice(0, 60)}`);
    return '';
  }
  return url;
}

// Notionのファイルプロパティから1枚目のURLを取り出す
function firstFileUrl(prop) {
  const f = prop?.files?.[0];
  if (!f) return '';
  return f.type === 'external' ? (f.external?.url || '') : (f.file?.url || '');
}

// リンク先として安全なURLだけ通す。javascript: や data: を書かれても
// リンクにしないための歯止め（Notionに貼り間違えたときの保険も兼ねる）
function safeUrl(url, where = 'リンク') {
  if (!url) return '';
  const u = String(url).trim();
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(u)) return u;
  console.error(`${where}に使えないURLが入っていたので、リンクにしませんでした: ${u.slice(0, 60)}`);
  return '';
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
  return richText
    .map(r => {
      const text = r.plain_text || '';
      return text;
    })
    .join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/️/g, '')
    .replace(/​/g, '')
    .replace(/﻿/g, '');
}

// YouTubeのURLから動画のidを取り出す。ショート（/shorts/）も読む。
// ショートは縦長なので、横長の動画と枠の形を変える必要があり、種類も返す。
// idは英数字と - _ だけなので、それ以外が混ざったURLは受け付けない
// （URLを貼り間違えたときに、ページのHTMLが壊れないようにするため）
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

function getYoutube(url) {
  if (!url) return null;
  const short = url.match(/youtube\.com\/shorts\/([^&?/]+)/);
  const long = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&?/]+)/);
  const m = short || long;
  if (!m) return null;
  if (!YOUTUBE_ID.test(m[1])) {
    console.error(`YouTube URL から動画を読み取れませんでした: ${String(url).slice(0, 60)}`);
    return null;
  }
  return { id: m[1], vertical: Boolean(short) };
}

// ---------------------------------------------------------------
// Notionのページ本文（ブロック）を読む
// テキスト欄と違い、画像・箇条書き・Notionの太字などがそのまま使える
// ---------------------------------------------------------------

function notionGet(apiPath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.notion.com',
      path: `/v1/${apiPath}`,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchBlocks(pageId) {
  const out = [];
  let cursor = null;
  do {
    const q = `blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const res = await notionGet(q);
    if (!Array.isArray(res.results)) throw new Error(res.message || 'ページ本文を読めませんでした');
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

function plainOf(richText) {
  return (richText || []).map(r => r.plain_text || '').join('');
}

// 広告リンクかどうか。Googleは広告リンクに sponsored を求めており、
// もしもは遷移先がhttpのときリファラを必要とする
const AFFILIATE_HOSTS = /(^|\.)(moshimo\.com|amazon\.co\.jp|amzn\.to|amzn\.asia|rakuten\.co\.jp|valuecommerce\.com|a8\.net|linksynergy\.com)$/i;

function isAffiliate(url) {
  try {
    return AFFILIATE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Notionのページどうしのリンク（記事→記事、記事→道具管理）は、そのままだと読者が
// Notionに飛ばされてしまう。サイトの中の対応するページに置き換える。
// どちらにも当たらないNotionページ（非公開の下書きなど）はリンクにしない
const notionLinkTargets = new Map();

function notionPageId(href) {
  const u = String(href || '').trim();
  const isNotion = /^\/[^/]/.test(u)
    || /^https?:\/\/([a-z0-9-]+\.)?(notion\.so|notion\.site|notion\.com)\//i.test(u);
  if (!isNotion) return null;
  const hex = u.split(/[?#]/)[0].replace(/-/g, '').match(/[0-9a-f]{32}/gi);
  return hex ? hex[hex.length - 1].toLowerCase() : null;
}

function resolveLink(href) {
  const id = notionPageId(href);
  if (!id) return href;
  const target = notionLinkTargets.get(id);
  if (target) return target;
  console.error(`公開していないNotionページへのリンクだったので、文字だけにしました: ${String(href).slice(0, 80)}`);
  return '';
}

function linkAttrs(url) {
  // サイトの中のページは、同じタブで開く
  if (/^\/(?!\/)/.test(url)) return '';
  return isAffiliate(url)
    ? 'target="_blank" rel="nofollow sponsored noopener" referrerpolicy="no-referrer-when-downgrade"'
    : 'target="_blank" rel="noopener"';
}

// 改行の位置を一度この印にしておいて、装飾を組み終えてからまとめてHTMLにする。
// 区切りに使う空行（改行2つ以上）と、文の途中の改行を見分けるため
const BR_MARK = '';

// 文の途中の改行は、パソコンの幅に合わせて入れたもの。
// スマホでは畳めるように印をつけておく（CSSで消す）
function brMarksToHtml(s) {
  return s
    .replace(new RegExp(`${BR_MARK}{2,}`, 'g'), m => '<br>'.repeat(m.length))
    .replace(new RegExp(BR_MARK, 'g'), '<br class="soft">');
}

// 改行だけを装飾のない切れ端に分ける。太字の末尾に改行があると
// 改行どうしが <strong> をはさんで離れてしまい、空行だと気づけなくなるため
function splitOutBreaks(richText) {
  const out = [];
  for (const r of richText || []) {
    for (const part of (r.plain_text || '').split(/(\n+)/)) {
      if (!part) continue;
      if (part[0] === '\n') out.push({ plain_text: part, annotations: {}, href: null });
      else out.push({ ...r, plain_text: part });
    }
  }
  return out;
}

// Notionの装飾をそのままHTMLにする。太字ボタンや斜体、リンクが効く
function richTextToHtml(richText) {
  return brMarksToHtml(splitOutBreaks(richText).map(r => {
    let t = safeHtml(r.plain_text || '').replace(/\n/g, BR_MARK);
    const a = r.annotations || {};
    if (a.code) t = `<code>${t}</code>`;
    if (a.strikethrough) t = `<s>${t}</s>`;
    if (a.italic) t = `<em>${t}</em>`;
    if (a.bold) t = `<strong>${t}</strong>`;
    if (r.href) {
      const href = safeUrl(resolveLink(r.href), '本文のリンク');
      if (href) t = `<a href="${safeHtml(href)}" ${linkAttrs(href)}>${t}</a>`;
    }
    return t;
  }).join('')
    // テキスト欄から貼り付けたときのために、**強調** も太字として扱う
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
}

// 1つの段落の中で Shift+Enter で改行している場合に備えて、装飾を保ったまま行ごとに分ける。
// Notionでは改行が plain_text の中の \n になることも、段落の切れ目になることもある
function splitRichTextLines(richText) {
  const lines = [[]];
  for (const r of richText || []) {
    const parts = (r.plain_text || '').split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ ...r, plain_text: p });
    });
  }
  return lines;
}

function blocksToHtml(blocks, idPrefix) {
  let html = '';
  let toc = '';
  let headingIndex = 0;
  let listTag = null;
  const skipped = new Set();

  const closeList = () => {
    if (listTag) { html += `</${listTag}>`; listTag = null; }
  };
  const openList = tag => {
    if (listTag !== tag) { closeList(); html += `<${tag} class="body-list">`; listTag = tag; }
  };

  for (const b of blocks) {
    const t = b.type;

    if (t === 'bulleted_list_item' || t === 'numbered_list_item') {
      // 箇条書きの項目が [[道具名]] だけのときも、カードとして差し込む
      const itemEmbed = embedFromLine(plainOf(b[t].rich_text));
      if (itemEmbed) { closeList(); html += itemEmbed; continue; }

      openList(t === 'bulleted_list_item' ? 'ul' : 'ol');
      html += `<li>${richTextToHtml(b[t].rich_text)}</li>`;
      continue;
    }
    closeList();

    if (t === 'paragraph') {
      const plain = plainOf(b.paragraph.rich_text);

      // [[道具名]] や ##見出し## は、段落の途中の行に書かれていることもある。
      // 1行でも該当すれば行ごとに組み立て、なければ今までどおり段落ごと流し込む
      const lines = /(^|\n)\s*(\[\[.+?\]\]|##.+?##)\s*(\n|$)/.test(plain)
        ? splitRichTextLines(b.paragraph.rich_text)
        : null;

      if (!lines) {
        const inner = richTextToHtml(b.paragraph.rich_text);
        if (inner) html += `<p>${inner}</p>`; // 空段落は余白になるだけなので出さない
        continue;
      }

      let buf = [];
      const flushLines = () => {
        // 差し込みの前後にできた空行は、そのままだと余分な改行になるので落とす
        while (buf.length && !buf[0]) buf.shift();
        while (buf.length && !buf[buf.length - 1]) buf.pop();
        // 空行はそのまま区切りの空きに、1つだけの改行はスマホで畳める印にする
        if (buf.length) html += `<p>${brMarksToHtml(buf.join(BR_MARK))}</p>`;
        buf = [];
      };

      for (const line of lines) {
        const text = plainOf(line).trim();

        const embed = embedFromLine(text);
        if (embed) { flushLines(); html += embed; continue; }

        // テキスト欄から貼り付けたときのために、##見出し## も見出しとして扱う
        const pasted = text.match(/^##(.+?)##$/);
        if (pasted) {
          flushLines();
          headingIndex++;
          const anchorId = `${idPrefix}heading-${headingIndex}`;
          html += `<h3 class="body-heading" id="${anchorId}">${safeHtml(pasted[1])}</h3>`;
          toc += `<li><a href="#${anchorId}">${safeHtml(pasted[1])}</a></li>`;
          continue;
        }

        buf.push(richTextToHtml(line));
      }
      flushLines();
    } else if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
      headingIndex++;
      const anchorId = `${idPrefix}heading-${headingIndex}`;
      html += `<h3 class="body-heading" id="${anchorId}">${richTextToHtml(b[t].rich_text)}</h3>`;
      toc += `<li><a href="#${anchorId}">${safeHtml(plainOf(b[t].rich_text))}</a></li>`;
    } else if (t === 'image') {
      if (!b.localSrc) continue; // 取得に失敗した画像は出さない
      const caption = richTextToHtml(b.image.caption);
      const alt = safeHtml(plainOf(b.image.caption));
      html += `<figure class="body-figure"><img src="${safeHtml(asset(b.localSrc))}" alt="${alt}" loading="lazy">`
        + (caption ? `<figcaption>${caption}</figcaption>` : '')
        + `</figure>`;
    } else if (t === 'quote') {
      html += `<blockquote class="body-quote">${richTextToHtml(b.quote.rich_text)}</blockquote>`;
    } else if (t === 'divider') {
      html += '<hr class="body-divider">';
    } else {
      skipped.add(t);
    }
  }
  closeList();

  if (skipped.size) {
    console.log(`  対応していないブロックは飛ばしました: ${[...skipped].join(', ')}`);
  }
  return { html, toc };
}

// 画像を1枚取得して、ImageMagickがあれば縮小して保存する。保存先の相対パスを返す
async function saveImage(url, dir, baseName, magick) {
  const file = `${baseName}${magick ? '.jpg' : imageExt(url)}`;
  const dest = path.join(dir, file);
  const tmp = path.join(dir, `.tmp-${baseName}${imageExt(url)}`);
  try {
    await downloadImage(url, magick ? tmp : dest);
    if (magick) shrinkImage(magick, tmp, dest);
    return `${dir}/${file}`;
  } catch (e) {
    // 取得に失敗しても、前回の画像が残っていればそれを使う
    console.error(`写真を用意できませんでした: ${baseName} — ${e.message}`);
    return fs.existsSync(dest) ? `${dir}/${file}` : '';
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// 使わなくなった画像を消す
function cleanImageDir(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (keep.has(f)) continue;
    fs.unlinkSync(path.join(dir, f));
    console.log(`使わなくなった写真を削除しました: ${dir}/${f}`);
  }
}

// 1行の中の **強調** を太字にする。安全化したあとに置き換えないと
// <strong> が実体参照になって、そのまま画面に出てしまう
function inlineFormat(line) {
  return safeHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// 本文を組み立てる。##見出し## の行は小見出しにして、あわせて目次も返す。
// 記事はすべて1つのHTMLに入るので、idPrefix で見出しのidを記事ごとに分ける
function textToHtml(str, idPrefix = '') {
  if (!str) return { html: '', toc: '' };
  let html = '';
  let toc = '';
  let headingIndex = 0;
  let paragraph = [];

  // 溜めておいた行を1つの段落として書き出す
  const flush = () => {
    if (!paragraph.length) return;
    html += `<p>${paragraph.join('<br class="soft">')}</p>`;
    paragraph = [];
  };

  for (const line of str.split('\n')) {
    const embed = embedFromLine(line);
    if (embed) { flush(); html += embed; continue; }

    const headingMatch = line.match(/^##(.+?)##$/);
    if (headingMatch) {
      flush();
      headingIndex++;
      const headingText = headingMatch[1];
      const anchorId = `${idPrefix}heading-${headingIndex}`;
      html += `<h3 class="body-heading" id="${anchorId}">${safeHtml(headingText)}</h3>`;
      toc += `<li><a href="#${anchorId}">${safeHtml(headingText)}</a></li>`;
    } else if (line.trim() === '') {
      flush(); // 空行が段落の区切りになる
    } else {
      paragraph.push(inlineFormat(line));
    }
  }
  flush();
  return { html, toc };
}

// ---------------------------------------------------------------
// 愛用品を記事本文に差し込む
// 本文に [[道具名]] と書くと、愛用品ページと同じ内容のカードが入る
// ---------------------------------------------------------------

// 道具名 → 道具。main で愛用品を取得したあとに埋める
const toolByName = new Map();

// 表記ゆれを吸収する（空白・全角空白・大文字小文字）
function toolKey(name) {
  // NFKC \u3067\u300c18\u339d\u300d\u3092\u300c18cm\u300d\u306b\u3001\u5168\u89d2\u306e\u82f1\u6570\u5b57\u3092\u534a\u89d2\u306b\u305d\u308d\u3048\u308b
  return (name || '').normalize('NFKC').replace(/[\s\u3000]/g, '').toLowerCase();
}

// 「杉せいろ 18cm（かごや）」のようにメーカー名をカッコで添える書き方があるため、
// カッコを外した形でも引けるようにする。記事側が「かごや 杉せいろ 18cm」でも当たる
function toolKeys(name) {
  const full = toolKey(name);
  const bare = toolKey((name || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ''));
  return bare && bare !== full ? [full, bare] : [full];
}

function shopButtonsHTML(t) {
  // リンクは「もしもアフィリエイト」で取得したものを入れる想定。
  // 未入力のショップはボタンごと出さない
  return [
    ['Amazon', t.amazon],
    ['楽天', t.rakuten],
    ['Yahoo!', t.yahoo],
  ]
    .filter(([, url]) => url)
    .map(([label, url]) => `<a class="shop-btn" href="${safeHtml(url)}" data-shop="${label}" data-tool="${safeHtml(t.name)}" ${linkAttrs(url)}>${label}</a>`)
    .join('');
}

// 記事に差し込むカードは、写真と商品名だけの簡潔な形にする。
// 説明は愛用品ページで読めるので、本文の流れを止めないようにした
function toolEmbedHTML(t) {
  const shops = shopButtonsHTML(t);
  const photo = t.img
    ? `<div class="tool-embed-photo"><img src="${safeHtml(asset(t.img))}" alt="${safeHtml(t.name)}" loading="lazy"></div>`
    : '';
  return `<div class="tool-embed">${photo}<div class="tool-embed-body">`
    + (t.size ? `<div class="tool-size">${safeHtml(t.size)}</div>` : '')
    + `<div class="tool-embed-title">${safeHtml(t.name)}</div>`
    + (shops ? `<div class="tool-shops">${shops}</div>` : '')
    + `</div></div>`;
}

// 書いた名前から道具を探す。完全一致が優先だが、「かごや 杉せいろ 18cm」と
// 「杉せいろ 18cm」のようにどちらかがもう一方を含む場合も、候補が1つなら採用する
function findTool(name) {
  const key = toolKey(name);
  const exact = toolByName.get(key);
  if (exact) return exact;

  // 1つの道具が複数のキーを持つので、当たった道具の重複を取り除いてから数える
  const hits = [...toolByName].filter(([k]) => k.includes(key) || key.includes(k));
  const uniq = [...new Set(hits.map(([, t]) => t))];
  if (uniq.length === 1) return uniq[0];
  if (uniq.length > 1) {
    console.error(`「${name}」に当てはまる愛用品が複数あります: `
      + uniq.map(t => t.name).join(' / '));
  }
  return null;
}

// [[道具名]] だけの行なら、その道具のカードを返す。見つからなければ null
function embedFromLine(line) {
  const m = line.trim().match(/^\[\[(.+?)\]\]$/);
  if (!m) return null;
  const t = findTool(m[1]);
  if (!t) {
    console.error(`愛用品に「${m[1]}」が見つかりません。登録されている道具名: `
      + [...new Set(toolByName.values())].map(x => x.name).join(' / '));
    return null;
  }
  return toolEmbedHTML(t);
}

// ---------------------------------------------------------------
// 共通パーツ（index.html と tools.html で使い回す）
// ---------------------------------------------------------------

const BASE_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', sans-serif; background: #fff; color: #1a1a1a; line-height: 1.7; }
    .site { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; }
    .site-header { border-bottom: 0.5px solid #e0e0e0; padding-bottom: 2rem; margin-bottom: 2rem; }
    .site-title { font-size: 22px; font-weight: 500; letter-spacing: 0.04em; text-decoration: none; color: #1a1a1a; cursor: pointer; }
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
    .section-heading .ja { font-size: 18px; font-weight: 500; }
    .section-heading .en { font-size: 12px; color: #999; letter-spacing: 0.08em; margin-left: 8px; }
    .section-divider { border: none; border-top: 0.5px solid #e0e0e0; margin: 2.5rem 0; }
    .tool-size { font-size: 12px; color: #bbb; letter-spacing: 0.05em; font-variant-numeric: tabular-nums; }
    .tool-shops { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 6px; }
    .shop-btn { flex: 1 1 68px; min-height: 38px; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: #666; text-decoration: none; border: 0.5px solid #e0e0e0; border-radius: 6px; transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease; }
    .shop-btn:hover, .shop-btn:focus-visible { background: #1a1a1a; border-color: #1a1a1a; color: #fff; }
    @media (prefers-reduced-motion: reduce) { .shop-btn { transition: none; } }`;

const INDEX_CSS = `
    .scroll-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1.25rem; margin-bottom: 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2rem; }
    .card { cursor: pointer; display: block; color: inherit; text-decoration: none; }
    .card-img { width: 100%; aspect-ratio: 16/10; background: #f3f3f3; border-radius: 8px; overflow: hidden; }
    .card-img img { width: 100%; height: 100%; object-fit: cover; }
    .card-img .no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #bbb; }
    .card-cat { font-size: 12px; color: #999; margin-top: 10px; letter-spacing: 0.05em; }
    .card-title { font-size: 17px; font-weight: 500; margin-top: 5px; line-height: 1.6; }
    .card-date { font-size: 12.5px; color: #bbb; margin-top: 7px; }
    .no-results { font-size: 16px; color: #999; padding: 2rem 0; }
    .detail { display: none; }
    .detail.open { display: block; }
    .not-found { padding: 2rem 0 4rem; line-height: 2; }
    .not-found p { margin-top: 1rem; }
    .not-found a { color: #1a1a1a; }
    .back-btn { font-size: 13px; color: #888; cursor: pointer; margin-bottom: 2rem; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
    .detail-cat { font-size: 12px; color: #999; letter-spacing: 0.05em; }
    .detail-title { font-size: 22px; font-weight: 500; margin-top: 6px; line-height: 1.5; font-variant-emoji: text; }
    .detail-date { font-size: 12px; color: #bbb; margin-top: 8px; }
    /* 広告の表示。サイトの説明の下に置いて、どのページでも目に入るようにする */
    .pr-note { display: inline-block; font-size: 11px; line-height: 1.6; color: #999; background: #f7f7f7; border-radius: 6px; padding: 7px 12px; margin: 1.25rem 0 0; }
    .yt-wrap { margin: 1.5rem 0; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; }
    /* ショートは縦長。横幅いっぱいにすると画面からあふれるので幅を抑えて左寄せにする */
    .yt-short { aspect-ratio: 9/16; width: min(100%, 340px); }
    .yt-wrap iframe { width: 100%; height: 100%; border: none; }
    .dl-section-label { font-size: 14px; color: #999; letter-spacing: 0.08em; border-bottom: 0.5px solid #e0e0e0; padding-bottom: 8px; margin-bottom: 1rem; margin-top: 1.5rem; }
    /* auto-phrase は文節の切れ目で折り返す。「愛用キッチン道／具」のような
       語の途中での分断を防ぐ。対応していないブラウザでは何も起きない */
    .body-text { font-size: 16px; line-height: 2.25; word-break: auto-phrase; }
    .body-text p { margin-bottom: 1.9em; }
    .body-text p:last-child { margin-bottom: 0; }
    .body-text a { color: #1a1a1a; text-decoration: underline; text-underline-offset: 3px; }
    .body-text code { font-size: 0.9em; background: #f2f2f2; border-radius: 4px; padding: 1px 5px; }
    .body-figure { margin: 1.9em 0; }
    .body-figure img { width: 100%; height: auto; border-radius: 8px; display: block; }
    .body-figure figcaption { font-size: 13px; color: #999; line-height: 1.8; margin-top: 10px; }
    .body-list { margin: 0 0 1.9em; padding-left: 1.4em; }
    .body-list li { margin-bottom: 0.5em; }
    .body-list li:last-child { margin-bottom: 0; }
    .body-quote { margin: 1.9em 0; padding-left: 1.1em; border-left: 2px solid #e0e0e0; color: #555; }
    .body-divider { border: none; border-top: 0.5px solid #e0e0e0; margin: 2.5em 0; }
    .tool-embed { display: flex; gap: 1.1rem; background: #f7f7f7; border-radius: 8px; padding: 1.1rem 1.25rem; margin: 1.9em 0; }
    .tool-embed-photo { flex: 0 0 150px; }
    .tool-embed-photo img { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 6px; display: block; }
    .tool-embed-body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; }
    .tool-embed-title { font-size: 16px; font-weight: 500; line-height: 1.55; }
    .tool-embed-body .tool-shops { margin-top: 0; padding-top: 0; }
    .body-heading { font-size: 19px; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; color: #1a1a1a; }
    /* 本文の見出しの上に区切り線を引いて、話の切れ目を分かりやすくする。
       本文のいちばん最初の見出しは、すぐ上に「このごはんについて」の線があるので引かない */
    .body-text .body-heading { border-top: 1px solid #e0e0e0; padding-top: 2rem; margin-top: 2.5rem; }
    .body-text .body-heading:first-child { border-top: none; padding-top: 0; margin-top: 0.5rem; }
    .toc-box { background: #f7f7f7; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
    .toc-title { font-size: 12px; color: #999; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .toc-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .toc-list a { font-size: 13px; color: #1a1a1a; text-decoration: none; }
    .toc-list a:hover { text-decoration: underline; }
    .memo { background: #f7f7f7; border-radius: 8px; padding: 1.15rem 1.4rem; font-size: 16px; line-height: 1.95; word-break: auto-phrase; }
    .memo p + p { margin-top: 0.9em; }
    .tools-note { background: #f7f7f7; border-radius: 8px; padding: 14px 16px; font-size: 15px; }
    .tools-note a { color: #666; text-decoration: underline; }
    .menu-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 0.5rem; }
    .menu-item { display: flex; flex-direction: column; padding: 12px 14px; background: #f7f7f7; border-radius: 8px; gap: 4px; }
    .menu-name { font-size: 16px; font-weight: 500; color: #1a1a1a; }
    .menu-desc { font-size: 14.5px; color: #888; line-height: 1.75; }
    .menu-link { font-size: 13.5px; color: #888; text-decoration: underline; }
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
      .body-text { font-size: 15px; }
      .memo { font-size: 15px; }
      /* パソコンの幅に合わせて入れた文中の改行は、狭い画面では
         中途半端な位置に残ってしまうので畳む。空行の区切りは残る */
      .body-text br.soft, .memo br.soft { display: none; }
      .tool-embed { flex-direction: column; gap: 0.9rem; }
      .tool-embed-photo { flex: none; }
      .tool-embed-photo img { aspect-ratio: 4/3; }
      .card-title { font-size: 15.5px; }
    }`;

const TOOLS_CSS = `
    .tools-lead { font-size: 15px; line-height: 2.1; max-width: 34em; display: flex; flex-direction: column; gap: 0.75rem; }
    .pr-note { display: inline-block; font-size: 11px; line-height: 1.6; color: #999; background: #f7f7f7; border-radius: 6px; padding: 7px 12px; margin-top: 1.25rem; }
    .tool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2rem; }
    .tool-card { display: flex; flex-direction: column; gap: 8px; border-top: 0.5px solid #e0e0e0; padding-top: 1rem; }
    .tool-photo { aspect-ratio: 4/3; background: #f3f3f3; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .tool-photo img { width: 100%; height: 100%; object-fit: cover; }
    .tool-photo .no-img { font-size: 12px; color: #bbb; }
    .tool-title { font-size: 17px; font-weight: 500; line-height: 1.6; }
    .tool-desc { font-size: 15px; line-height: 1.95; color: #555; }
    .tool-desc p + p { margin-top: 0.6em; }
    .tools-empty { font-size: 14px; color: #999; padding: 2rem 0; }
    @media (max-width: 768px) {
      .site { padding: 1.25rem 1rem; }
      .site-title { font-size: 18px; }
      .site-desc { font-size: 12px; margin-top: 0.75rem; line-height: 1.9; }
      .site-desc .profile { font-size: 11px; }
      .nav-row { flex-direction: column; align-items: flex-start; gap: 0.75rem; margin-top: 1rem; }
      .nav { gap: 1rem; }
      .tools-lead { font-size: 14px; line-height: 1.95; }
      .tool-grid { grid-template-columns: 1fr; gap: 1.25rem; }
      .tool-title { font-size: 15.5px; }
      .tool-desc { font-size: 15px; }
      .section-divider { margin: 1.75rem 0; }
    }
`;

// 商品リンクのクリックを、Googleアナリティクスに「どの記事の・どの商品の・どこから」で送る。
// 記事ページ・愛用品ページの両方の末尾に置く。ボタンごとに書かず、ページ全体で拾う
const CLICK_TRACKING = `<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[rel~="sponsored"]');
  if (!a || typeof gtag !== 'function') return;

  var place = a.closest('.tool-embed') ? 'article_card'
    : a.closest('.tool-card') ? 'tools_page'
    : a.closest('.menu-list') ? 'menu'
    : a.closest('.body-text') ? 'article_text'
    : 'other';
  var host = '';
  try { host = new URL(a.href).hostname; } catch (err) {}

  gtag('event', 'affiliate_click', {
    shop: a.dataset.shop || host,
    tool: a.dataset.tool || (a.textContent || '').trim().slice(0, 60),
    place: place,
    page_path: location.pathname,
    transport_type: 'beacon'
  });
}, true);
</script>`;

// 公開をやめた記事のページが残らないよう、いま公開中のもの以外を消す
function cleanPostPages(keep) {
  if (!fs.existsSync('posts')) return;
  for (const name of fs.readdirSync('posts')) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join('posts', name), { recursive: true, force: true });
    console.log(`公開していない記事のページを削除しました: posts/${name}`);
  }
}

const GA_TAG = `  <!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-8MM6439TZJ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-8MM6439TZJ');
</script>`;

// meta は、SNSに貼ったときのプレビューと検索結果の見え方を決める。
// { path, desc, image, type } を渡すと、そのページのものを出す
function pageHead(title, css, meta = {}) {
  const url = `${SITE_URL}${meta.path || '/'}`;
  const desc = meta.desc || '毎日の暮らしの中で、ごはんを作って、食べる記録です。';
  const image = !meta.image ? '' : /^https?:\/\//.test(meta.image) ? meta.image : `${SITE_URL}${asset(meta.image)}`;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <style>* { -webkit-text-size-adjust: 100%; }</style>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="format-detection" content="telephone=no, date=no, email=no, address=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>${title}</title>${meta.noindex ? '\n  <meta name="robots" content="noindex">' : ''}
  <meta name="description" content="${safeHtml(desc)}">
  <link rel="canonical" href="${safeHtml(url)}">
  <meta property="og:type" content="${meta.type || 'website'}">
  <meta property="og:site_name" content="${safeHtml(SITE_NAME)}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${safeHtml(desc)}">
  <meta property="og:url" content="${safeHtml(url)}">${image ? `
  <meta property="og:image" content="${safeHtml(image)}">` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  <style>${BASE_CSS}${css}
  </style>
${GA_TAG}
</head>
<body>`;
}

const SITE_DESC = `    <div class="site-desc">
      毎日の暮らしの中で、 ごはんを作って、食べる記録です。<br>
      YouTubeで紹介しているレシピや工夫を、 少しだけ丁寧にまとめています。<br>
      がんばりすぎず、ちゃんと食べることを大切に。
      <div class="profile">管理栄養士。 夫と0歳の息子と暮らしています。</div>
    </div>
    <p class="pr-note">${AD_NOTICE}</p>`;

// ---------------------------------------------------------------

// 公開日が来ているかどうか。「2026-09-19」のように日付だけのときは
// 日本時間のその日の0時、時刻まで入れてあるときはその時刻に公開する。
// 空欄なら止めない（日付を入れ忘れた記事を消してしまわないため）
function isPublished(start, now = Date.now()) {
  if (!start) return true;
  const ms = Date.parse(start.length <= 10 ? `${start}T00:00:00+09:00` : start);
  return Number.isNaN(ms) || ms <= now;
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
      pageId: page.id,
      title: richTextToPlain(p['タイトル']?.title),
      cat: p['カテゴリー']?.select?.name || '',
      date: (p['公開日']?.date?.start || '').replace(/-/g, '.'),
      publishAt: p['公開日']?.date?.start || '',
      youtubeUrl: p['YouTube URL']?.url || '',
      point: richTextToPlain(p['動画について']?.rich_text),
      lead: richTextToPlain(p['本文の見出し']?.rich_text).trim(),
      slug: richTextToPlain(p['URL名']?.rich_text).trim(),
      memo: richTextToPlain(p['ひとこと']?.rich_text),
      menu: richTextToPlain(p['献立メモ']?.rich_text),
      pickup: p['ピックアップ']?.checkbox || false,
    };
  })
    // 公開日がまだ来ていない記事は出さない。動画の公開に合わせて予約できる
    .filter(post => {
      if (isPublished(post.publishAt)) return true;
      console.log(`公開日がまだ来ていないので出しません: ${post.title}（${post.publishAt}）`);
      return false;
    });

  console.log(`Fetched ${posts.length} posts`);

  // ---- ページ本文（ブロック）を読む ----
  // 本文が書かれていればそちらを使い、空ならこれまでどおりテキスト欄を使う
  const magick = findImageMagick();
  if (!magick) console.error('ImageMagickが見つかりません。写真を縮小せずそのまま使います');

  let blocksOk = true;
  const usedPostImages = new Set();
  for (const post of posts) {
    try {
      const blocks = await fetchBlocks(post.pageId);
      if (!blocks.length) continue;

      const images = blocks.filter(b => b.type === 'image');
      if (images.length) fs.mkdirSync(POST_IMAGE_DIR, { recursive: true });
      for (const b of images) {
        const src = b.image?.type === 'external' ? b.image.external?.url : b.image?.file?.url;
        if (src) b.localSrc = await saveImage(src, POST_IMAGE_DIR, b.id.replace(/-/g, ''), magick);
      }

      // 画像だけを置いた状態でページ本文を採用すると、テキスト欄の文章が
      // まるごと消えてしまう。文章が入っているときだけ採用する
      const TEXT_BLOCKS = ['paragraph', 'heading_1', 'heading_2', 'heading_3',
        'bulleted_list_item', 'numbered_list_item', 'quote'];
      const hasText = blocks.some(b2 =>
        TEXT_BLOCKS.includes(b2.type) && plainOf(b2[b2.type]?.rich_text).trim());
      if (!hasText) {
        console.error(`ページ本文に文章がないため、テキスト欄を使います: ${post.title}`
          + '（画像を本文中に入れるには、文章もページ本文へ移してください）');
        continue;
      }

      // 本文に [[道具名]] を書けるよう、愛用品を取得したあとにHTML化する
      post.blocks = blocks;
      for (const b2 of images) if (b2.localSrc) usedPostImages.add(path.basename(b2.localSrc));
      console.log(`ページ本文を使います: ${post.title}（画像${images.length}枚）`);
    } catch (e) {
      blocksOk = false;
      console.error(`ページ本文を読めませんでした: ${post.title} — ${e.message}`);
    }
  }

  // すべて読めたときだけ、使わなくなった本文の画像を消す
  if (blocksOk) {
    cleanImageDir(POST_IMAGE_DIR, usedPostImages);
  }

  // ---- 道具データを取得 ----
  let tools = [];
  if (TOOLS_DB_ID) {
    try {
      const toolsResult = await notionRequest(`databases/${TOOLS_DB_ID}/query`, {
        filter: { property: '公開', checkbox: { equals: true } },
        sorts: [{ property: '並び順', direction: 'ascending' }]
      });

      if (!Array.isArray(toolsResult.results)) {
        throw new Error(toolsResult.message || '道具データベースを読み込めませんでした');
      }

      tools = toolsResult.results.map(page => {
        const p = page.properties;
        const name = richTextToPlain(p['道具名']?.title);
        return {
          id: page.id.replace(/-/g, ''),
          name,
          cat: p['カテゴリー']?.select?.name || '',
          note: richTextToPlain(p['ひとこと']?.rich_text),
          size: richTextToPlain(p['サイズ']?.rich_text),
          amazon: normalizeShopUrl(p['Amazon URL']?.url, 'Amazon URL', name),
          rakuten: normalizeShopUrl(p['楽天 URL']?.url, '楽天 URL', name),
          yahoo: normalizeShopUrl(p['Yahoo URL']?.url, 'Yahoo URL', name),
          photoUrl: firstFileUrl(p['写真']),
          img: '',
        };
      });

      console.log(`Fetched ${tools.length} tools`);

      // 写真をダウンロードしてリポジトリに保存する
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      for (const t of tools) {
        if (!t.photoUrl) continue;
        const file = `${t.id}${magick ? '.jpg' : imageExt(t.photoUrl)}`;
        const dest = path.join(IMAGE_DIR, file);
        const tmp = path.join(IMAGE_DIR, `.tmp-${t.id}${imageExt(t.photoUrl)}`);
        try {
          await downloadImage(t.photoUrl, magick ? tmp : dest);
          if (magick) {
            shrinkImage(magick, tmp, dest);
            const before = fs.statSync(tmp).size, after = fs.statSync(dest).size;
            console.log(`写真を圧縮しました: ${t.name} — ${(before / 1e6).toFixed(1)}MB → ${(after / 1e3).toFixed(0)}KB`);
          }
          t.img = `${IMAGE_DIR}/${file}`;
        } catch (e) {
          // 取得や変換に失敗しても、前回の写真が残っていればそれを使う
          console.error(`写真を用意できませんでした: ${t.name} — ${e.message}`);
          if (fs.existsSync(dest)) t.img = `${IMAGE_DIR}/${file}`;
        } finally {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        }
      }

      // 道具を削除したときや拡張子が変わったときに、使わない写真が残らないようにする
      const keep = new Set(tools.map(t => t.img && path.basename(t.img)).filter(Boolean));
      for (const f of fs.readdirSync(IMAGE_DIR)) {
        if (keep.has(f)) continue;
        fs.unlinkSync(path.join(IMAGE_DIR, f));
        console.log(`使わなくなった写真を削除しました: ${f}`);
      }
    } catch (e) {
      console.error(`道具データの取得に失敗しました: ${e.message}`);
      tools = [];
    }
  } else {
    console.log('TOOLS_DATABASE_ID が未設定のため、道具ページは生成しません');
  }

  // 本文の [[道具名]] を引けるようにしてから、ページ本文を組み立てる
  for (const t of tools) for (const k of toolKeys(t.name)) toolByName.set(k, t);

  // 本文の中のNotionリンクを、記事ページ・愛用品ページの場所に置き換えられるようにする
  reserveSlugs(posts);
  for (const p of posts) notionLinkTargets.set(p.id.toLowerCase(), postPath(p));
  for (const t of tools) notionLinkTargets.set(t.id.toLowerCase(), `/tools#tool-${t.id}`);
  for (const post of posts) {
    if (post.blocks) {
      post.body = blocksToHtml(post.blocks, `${post.id}-`);
      // リンクプレビュー用に、本文に入っている画像の場所を控えておく
      post.body.images = post.blocks.filter(b => b.type === 'image' && b.localSrc).map(b => b.localSrc);
    }
  }

  // ---- index.html ----

  function cardHTML(p) {
    const yt = getYoutube(p.youtubeUrl);
    // ショートのサムネイルは縦長。mqdefault だと左右に黒帯が入るので、
    // 縦のまま返ってくる maxresdefault を先に試し、無ければ mqdefault に戻す
    const img = yt
      ? `<img src="https://img.youtube.com/vi/${yt.id}/${yt.vertical ? 'maxresdefault' : 'mqdefault'}.jpg"`
        + ` alt="${safeHtml(p.title)}"`
        + (yt.vertical ? ` onerror="this.onerror=null;this.src='https://img.youtube.com/vi/${yt.id}/mqdefault.jpg'"` : '')
        + `>`
      : `<div class="no-img">サムネイルなし</div>`;
    // 記事ごとのページへのリンク。SNSから直接その記事に飛べるようにする
    return `<a class="card" href="${postPath(p)}" data-id="${p.id}"><div class="card-img">${img}</div><div class="card-cat">${safeHtml(p.cat)}</div><div class="card-title">${safeHtml(p.title)}</div><div class="card-date">${safeHtml(p.date)}</div></a>`;
  }

  function detailHTML(p) {
    const yt = getYoutube(p.youtubeUrl);
    const ytHtml = yt
      ? `<div class="yt-wrap${yt.vertical ? ' yt-short' : ''}"><iframe src="https://www.youtube.com/embed/${yt.id}" allowfullscreen></iframe></div>`
      : '';

    const menuLines = p.menu ? p.menu.split('\n').filter(Boolean) : [];
    const menuItems = [];
    for (const line of menuLines) {
      if (/^https?:\/\//.test(line.trim())) {
        if (menuItems.length > 0) menuItems[menuItems.length - 1].url = line.trim();
      } else {
        const cleaned = line.replace(/｜/g, '|').replace(/\\\|/g, '|');
        const parts = cleaned.split('|').map(s => s.trim());
        menuItems.push({ name: parts[0] || '', desc: parts[1] || '', url: parts[2] || '' });
      }
    }
    const menuHtml = menuItems.map(({ name, desc, url }) => {
      // 献立の参考リンクに買い物先を入れることもあるので、広告リンクなら印を付ける
      const link = url ? `<a class="menu-link" href="${safeHtml(url)}" ${linkAttrs(url)}>参考レシピを見る →</a>` : '';
      return `<div class="menu-item">
        <span class="menu-name">${safeHtml(name)}</span>
        ${desc ? `<span class="menu-desc">${safeHtml(desc)}</span>` : ''}
        ${link}
      </div>`;
    }).join('');

    // 使った道具は記事ごとに書かず、道具ページへ誘導する
    const toolsLink = tools.length
      ? `<div class="dl-section-label">使ったもの</div>
      <div class="tools-note"><a href="/tools">愛用しているものは、愛用品のページにまとめています →</a></div>`
      : '';

    const bodySection = (p.body?.html || p.point) ? (() => {
      // ページ本文が書かれていればそちらを優先する
      const { html, toc } = p.body?.html ? p.body : textToHtml(p.point, `${p.id}-`);
      const tocHtml = toc ? `<div class="toc-box"><div class="toc-title">目次</div><ul class="toc-list">${toc}</ul></div>` : '';
      return `<div class="dl-section-label">${safeHtml(p.lead || LEAD_LABEL)}</div>${tocHtml}<div class="body-text">${html}</div>`;
    })() : '';

    const menuSection = menuHtml
      ? `<div class="dl-section-label">今週の献立</div><div class="menu-list">${menuHtml}</div>`
      : '';

    const memoSection = p.memo
      ? `<div class="dl-section-label">最後に</div><div class="memo">${textToHtml(p.memo, `${p.id}-memo-`).html}</div>`
      : '';

    // 広告の表示はサイトの説明に置いて全ページで出しているので、記事ごとには出さない
    const inner = `<article class="detail-inner" data-id="${p.id}">
      <div class="detail-cat">${safeHtml(p.cat)}</div>
      <h1 class="detail-title">${safeHtml(p.title)}</h1>
      <div class="detail-date">${safeHtml(p.date)}</div>
      ${ytHtml}
      ${bodySection}
      ${menuSection}
      ${memoSection}
      ${toolsLink}
    </article>`;

    // リンクプレビューに出す写真は、本文の1枚目。無ければ動画のサムネイル
    const firstImage = (p.body?.images || [])[0] || '';
    return {
      inner,
      desc: leadText(bodySection) || leadText(memoSection),
      image: firstImage,
      ytThumb: yt ? `https://img.youtube.com/vi/${yt.id}/${yt.vertical ? 'maxresdefault' : 'mqdefault'}.jpg` : '',
      searchText: excerpt(`${p.title} ${bodySection} ${menuSection} ${memoSection}`, 100000).toLowerCase(),
    };
  }

  reserveSlugs(posts);
  const articles = posts.map(p => ({ post: p, ...detailHTML(p) }));

  // ---- 記事ごとのページ ----
  // SNSから直接その記事に飛べるように、1記事1ページで書き出す
  const CATS = ['1週間献立', 'せいろごはん', '暮らし'];
  const linkNav = active => {
    const item = (label, href) =>
      `<a${label === active ? ' class="active"' : ''} href="${href}">${label}</a>`;
    return [
      item('すべて', '/'),
      ...CATS.map(c => item(c, `/?cat=${encodeURIComponent(c)}`)),
      ...(tools.length ? [item('愛用品', '/tools')] : []),
    ].join('\n        ');
  };

  const siteHeader = active => `  <div class="site-header">
    <a class="site-title" href="/">${SITE_NAME}</a>
${SITE_DESC}
    <div class="nav-row">
      <nav class="nav">
        ${linkNav(active)}
      </nav>
    </div>
  </div>`;

  for (const a of articles) {
    const p = a.post;
    const dir = path.join('posts', postSlug(p));
    fs.mkdirSync(dir, { recursive: true });
    const html = `${pageHead(`${safeHtml(p.title)}｜${SITE_NAME}`, INDEX_CSS, {
      path: postPath(p),
      desc: a.desc,
      image: a.image || a.ytThumb,
      type: 'article',
    })}
<div class="site">
${siteHeader(p.cat)}
  <a class="back-btn" href="/">← 一覧に戻る</a>
${a.inner}
</div>
${CLICK_TRACKING}
</body>
</html>`;
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }
  cleanPostPages(new Set(posts.map(postSlug)));
  console.log(`Built ${articles.length} post pages under posts/.`);

  // ---- index.html ----

  const newCards = posts.slice(0, 3).map(cardHTML).join('');
  const pickupCards = posts.filter(p => p.pickup).map(cardHTML).join('');
  const allCards = posts.map(cardHTML).join('');

  // 本文は記事ページへ移したので、検索用の文字だけを持たせる
  const searchIndex = JSON.stringify(Object.fromEntries(articles.map(a => [a.post.id, a.searchText])));

  const html = `${pageHead(SITE_NAME, INDEX_CSS)}
<div class="site">
  <div class="site-header">
    <a class="site-title" href="/">${SITE_NAME}</a>
${SITE_DESC}
    <div class="nav-row">
      <nav class="nav">
        <a class="active" onclick="filterCat('all',this)">すべて</a>
        <a onclick="filterCat('1週間献立',this)">1週間献立</a>
        <a onclick="filterCat('せいろごはん',this)">せいろごはん</a>
        <a onclick="filterCat('暮らし',this)">暮らし</a>${tools.length ? `\n        <a href="/tools">愛用品</a>` : ''}
      </nav>
      <div class="search-wrap">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#1a1a1a" stroke-width="1.5">
          <circle cx="6" cy="6" r="4"/><line x1="9.5" y1="9.5" x2="13" y2="13"/>
        </svg>
        <input type="text" id="search-input" placeholder="キーワードで検索" oninput="onSearch()">
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
</div>

<script>
const cards = document.querySelectorAll('.card');
let currentCat = 'all', currentQuery = '';

// 記事ごとの検索用テキスト。本文は記事ページにあるので、ここでは文字だけ持つ
var searchText = ${searchIndex};

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
  const terms = currentQuery.toLowerCase().split(/[\s\u3000]+/).filter(Boolean);
  cards.forEach(card => {
    const cat = card.querySelector('.card-cat').textContent;
    const hay = searchText[card.dataset.id] || card.querySelector('.card-title').textContent.toLowerCase();
    const show = (currentCat === 'all' || cat === currentCat)
      && terms.every(t => hay.indexOf(t) !== -1);
    card.style.display = show ? '' : 'none';
    if (show) found++;
  });
  document.getElementById('no-results').style.display = found === 0 ? '' : 'none';
}

// 道具ページや記事ページから「せいろごはん」で戻ってきたときに、その分類で開く
var initialCat = new URLSearchParams(location.search).get('cat');
if (initialCat) {
  document.querySelectorAll('.nav a').forEach(function (a) {
    if (a.textContent.trim() === initialCat) filterCat(initialCat, a);
  });
}
</script>
</body>
</html>`;

  fs.writeFileSync('index.html', html);
  console.log(`Built index.html with ${posts.length} posts.`);

  // ---- 404.html ----
  // 存在しないURLで開かれたときのページ。これが無いと、Cloudflare Pages は
  // どんなURLにもトップページを返してしまい、検索エンジンからは同じ内容の
  // ページが無数にあるように見える
  const notFound = `${pageHead(`ページが見つかりません｜${SITE_NAME}`, INDEX_CSS, { path: '/404', noindex: true })}
<div class="site">
${siteHeader('')}
  <div class="not-found">
    <h1 class="detail-title">お探しのページが見つかりませんでした</h1>
    <p>記事のURLが変わったか、公開を終えた記事かもしれません。</p>
    <p><a href="/">記事の一覧から探す →</a></p>
  </div>
</div>
</body>
</html>`;
  fs.writeFileSync('404.html', notFound);

  // ---- tools.html ----

  if (!tools.length) {
    console.log('道具の登録がないため、tools.html は生成しませんでした');
    return;
  }

  function toolCardHTML(t) {
    const photo = t.img
      ? `<img src="${safeHtml(asset(t.img))}" alt="${safeHtml(t.name)}" loading="lazy">`
      : `<div class="no-img">写真なし</div>`;
    const shops = shopButtonsHTML(t);
    return `<div class="tool-card" id="tool-${t.id}">
        <div class="tool-photo">${photo}</div>
        ${t.size ? `<div class="tool-size">${safeHtml(t.size)}</div>` : ''}
        <div class="tool-title">${safeHtml(t.name)}</div>
        ${t.note ? `<div class="tool-desc">${textToHtml(t.note, `${t.id}-note-`).html}</div>` : ''}
        ${shops ? `<div class="tool-shops">${shops}</div>` : ''}
      </div>`;
  }

  // カテゴリー順に並べ、決めた順番にないカテゴリーは最後にまとめる
  const known = TOOL_CATEGORIES.map(c => c.name);
  const extras = [...new Set(tools.map(t => t.cat).filter(c => c && !known.includes(c)))];
  const groups = [...TOOL_CATEGORIES, ...extras.map(name => ({ name, en: '' }))]
    .map(c => ({ ...c, items: tools.filter(t => t.cat === c.name) }))
    .filter(c => c.items.length);

  const uncategorized = tools.filter(t => !t.cat);
  if (uncategorized.length) groups.push({ name: 'そのほか', en: '', items: uncategorized });

  const toolsSections = groups.map((g, i) => `
      <div class="section-heading"><span class="ja">${safeHtml(g.name)}</span>${g.en ? `<span class="en">${g.en}</span>` : ''}</div>
      <div class="tool-grid">${g.items.map(toolCardHTML).join('')}</div>${i < groups.length - 1 ? '\n      <hr class="section-divider">' : ''}`).join('');

  const catLink = c => `<a href="/?cat=${encodeURIComponent(c)}">${c}</a>`;

  const toolsHtml = `${pageHead(`愛用品｜${SITE_NAME}`, TOOLS_CSS, { path: '/tools', desc: '毎日使っていて、心地がいいなと思うキッチン道具をまとめています。動画でよく聞かれるものも、こちらに置いています。' })}
<div class="site">
  <div class="site-header">
    <a class="site-title" href="/">mameの穏やかなキッチン</a>
${SITE_DESC}
    <div class="nav-row">
      <nav class="nav">
        <a href="/">すべて</a>
        ${catLink('1週間献立')}
        ${catLink('せいろごはん')}
        ${catLink('暮らし')}
        <a class="active" href="/tools">愛用品</a>
      </nav>
    </div>
  </div>

  <div class="section-heading"><span class="ja">愛用しているもの</span><span class="en">– My favorites –</span></div>
  <div class="tools-lead">
    <p>毎日使っていて、心地がいいなと思うものをまとめています。</p>
    <p>動画でよく聞かれるものも、こちらに置いています。</p>
  </div>
  <hr class="section-divider">
${toolsSections}
</div>
${CLICK_TRACKING}
</body>
</html>`;

  fs.writeFileSync('tools.html', toolsHtml);
  console.log(`Built tools.html with ${tools.length} tools.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
