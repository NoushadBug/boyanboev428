// background.js
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openTab" && msg.url) {
    chrome.tabs.create({ url: msg.url, active: false }); // opens in background
  }
});

