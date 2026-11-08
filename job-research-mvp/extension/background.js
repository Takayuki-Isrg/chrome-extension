import { captureJob, reviseJob } from './workflow.js';

async function registerMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'inspect-job',
    title: 'この求人を調べる',
    contexts: ['page', 'selection', 'link', 'image'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerMenu().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  registerMenu().catch(console.error);
});
// 右クリックメニューから求人情報を取得する
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'inspect-job') captureJob(chrome, tab, info.pageUrl).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL('review.html')) ||
    message?.type !== 'revise'
  )
    return false;

  reviseJob(chrome, message.id, message.overrides)
    .then((record) => respond({ ok: true, record }))
    .catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

// Results belong to their review tab and never become a permanent browsing history.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const all = await chrome.storage.session.get(null);
    const keys = Object.entries(all)
      .filter(([key, value]) => key.startsWith('job:') && value.reviewTabId === tabId)
      .map(([key]) => key);
    if (keys.length) await chrome.storage.session.remove(keys);
  } catch (error) {
    console.error(error);
  }
});
