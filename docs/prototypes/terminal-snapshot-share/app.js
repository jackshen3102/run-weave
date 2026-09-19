const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function notify(title, detail = '', link = '') {
  const toast = $('#toast');
  toast.innerHTML = `<button class="toast-close" aria-label="关闭通知">×</button><div class="toast-title"><span class="success-icon">${link ? '✓' : '·'}</span>${escapeHtml(title)}</div>${detail ? `<div class="toast-detail">${escapeHtml(detail)}</div>` : ''}${link ? `<a href="${escapeHtml(link)}">打开快照 →</a>` : ''}`;
  toast.hidden = false;
  toast.querySelector('button').onclick = () => { toast.hidden = true; };
}
async function copyText(text) {
  if (new URLSearchParams(location.search).get('clipboard') === 'fail') throw new Error('clipboard denied');
  await navigator.clipboard.writeText(text);
}

async function initializeWorkspace() {
  const response = await fetch('./mock-state.json');
  if (!response.ok) throw new Error('无法读取终端');
  const state = await response.json();
  let activePanel = state.panels[0];
  let creating = false;
  $('#panes').innerHTML = state.panels.map((panel, index) => `<section class="pane ${index === 0 ? 'active' : ''}" data-panel="${panel.id}" aria-label="${panel.label} 分屏"><header class="pane-heading"><button aria-label="选择 ${panel.label} 分屏"><i class="dot ${panel.id === 'shell' ? 'green' : ''}"></i>${panel.label}</button><span>${panel.status}</span></header><pre>${escapeHtml(panel.lines.join('\n'))}</pre></section>`).join('');
  document.querySelectorAll('.pane').forEach((pane) => {
    pane.addEventListener('click', () => {
      if (creating) return;
      activePanel = state.panels.find((panel) => panel.id === pane.dataset.panel);
      document.querySelectorAll('.pane').forEach((item) => item.classList.toggle('active', item === pane));
      $('#active-pane-label').textContent = activePanel.label;
    });
  });
  const menu = $('#actions-menu');
  function closeMenu() { menu.hidden = true; $('#more-actions').setAttribute('aria-expanded', 'false'); }
  $('#more-actions').onclick = () => {
    menu.hidden = !menu.hidden;
    $('#more-actions').setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.addEventListener('click', (event) => { if (!menu.contains(event.target) && !$('#more-actions').contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  $('#share-snapshot').onclick = async () => {
    if (creating) return;
    const capturedPanel = activePanel;
    creating = true;
    $('#share-snapshot').disabled = true;
    closeMenu();
    notify('正在创建快照…', `${state.terminalTitle} · ${capturedPanel.label}`);
    // Prototype-only creation delay and fixture URL; no product API is invoked.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (new URLSearchParams(location.search).get('state') === 'error') {
      notify('快照创建失败', '未生成分享链接，请稍后重试。');
    } else {
      const link = new URL(capturedPanel.file, location.href).href;
      try {
        await copyText(link);
        notify('快照链接已复制', `${capturedPanel.label} · 24 小时后失效`, link);
      } catch {
        notify('快照已创建，未能复制链接', '请打开快照后复制地址。', link);
      }
    }
    creating = false;
    $('#share-snapshot').disabled = false;
  };
}

initializeWorkspace().catch(() => notify('终端内容不可用'));
