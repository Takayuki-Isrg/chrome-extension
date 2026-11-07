let archiveEvidence;
const status = document.querySelector('#status');
const exportButton = document.querySelector('#export');
document.querySelector('#archive').addEventListener('change', () => { archiveEvidence = undefined; });
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  try {
    const file = document.querySelector('#archive').files[0];
    if (!file) throw new Error('既存ファイルを選択してください');
    const header = await file.slice(0, 16384).text();
    if (!/^MIME-Version:\s*1\.0/im.test(header) || !/^Content-Type:\s*multipart\/related/im.test(header)) throw new Error('MHTMLのMIMEヘッダーを確認できません');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    status.textContent = '保存中…';
    const saved = await download(new Blob([file], {type: 'multipart/related'}), 'mhtml-spike/offline-reexport.mhtml');
    archiveEvidence = {original_file: file.name, original_bytes: file.size, original_sha256: sha256, saved_file: saved.filename};
    const log = {...archiveEvidence, downloaded_bytes: saved.bytes, download_mime: saved.mime, reexported_at: new Date().toISOString(), operation: 'offline_reexport_not_new_capture'};
    await download(new Blob([JSON.stringify(log, null, 2)], {type: 'application/json;charset=utf-8'}), 'mhtml-spike/offline-reexport.json');
    status.textContent = `保存完了: ${saved.filename}\nMIME: ${saved.mime}\nサイズ: ${saved.bytes}\n元ファイルSHA-256: ${sha256}`;
    if (!saved.filename.toLowerCase().endsWith('.mhtml')) status.textContent += '\n拡張子変更が再現しました。再試行せず結果を知らせてください。';
  } catch (error) {
    status.textContent = `失敗: ${error.message}\n部分保存の可能性があります。`;
  } finally { exportButton.disabled = false; }
});
document.querySelector('#record').addEventListener('click', async () => {
  const output = document.querySelector('#record-status');
  try {
    if (!archiveEvidence) throw new Error('先に既存MHTMLの再保存を完了してください');
    const title = document.querySelector('#title').value.trim();
    const url = new URL(document.querySelector('#url').value.trim());
    if (!title || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('タイトルと認証情報を含まないHTTP(S) URLを入力してください');
    if (['google.com', 'google.co.jp'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Googleの転送URLではなく、移動先のURLを記録してください');
    if (!document.querySelector('#confirmed').checked) throw new Error('ページと検索結果の対応を手動で確認してください');
    const record = {schema_version: 1, source_kind: 'manually_verified_destination', archive: archiveEvidence, result_title: title, destination_url: url.href, verified_at: new Date().toISOString(), verification_method: 'user_opened_page_and_confirmed_title_and_site', article_published_at: null, body_captured: false};
    const saved = await download(new Blob([JSON.stringify(record, null, 2)], {type: 'application/json;charset=utf-8'}), 'mhtml-spike/manual-url.json');
    output.textContent = `保存完了: ${saved.filename}`;
  } catch (error) { output.textContent = `失敗: ${error.message}`; }
});
