// background.js
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openTab" && msg.url) {
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showProcessingBid
      });
    });
  }
});

function showProcessingBid() {
  const tryInsert = () => {
    const iconEl = document.querySelector('[class^="MuiStack-root BidBox_priceInputLine"]');
    if (!iconEl) {
      setTimeout(tryInsert, 500); // retry until element appears
      return;
    }

    // Create the div with a unique class for later removal
    const processingDiv = document.createElement('div');
    processingDiv.className = 'ccb-processing-bid'; // ✅ unique classname
    processingDiv.innerHTML = `
      Processing Bid
      <span class="dot dot1"></span>
      <span class="dot dot2"></span>
      <span class="dot dot3"></span>
    `;
    processingDiv.style.cssText = `
      display: block;
      width: 100%;
      margin: 40px;
      font-weight: bold;
      color: orange;
      text-align: center;
      font-size: 40px;
    `;

    const style = document.createElement("style");
    style.textContent = `
      .dot {
        display: inline-block;
        width: 0.4em;
        height: 0.4em;
        margin-left: 4px;
        background-color: orange;
        border-radius: 50%;
        animation: blink 1.4s infinite both;
      }
      .dot2 { animation-delay: 0.2s; }
      .dot3 { animation-delay: 0.4s; }
      @keyframes blink {
        0%, 80%, 100% { opacity: 0; transform: scale(0.7); }
        40% { opacity: 1; transform: scale(1); }
      }
    `;
    document.head.appendChild(style);

    iconEl.insertAdjacentElement('afterend', processingDiv);
  };

  tryInsert();
}


