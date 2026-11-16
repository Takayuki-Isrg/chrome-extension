const status = document.querySelector('#status');
const button = document.querySelector('#save');

let attempted = false;

document.querySelector('#offline').addEventListener('click', () => chrome.tabs.create({url: chrome.runtime.getURL('offline.html')}));

button.addEventListener('click', async () => {
  if (attempted) return;

  attempted = true;
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const source = new URL(tab.url);

    if (source.protocol !== 'https:' || !['www.google.com', 'www.google.co.jp'].includes(source.hostname) || source.pathname !== '/search') throw new Error('Google検索ページのみ対象です');
    const started = new Date().toISOString();
    const base = `mhtml-spike/capture-${started.replace(/[:.]/g, '-')}`;
    status.textContent = 'MHTML生成中…';
    const blob = await chrome.pageCapture.saveAsMHTML({tabId: tab.id});

    if (!blob || !blob.size) throw new Error('空のMHTMLが返されました');
    // The capture Blob's MIME type may cause Chrome to replace the suffix.
    // Preserve bytes and explicitly mark the archive as MHTML.
    const saved = await download(new Blob([blob], {type: 'multipart/related'}), `${base}.mhtml`);
    status.textContent = 'MHTML保存完了。メタデータ保存中…';
    const metadata = {schema_version: 1, source_kind: 'google_search_snapshot', source_url: tab.url, query: source.searchParams.get('q'), captured_at: started, capture_finished_at: new Date().toISOString(), browser: navigator.userAgent, mhtml_bytes: blob.size, capture_blob_type: blob.type, archive_file: saved.filename, download_mime: saved.mime, warning: 'Search snippets are not linked-page bodies; identity and publication dates are unverified.'};
    await download(new Blob([JSON.stringify(metadata, null, 2)], {type: 'application/json;charset=utf-8'}), `${base}.json`);

    status.textContent = `2ファイル保存完了\n${saved.filename}\n追加保存は無効です。`;
    if (!saved.filename.toLowerCase().endsWith('.mhtml')) status.textContent += '\n注意: 拡張子が変更されています。内容はMHTMLです。';

  } catch (error) {
    status.textContent += `\n失敗: ${error.message}\n片方だけ保存済みの場合があります。追加検索はしないでください。`;
  }
});
