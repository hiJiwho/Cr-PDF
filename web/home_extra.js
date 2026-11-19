/* Start-screen extras: quick-start tiles, continue writing, PPT import, card add-page & export (PDF/PNG). */
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

  async function bindPptImport() {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || $('import-ppt-btn')) return;

    const pptBtn = document.createElement('button');
    pptBtn.type = 'button';
    pptBtn.id = 'import-ppt-btn';
    pptBtn.className = 'btn btn-secondary';
    pptBtn.textContent = 'PPT 가져오기';

    const pptInput = document.createElement('input');
    pptInput.type = 'file';
    pptInput.id = 'import-ppt-input';
    pptInput.accept = '.ppt,.pptx';
    pptInput.hidden = true;

    let officeAvailable = false;
    try {
      const h = await fetch('/api/health', { cache: 'no-store' });
      if (h.ok) {
        const data = await h.json();
        officeAvailable = Boolean(data.officeAvailable);
      }
    } catch {
      officeAvailable = false;
    }

    if (!officeAvailable) {
      pptBtn.disabled = true;
      pptBtn.title = 'Microsoft PowerPoint가 설치된 Windows PC에서만 사용할 수 있습니다.';
    }

    pptBtn.addEventListener('click', () => {
      if (!pptBtn.disabled) pptInput.click();
    });

    pptInput.addEventListener('change', async () => {
      const file = pptInput.files && pptInput.files[0];
      pptInput.value = '';
      if (!file) return;
      const buf = await file.arrayBuffer();
      const res = await fetch(`/api/notebooks/import-ppt?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      if (!res.ok) {
        alert('PPT 변환에 실패했습니다. PowerPoint 설치 여부를 확인해 주세요.');
        return;
      }
      const created = await res.json();
      if (created && created.url) {
        window.location.assign(created.url);
      }
    });

    const settingsBtn = $('settings-btn');
    actions.insertBefore(pptBtn, settingsBtn || null);
    actions.appendChild(pptInput);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindCardExtras() {
    const grid = $('notebook-grid');
    if (!grid) return;

    const decorateCards = () => {
      grid.querySelectorAll('.notebook-card').forEach((card) => {
        if (card.querySelector('.crpdf-card-actions')) return;
        const name = card.getAttribute('data-notebook-name');
        const footer = card.querySelector('.notebook-footer');
        if (!name || !footer) return;

        const bar = document.createElement('div');
        bar.className = 'crpdf-card-actions';

        const addPageBtn = document.createElement('button');
        addPageBtn.type = 'button';
        addPageBtn.className = 'crpdf-card-mini-btn';
        addPageBtn.textContent = '+ 페이지';
        addPageBtn.title = '맨 뒤에 페이지 추가';
        addPageBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}/add-page`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (res.ok) {
            const info = await res.json();
            window.location.assign(`/pdf/${encodeURIComponent(name)}#page=${info.pages || 1}`);
          }
        });

        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'crpdf-card-mini-btn';
        exportBtn.textContent = 'PDF 저장';
        exportBtn.title = 'PDF 파일로 내보내기';
        exportBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const res = await fetch(`/pdf/${encodeURIComponent(name)}`, { cache: 'no-store' });
          if (res.ok) {
            const blob = await res.blob();
            downloadBlob(blob, name);
          }
        });

        bar.append(addPageBtn, exportBtn);
        footer.appendChild(bar);
      });
    };

    new MutationObserver(decorateCards).observe(grid, { childList: true, subtree: true });
    decorateCards();
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindTiles();
    bindContinue();
    bindPptImport();
    bindCardExtras();
  });
})();
