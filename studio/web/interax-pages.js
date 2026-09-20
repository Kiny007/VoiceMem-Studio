/** Studio owns transport and UI; Interax's renderer owns sandboxing and readiness. */
export class InteraxPages {
  constructor({ send, isCurrent, notify, changed, autoPresent = true }) {
    Object.assign(this, { send, isCurrent, notify, changed, autoPresent });
    this.active = null;
    this.autoOpened = new Set();
    this.autoTargets = new WeakMap();
    this.opening = new Map();
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
    if (this.active) this.opening.delete(this.key(this.active.page));
    this.active?.controller.abort();
    this.active = null;
    for (const child of this.canvas.children) child._cleanup?.();
    this.canvas.replaceChildren();
    this.dialog.close();
  }

  update(session, pages, socket, tasks = [], errors = []) {
    session.ui.interaxPages = pages;
    session.ui.interaxTasks = tasks;
    session.ui.interaxErrors = errors;
    session.ui.interaxDisconnected = false;
    session.interaxSocket = socket;
    const currentKeys = new Set(pages.map((page) => this.key(page)));
    for (const key of this.autoOpened) if (!currentKeys.has(key)) this.autoOpened.delete(key);
    const active = this.active;
    if (active?.session === session && !pages.some((page) => this.key(page) === this.key(active.page))) {
      this.close();
      if (!pages.some((page) => this.displayable(page))) this.notify('交互页面已更新，请打开最新版本。');
    }
    this.changed(session);
    this.scheduleAutomaticDelivery(session, pages);
  }

  disconnect(socket) {
    this.close();
    for (const session of new Set([...(socket?.interaxOwners?.values() || []), ...(socket?.interaxTaskOwners?.values() || [])])) {
      session.ui.interaxDisconnected = true;
      this.changed(session);
    }
  }

  receive(space, state, socket) {
    const owner = socket.interaxOwners?.get(space);
    if (!owner) return;
    socket.interaxTaskOwners ||= new Map();
    const groups = new Map();
    const group = (item) => {
      const key = JSON.stringify([space, item.sessionId, item.requestId]);
      if (!socket.interaxTaskOwners.has(key)) socket.interaxTaskOwners.set(key, owner);
      const session = socket.interaxTaskOwners.get(key);
      if (!groups.has(session)) groups.set(session, { tasks: [], pages: [], ids: new Set() });
      const result = groups.get(session);
      result.ids.add(item.sessionId);
      return result;
    };
    for (const task of state.tasks || []) group(task).tasks.push(task);
    for (const page of state.pages || []) group(page).pages.push(page);
    for (const error of state.errors || []) {
      if ([...groups.values()].some(result => result.ids.has(error.sessionId))) continue;
      if (!groups.has(owner)) groups.set(owner, { tasks: [], pages: [], ids: new Set() });
      groups.get(owner).ids.add(error.sessionId);
    }
    if (!groups.size) groups.set(owner, { tasks: [], pages: [], ids: new Set() });
    for (const [session, result] of groups) {
      const errors = (state.errors || []).filter(error => result.ids.has(error.sessionId) || !result.ids.size);
      this.update(session, result.pages, socket, result.tasks, errors);
    }
  }

  key(page) { return JSON.stringify([page.sessionId, page.itemId, page.revision]); }

  displayable(page) { return Boolean(page && page.canDisplay !== false); }

  scheduleAutomaticDelivery(session, pages) {
    if (!this.autoPresent || session.ui.interaxDisconnected) return;
    const candidate = pages.find((page) => this.displayable(page));
    if (!candidate) return;
    const target = this.autoTargets.get(session);
    if (target && target !== candidate.itemId) return;
    if (!target) this.autoTargets.set(session, candidate.itemId);
    const key = this.key(candidate);
    if (this.autoOpened.has(key) || this.opening.has(key)) return;
    if (this.active?.session === session && this.key(this.active.page) === key) {
      this.autoOpened.add(key);
      return;
    }
    if (this.active?.session === session && this.active.page.itemId !== candidate.itemId) return;
    this.autoOpened.add(key);
    Promise.resolve().then(() => {
      if (!this.isCurrent(session) || session.ui.interaxDisconnected) return;
      const current = (session.ui.interaxPages || []).find((page) => this.key(page) === key);
      if (!current || !this.displayable(current)) return;
      if (this.active?.session === session && this.active.page.itemId !== current.itemId) return;
      this.open(session, current, { automatic: true });
    });
  }

