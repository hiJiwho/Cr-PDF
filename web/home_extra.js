/* Start-screen extras: quick-start tiles + "continue writing" button. Pure UI glue; uses existing app.js controls. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function openNewNotebook({ template, pageSize, widthMm, heightMm }) {
    const btn = $('new-notebook-btn');
    if (!btn) return;
    btn.click();
    const radio = document.querySelector(`input[name="template"][value="${template}"]`);
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
    const sel = $('nb-page-size');
    if (sel) { sel.value = pageSize; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    if (pageSize === 'custom') {
      if ($('nb-width-mm')) $('nb-width-mm').value = widthMm;
      if ($('nb-height-mm')) $('nb-height-mm').value = heightMm;
    }
    const title = $('nb-title');
    if (title) setTimeout(() => title.focus(), 30);
  }

  function bindTiles() {
    document.querySelectorAll('.quick-tile').forEach((tile) => {
      tile.addEventListener('click', () => openNewNotebook({
        template: tile.dataset.template,
        pageSize: tile.dataset.size,
        widthMm: tile.dataset.w,
        heightMm: tile.dataset.h,
      }));
    });
  }

  function bindContinue() {
    const btn = $('hero-continue-btn');
    const grid = $('notebook-grid');
    if (!btn || !grid) return;
    const refresh = () => {
      const first = grid.querySelector('.notebook-card');
      btn.hidden = !first;
      const t = first && first.querySelector('.notebook-title');
      btn.textContent = t ? `이어서 쓰기 · ${t.textContent}` : '이어서 쓰기';
    };
    new MutationObserver(refresh).observe(grid, { childList: true, subtree: true });
    btn.addEventListener('click', () => {
      const first = grid.querySelector('.notebook-card');
      if (first) first.click();
    });
    refresh();
  }

  document.addEventListener('DOMContentLoaded', () => { bindTiles(); bindContinue(); });
})();
