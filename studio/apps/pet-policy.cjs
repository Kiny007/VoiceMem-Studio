'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { serverUrl } = require('./runtime.cjs');
const CUBISM_CORE = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

function observerUrl(origin) {
  const url = new URL(serverUrl(origin));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws-pet';
  return url.href;
}

function resourceAllowed(value, root, observer) {
  try {
    if (observer && value === observer) return true;
    if (value === CUBISM_CORE) return true;
    const url = new URL(value);
    if (url.protocol !== 'file:') return false;
    const relative = path.relative(root, fileURLToPath(url));
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  } catch { return false; }
}

function trustedSender(event, window, page) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
}

module.exports = { CUBISM_CORE, observerUrl, resourceAllowed, trustedSender };
