'use strict';

// content.js と同じキー・初期値
const BLOCKED_KEY = 'blockedMedia';
const DEFAULT_BLOCKED = [];
const CACHE_KEY = 'mediaByPickupId';

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const candidatesEl = document.getElementById('candidates');

const currentLines = () => listEl.value.split('\n').map((s) => s.trim()).filter(Boolean);

async function save() {
  const list = [...new Set(currentLines())];
  await chrome.storage.sync.set({ [BLOCKED_KEY]: list });
  listEl.value = list.join('\n');
  statusEl.textContent = '保存しました';
  setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

(async () => {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(BLOCKED_KEY),
    chrome.storage.local.get(CACHE_KEY),
  ]);
  listEl.value = (sync[BLOCKED_KEY] ?? DEFAULT_BLOCKED).join('\n');

  // キャッシュにあるメディア名を件数の多い順に並べる
  const counts = new Map();
  for (const media of Object.values(local[CACHE_KEY] ?? {})) {
    counts.set(media, (counts.get(media) ?? 0) + 1);
  }
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  if (names.length === 0) {
    candidatesEl.textContent = 'トピックス一覧を開くと、ここに候補が出ます。';
  }
  for (const name of names) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.addEventListener('click', () => {
      if (!currentLines().includes(name)) {
        listEl.value = [...currentLines(), name].join('\n');
      }
    });
    candidatesEl.appendChild(btn);
  }
})();

document.getElementById('save').addEventListener('click', save);
