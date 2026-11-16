// Shared by live capture and offline re-export. No network requests.
async function download(blob, filename) {
  const url = URL.createObjectURL(blob);

  try {
    const id = await chrome.downloads.download({url, filename, conflictAction: 'uniquify', saveAs: false});
    const deadline = Date.now() + 120000;

    while (Date.now() < deadline) {
      const [item] = await chrome.downloads.search({id});

      if (!item) throw new Error('ダウンロードが見つかりません');
      if (item.state === 'complete') return {filename: item.filename.split(/[\\/]/).pop(), mime: item.mime, bytes: item.fileSize};
      if (item.state === 'interrupted') throw new Error(item.error || '保存中断');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('保存完了の確認がタイムアウトしました。Chromeのダウンロード一覧を確認してください');
  } finally {
    URL.revokeObjectURL(url);
  }
}
