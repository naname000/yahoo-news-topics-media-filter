'use strict';

// フィルタしたいメディア名は popup で編集し、chrome.storage.sync に保存する
// （JSON-LD の author.name と完全一致で比較）
const BLOCKED_KEY = 'blockedMedia';
const DEFAULT_BLOCKED = [];

// 対象のリスト: トピックス一覧 + 右カラムの「トピックス（主要）」
const ROOT = ':is(#uamods-topics, #yjnSub)';

const CONCURRENCY = 3; // 同時 fetch 数
const CACHE_KEY = 'mediaByPickupId'; // { [pickupId]: mediaName }
const CACHE_MAX = 1000; // これを超えたら古い（ID が小さい）ものから捨てる（起動時に全件分の CSS を作るので控えめに）

let blockedSet = new Set(DEFAULT_BLOCKED);
const labels = new Map(); // pickupId -> 表示するメディア名
let cache = {};

// グレーアウト・メディア名表示とも li に直接触らず CSS で行う（React の DOM と衝突させないため）。
// document_start 時点で li がまだ無くても効くので、キャッシュ済みの記事はちらつかない。
const styleEl = document.createElement('style');
document.documentElement.appendChild(styleEl);

// CSS の content: "..." 用に文字列をエスケープ
const cssString = (s) => '"' + s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ') + '"';

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  // 連続で呼ばれても 1 フレームに 1 回だけ組み立てる
  requestAnimationFrame(() => {
    renderQueued = false;
    const link = (id) => `a[href$="/pickup/${id}"]`;
    const rules = [];
    for (const [id, media] of labels) {
      rules.push(`${ROOT} li ${link(id)}::after { content: ${cssString(media)}; display: block; font-size: 12px; color: #767676; margin-top: 2px; }`);
    }
    // フィルタ対象は消さずにグレーアウトし、メディア名を「フィルタ中：〜」にする
    // （:has() の中は li からの相対なので a だけを書く。
    //   ::after は上のラベル用ルールと詳細度が同じなので、後に書いて上書きする）
    for (const [id, media] of labels) {
      if (!blockedSet.has(media)) continue;
      rules.push(`${ROOT} li:has(> ${link(id)}) { opacity: 0.4; }`);
      rules.push(`${ROOT} li ${link(id)}::after { content: ${cssString('フィルタ中：' + media)}; }`);
    }
    styleEl.textContent = rules.join('\n');
  });
}

function apply(id, media) {
  if (!media) return;
  labels.set(id, media);
  render();
}

// HTML 文字列からメディア名を取り出す
function extractMedia(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 1. JSON-LD の author.name
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.parse(s.textContent);
      for (const item of [].concat(json)) {
        for (const a of [].concat(item?.author ?? [])) {
          if (typeof a?.name === 'string' && a.name) return a.name;
        }
      }
    } catch (_) { /* 壊れた JSON-LD は無視 */ }
  }

  // 2. フォールバック: window.__PRELOADED_STATE__ の topicsDetail.article.mediaName
  for (const s of doc.querySelectorAll('script:not([src])')) {
    const text = s.textContent.trim();
    if (!text.startsWith('window.__PRELOADED_STATE__')) continue;
    try {
      const body = text.slice(text.indexOf('=') + 1).trim().replace(/;$/, '');
      const name = JSON.parse(body)?.topicsDetail?.article?.mediaName;
      if (typeof name === 'string' && name) return name;
    } catch (_) { /* 形式が変わっていたら諦める */ }
  }
  return null;
}

async function lookup(id) {
  const res = await fetch(`/pickup/${id}`, { credentials: 'same-origin' });
  if (!res.ok) return null;
  return extractMedia(await res.text());
}

function collectIds() {
  const ids = new Set();
  for (const a of document.querySelectorAll(`${ROOT} li a[href*="/pickup/"]`)) {
    const m = a.href.match(/\/pickup\/(\d+)$/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function saveCache() {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => Number(a) - Number(b))
      .slice(0, keys.length - CACHE_MAX)
      .forEach((k) => delete cache[k]);
  }
  chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function processList() {
  const queue = collectIds().filter((id) => !(id in cache));
  if (queue.length === 0) return;

  let changed = false;
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const media = await lookup(id);
        if (media) {
          cache[id] = media;
          changed = true;
          apply(id, media);
        }
      } catch (e) {
        console.warn('[yahoo-media-filter] 取得失敗', id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (changed) saveCache();
}

// popup でブロック対象が変わったら、開いているページにもすぐ反映する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[BLOCKED_KEY]) {
    blockedSet = new Set(changes[BLOCKED_KEY].newValue ?? DEFAULT_BLOCKED);
    render();
  }
});

(async () => {
  // ブロック対象とキャッシュを読んで、判定済みのものは即座にメディア名を付ける・グレーアウトする
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(BLOCKED_KEY),
    chrome.storage.local.get(CACHE_KEY),
  ]);
  blockedSet = new Set(sync[BLOCKED_KEY] ?? DEFAULT_BLOCKED);
  cache = local[CACHE_KEY] ?? {};
  for (const [id, media] of Object.entries(cache)) apply(id, media);

  // 一覧が揃ってから未判定分を取りに行く
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', processList, { once: true });
  } else {
    processList();
  }
})();
