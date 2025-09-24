chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed");
});

// Track opened tabs
let trackedTabs = [];

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openTab" && msg.url) {
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      trackedTabs.push(tab.id);

      // Wait for tab to finish loading
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);

          // Show processing immediately after load
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: showProcessingBid
          });

          // ✅ Wait for button dynamically instead of fixed 5 sec timeout
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: waitAndClickPlusBtn
          });
        }
      });
    });
  }

  if (msg.action === "clickAllBids") {
    console.log("👉 Received clickAllBids message");
    clickAllBidsParallel();
  }

  if (msg.action === "sendResponse" && sendResponse) {
    sendResponse({ success: true });
  }
});

// Parallel execution - much faster, no tab focusing needed
async function clickAllBidsParallel() {
  console.log(`👉 Clicking bids on ${trackedTabs.length} tabs simultaneously`);
  
  if (trackedTabs.length === 0) {
    console.log("❌ No tracked tabs found");
    return;
  }

  const promises = trackedTabs.map(tabId => {
    return chrome.scripting.executeScript({
      target: { tabId },
      func: clickBidButton
    }).then(result => {
      
      console.log(`✅ Successfully executed on tab ${tabId}`);
      return { tabId, success: true, result };
    }).catch(error => {
      console.error(`❌ Failed on tab ${tabId}:`, error);
      return { tabId, success: false, error: error.message };
    });
  });

  const results = await Promise.allSettled(promises);
  const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  
  console.log(`🎯 Successfully executed on ${successful}/${trackedTabs.length} tabs`);
}

// Function to click bid button (injected into each tab)
function clickBidButton() {
  const existingDiv = document.querySelector('.ccb-processing-bid');
  const btn = document.querySelector('[class^="BidBox_puntaOraButton"] button');

  if (btn && !btn.disabled) {
    // Remove processing indicator if present
    existingDiv?.remove();
    
    // Remove disabled class if present
    btn.className = btn.className.split(' ')
      .filter(c => !c.includes('BidBox_disabledButton'))
      .join(' ');
    
    // Create and dispatch proper click events
    const events = ['mousedown', 'mouseup', 'click'];
    events.forEach(eventType => {
      btn.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });
    
    // Direct click as backup
    btn.click();
    
    console.log("✅ Clicked Bid button in background tab");
    return { success: true, buttonText: btn.textContent?.trim() };
  } else {
    console.log("❌ Bid button not found or disabled");
    return { success: false, reason: btn ? 'disabled' : 'not-found' };
  }
}

function waitAndClickPlusBtn() {
  const checkInterval = 500; // check every 0.5s
  const maxWait = 50000; // give up after 50s
  const start = Date.now();

  const interval = setInterval(() => {
    const plusBtn = document.querySelector('[class^="BidBox_iconPlusSquare"]'); // update selector
    if (plusBtn) {
      console.log("✅ Found plus button, clicking...");
      plusBtn.click();
      clearInterval(interval);
    } else if (Date.now() - start > maxWait) {
      console.warn("⚠️ Plus button not found within 15s.");
      clearInterval(interval);
    }
  }, checkInterval);
}

// Optional: processing indicator
function showProcessingBid() {
  const tryInsert = () => {
    const iconEl = document.querySelector('[class^="MuiStack-root BidBox_priceInputLine"]');
    if (!iconEl) return setTimeout(tryInsert, 500);

    const processingDiv = document.createElement('div');
    processingDiv.className = 'ccb-processing-bid';
    processingDiv.innerHTML = `
      Processing Bid
      <span class="dot dot1"></span>
      <span class="dot dot2"></span>
      <span class="dot dot3"></span>
    `;
    processingDiv.style.cssText = `
      display: block; width: 100%; margin: 40px;
      font-weight: bold; color: orange; text-align: center; font-size: 40px;
    `;

    const style = document.createElement("style");
    style.textContent = `
      .dot { display: inline-block; width: 0.4em; height: 0.4em; margin-left: 4px;
        background-color: orange; border-radius: 50%; animation: blink 1.4s infinite both; }
      .dot2 { animation-delay: 0.2s; }
      .dot3 { animation-delay: 0.4s; }
      @keyframes blink { 0%,80%,100% { opacity:0; transform:scale(0.7); } 40% { opacity:1; transform:scale(1); } }
    `;
    document.head.appendChild(style);
    iconEl.insertAdjacentElement('afterend', processingDiv);
  };

  tryInsert();
}
