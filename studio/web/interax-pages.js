/** Studio owns transport and UI; Interax's renderer owns sandboxing and readiness. */
export class InteraxPages {
  constructor({ send, isCurrent, notify, changed }) {
    Object.assign(this, { send, isCurrent, notify, changed });
    this.active = null;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'interax-dialog';
    this.dialog.innerHTML = '<header><strong></strong><button type="button">关闭</button></header>' +
      '<p role="status"></p><div class="interax-canvas"></div>';
    document.body.append(this.dialog);
    this.title = this.dialog.querySelector('strong');
    this.status = this.dialog.querySelector('p');
    this.canvas = this.dialog.querySelector('.interax-canvas');
    this.dialog.querySelector('button').onclick = () => this.close();
    this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
  }

  close() {
    this.active?.controller.abort();
    this.active = null;
    for (const child of this.canvas.children) child._cleanup?.();
    this.canvas.replaceChildren();
    this.dialog.close();
  }

  update(session, pages, socket) {
    session.ui.interaxPages = pages;
    session.interaxSocket = socket;
    const active = this.active;
    if (active?.session === session && !pages.some((page) => this.key(page) === this.key(active.page))) {
      this.close();
      this.notify('交互页面已更新，请打开最新版本。');
    }
    this.changed(session);
  }

  key(page) { return JSON.stringify([page.sessionId, page.itemId, page.revision]); }

  cards(session, container) {
    for (const page of session.ui.interaxPages || []) {
      const card = document.createElement('div');
      card.className = 'turn ai interax-card';
      const title = document.createElement('strong');
      title.textContent = page.title || 'Interax 交互页面';
      const summary = document.createElement('p');
      summary.textContent = page.summary || '';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '打开交互页面';
      button.onclick = () => this.open(session, page);
      card.append(title, summary, button);
      container.append(card);
    }
  }

  action(active, action, extra = {}) {
    if (this.active !== active || !this.isCurrent(active.session)) return false;
    return this.send(active.session, { type: 'interax_page_action', space: active.session.space,
      token: active.token, action, ...extra });
  }

  open(session, page) {
    this.close();
    const active = { session, page, token: crypto.randomUUID(), controller: new AbortController(), confirmed: false };
    this.active = active;
    this.title.textContent = page.title || 'Interax 交互页面';
    this.status.textContent = '正在加载页面…';
    this.dialog.showModal();
    if (!this.action(active, 'openPage', { page })) this.status.textContent = '连接已结束，请在当前对话中重新生成页面。';
  }

  async result(message) {
    const active = this.active;
    if (!active || message.token !== active.token || message.space !== active.session.space || !this.isCurrent(active.session)) return;
    if (!message.ok) {
      active.confirmed = false;
      this.status.textContent = '页面操作失败，请关闭后重新打开。' +
        (typeof message.error === 'string' ? message.error : (message.error?.code || ''));
      return;
    }
    if (message.action === 'confirmPage') {
      active.confirmed = true;
      this.status.textContent = '页面已显示，可以操作。';
    } else if (message.action === 'interact') {
      active.confirmed = true;
      this.status.textContent = '操作已提交；生成的修订页面会出现在聊天中。';
    } else if (message.action === 'openPage') {
      try {
        const { createIframeRenderer } = await import('/interax-sdk/browser.js');
        active.controller.signal.throwIfAborted();
        const render = createIframeRenderer(this.canvas, { onInteraction: (data) => {
          if (!active.confirmed) return;
          if (this.action(active, 'interact', { data })) {
            active.confirmed = false;
            this.status.textContent = '正在提交页面操作…';
          }
        } });
        await render(message.result.documents, { signal: active.controller.signal });
        if (this.action(active, 'confirmPage')) this.status.textContent = '正在确认页面显示…';
      } catch (error) {
        if (active.controller.signal.aborted) return;
        this.status.textContent = '页面加载失败，请关闭后重新打开。';
        this.action(active, 'failPage', { message: 'Studio renderer failed' });
      }
    }
  }
}
