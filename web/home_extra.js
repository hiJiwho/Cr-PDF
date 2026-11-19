/* Start-screen studio enhancements: clean sidebar metadata, PPT/PPTX import (+ drag & drop), card export & add-page. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function showBannerNotice(msg) {
    const toast = $('toast-container');
    if (toast) {
      const el = document.createElement('div');
      el.className = 'toast toast-info';
      el.textContent = msg;
      toast.appendChild(el);
      setTimeout(() => el.remove(), 3500);
      return;
    }
    alert(msg);
  }

  function enhanceStudioLayout() {
    const sub = document.querySelector('.brand-subtitle');
    if (sub) sub.textContent = 'STUDIO';
    const newBtn = document.querySelector('#new-notebook-btn span');
    if (newBtn) newBtn.textContent = '새 노트 만들기';
    const pdfBtn = document.querySelector('#import-pdf-btn span');
    if (pdfBtn) pdfBtn.textContent = 'PDF 가져오기';

    const heroTitle = document.querySelector('.hero h2');
    if (heroTitle) heroTitle.textContent = '내 라이브러리';
    const heroDesc = document.querySelector('.hero p');
    if (heroDesc) heroDesc.textContent = '모든 노트는 앱 내부(AppData)에 안전하게 자동 저장되며, 언제든 PDF로 내보낼 수 있습니다.';

    // Hide save-folder settings inside settings modal (locked to AppData)
    const folderInput = document.querySelector('#settings-save-dir, [data-testid="settings-save-dir"]');
    if (folderInput) {
      const group = folderInput.closest('.form-group, .settings-section');
      if (group) group.style.display = 'none';
    }

    // Group quick-tile text neatly for horizontal studio card layout
    document.querySelectorAll('.quick-tile').forEach((tile) => {
      const b = tile.querySelector('b');
      const s = tile.querySelector('span');
      if (b && s && !tile.querySelector('.qt-text')) {
        const wrap = document.createElement('div');
        wrap.className = 'qt-text';
        wrap.append(b, s);
        tile.appendChild(wrap);
      }
    });

    // Add subtle AppData storage info card above Settings in sidebar
    const actions = document.querySelector('.topbar-actions');
    const settingsBtn = $('settings-btn');
    if (actions && settingsBtn && !document.querySelector('.crpdf-sidebar-meta')) {
      const meta = document.createElement('div');
      meta.className = 'crpdf-sidebar-meta';
      meta.innerHTML = '<strong>자동 보관함 (AppData)</strong>작성한 필기는 자동으로 보관됩니다. 외부 공유가 필요할 때 카드의 <b>내보내기</b>를 누르세요.';
      actions.insertBefore(meta, settingsBtn);
    }

    // Add clean section header above notebook grid
    const grid = $('notebook-grid');
    if (grid && !document.querySelector('.crpdf-section-header')) {
      const hdr = document.createElement('div');
      hdr.className = 'crpdf-section-header';
      hdr.innerHTML = '<h3 class="crpdf-section-title">보관된 노트</h3>';
      grid.parentNode.insertBefore(hdr, grid);
    }
  }

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

  async function importPptFile(file) {
    showBannerNotice(`"${file.name}" PPTX를 PDF로 변환하는 중...`);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`/api/notebooks/import-ppt?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'PPTX 변환에 실패했습니다. PowerPoint 또는 LibreOffice 설치 여부를 확인해 주세요.');
        return;
      }
      if (data && data.url) {
        window.location.assign(data.url);
      }
    } catch (err) {
      alert(`PPTX 가져오기 오류: ${err.message}`);
    }
  }

  function bindPptImport() {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || $('import-ppt-btn')) return;

    const pptBtn = document.createElement('button');
    pptBtn.type = 'button';
    pptBtn.id = 'import-ppt-btn';
    pptBtn.className = 'btn btn-secondary';
    pptBtn.textContent = 'PPTX 가져오기';
    pptBtn.title = 'PowerPoint(.ppt, .pptx)를 PDF 노트로 변환해 열기';

    const pptInput = document.createElement('input');
    pptInput.type = 'file';
    pptInput.id = 'import-ppt-input';
    pptInput.accept = '.ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation';
    pptInput.hidden = true;

    pptBtn.addEventListener('click', () => pptInput.click());
    pptInput.addEventListener('change', async () => {
      const file = pptInput.files && pptInput.files[0];
      pptInput.value = '';
      if (file) await importPptFile(file);
    });

    const meta = document.querySelector('.crpdf-sidebar-meta');
    const settingsBtn = $('settings-btn');
    actions.insertBefore(pptBtn, meta || settingsBtn || null);
    actions.appendChild(pptInput);

    window.addEventListener('drop', async (ev) => {
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (const f of files) {
        if (/\.(pptx?|PPTX?)$/.test(f.name)) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          await importPptFile(f);
          return;
        }
      }
    }, true);
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
        exportBtn.textContent = '내보내기';
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
    enhanceStudioLayout();
    bindTiles();
    bindContinue();
    bindPptImport();
    bindCardExtras();
  });
})();