  cards(session, container) {
    const pages = session.ui.interaxPages || [];
    const errors = session.ui.interaxErrors || [];
    for (const error of errors) {
      if ((session.ui.interaxTasks || []).some(task => task.sessionId === error.sessionId)) continue;
      const status = document.createElement('p');
      status.textContent = '交互任务状态查询失败，正在重连。';
      container.append(status);
    }
    const stages = {
      accepted: '任务已接收，正在制作…', evaluating: '正在分析需求…', running: '正在生成…',
      waiting: '等待你的回答', paused: '任务已暂停', completed: '任务已完成',
      failed: '生成失败', rejected: '任务未被接受', cancelled: '任务已取消',
      interrupted: '任务已中断', superseded: '任务已被后续请求替代', unknown: '正在确认任务状态…',
    };
    const appendPage = (page, container) => {
      const card = document.createElement('div');
      card.className = 'turn ai interax-card';
      const title = document.createElement('strong');
      title.textContent = page.title || 'Interax 交互页面';
      const summary = document.createElement('p');
      summary.textContent = page.summary || '';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '打开交互页面';
      button.disabled = Boolean(session.ui.interaxDisconnected);
      button.onclick = () => this.open(session, page);
      card.append(title, summary, button);
      container.append(card);
    };
    const attached = new Set();
    for (const task of session.ui.interaxTasks || []) {
      const card = document.createElement('div');
      card.className = 'turn ai interax-card';
      const title = document.createElement('strong');
      title.textContent = task.title || 'Interax 任务';
      const status = document.createElement('p');
      const results = pages.filter((page) => page.sessionId === task.sessionId && page.requestId === task.requestId);
      status.textContent = stages[task.stage] || stages.unknown;
      if (task.stage === 'completed' && !results.length) status.textContent += '，暂无可打开的交互页面。';
      if (task.failedResults) status.textContent += ' 部分成果生成失败。';
      if (errors.some((error) => error.sessionId === task.sessionId)) status.textContent += ' 状态查询失败，正在重连；以上为上次获取的状态。';
      if (session.ui.interaxDisconnected) status.textContent += ' 连接已断开；服务端继续跟踪任务，重新连接可恢复。';
      card.append(title, status);
      const controls = document.createElement('span');
      for (const [action, label] of [[task.waitingStopped ? 'resume_waiting' : 'stop_waiting', task.waitingStopped ? '恢复通知' : '停止等待'], ['cancel', '取消任务']]) {
        const control = document.createElement('button');
        control.type = 'button'; control.textContent = label;
        control.disabled = Boolean(session.ui.interaxDisconnected);
        control.onclick = () => this.send(session, {type:'interax_page_action', space:session.space, sessionId:task.sessionId, token:crypto.randomUUID(), action});
        controls.append(control);
      }
      if (errors.some(error => error.sessionId === task.sessionId && error.code === 'model_retry_exhausted')) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试结果通知';
        retry.onclick = () => this.send(session, {type:'interax_page_action',space:session.space,sessionId:task.sessionId,token:crypto.randomUUID(),action:'retry_delivery'});
        controls.append(retry);
      }
      card.append(controls);
      for (const question of task.questions || []) {
        const prompt = document.createElement('p');
        prompt.textContent = `${question.required ? '需要回答：' : '问题：'}${question.text}`;
        card.append(prompt);
      }
      for (const page of results) {
        attached.add(this.key(page));
        appendPage(page, card);
      }
      container.append(card);
    }
    for (const page of pages) if (!attached.has(this.key(page))) appendPage(page, container);
  }

  action(active, action, extra = {}) {
    if (this.active !== active || !this.isCurrent(active.session)) return false;
    return this.send(active.session, { type: 'interax_page_action', space: active.session.space,
      token: active.token, action, ...extra });
  }

  open(session, page, { automatic = false } = {}) {
    const key = this.key(page);
    if (this.opening.has(key)) return this.opening.get(key);
    if (this.active?.session === session && this.key(this.active.page) === key
        && (this.opening.has(key) || this.active.confirmed)) return this.active;
    this.close();
    const active = { session, page, token: crypto.randomUUID(), controller: new AbortController(), confirmed: false, automatic };
    this.active = active;
    this.opening.set(key, active);
    this.title.textContent = page.title || 'Interax 交互页面';
    this.status.textContent = automatic ? '正在准备交互页面…' : '正在加载页面…';
    this.dialog.showModal();
    if (!this.action(active, 'openPage', { page })) this.status.textContent = '连接已结束，请重新连接当前对话后打开已有成果。';
  }

  async result(message) {
    const active = this.active;
    if (!active || message.token !== active.token || message.space !== active.session.space || !this.isCurrent(active.session)) return;
    if (!message.ok) {
      active.confirmed = false;
      this.opening.delete(this.key(active.page));
      this.status.textContent = '页面操作失败，请关闭后重新打开。' +
        (typeof message.error === 'string' ? message.error : (message.error?.code || ''));
      return;
    }
    if (message.action === 'confirmPage') {
      active.confirmed = true;
      this.opening.delete(this.key(active.page));
      this.status.textContent = '页面已显示，可以操作。';
    } else if (message.action === 'interact') {
      active.confirmed = true;
      this.status.textContent = '操作已提交；生成的修订页面会出现在聊天中。';
    } else if (message.action === 'openPage') {
      try {
        const { createIframeRenderer } = await import(new URL('../interax-sdk/browser.js', location.href).href);
        active.controller.signal.throwIfAborted();
        const render = createIframeRenderer(this.canvas, { onInteraction: (data) => {
          if (!active.confirmed) return;
          if (this.action(active, 'interact', { data, actionId: crypto.randomUUID() })) {
            active.confirmed = false;
            this.status.textContent = '正在提交页面操作…';
          }
        } });
        await render(message.result.documents, { signal: active.controller.signal });
        if (this.action(active, 'confirmPage')) this.status.textContent = '正在确认页面显示…';
      } catch (error) {
        if (active.controller.signal.aborted) return;
        this.opening.delete(this.key(active.page));
        this.status.textContent = '页面加载失败，请关闭后重新打开。';
        this.action(active, 'failPage', { message: 'Studio renderer failed' });
      }
    }
  }
}
