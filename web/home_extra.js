/* Start-screen studio enhancements (v8):
 * - Clean name-only notebook cards with custom color spine
 * - Hover settings icon on each card to Rename, Set Color, Assign Folder, or Export as "<title>.pdf"
 * - Folder filter tabs managed via notes.json (/api/notebooks, /api/folders, /api/notebooks/<id>/meta)
 * - PPT/PPTX import (+ drag & drop) & Light/Dark Mint theme toggle
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const NOTE_COLORS = [
    '#14B8A6', // Mint
    '#0EA5E9', // Sky
    '#3B82F6', // Blue
    '#8B5CF6', // Violet
    '#EC4899', // Pink
    '#F43F5E', // Rose
    '#F59E0B', // Amber
    '#10B981', // Emerald
  ];

  let activeFolder = ''; // '' means All
  let foldersList = [];
  let editModalEl = null;

  function showBannerNotice(msg) {
    const toast = $('toast-container');
    if (toast) {
      const el = document.createElement('div');
      el.className = 'toast toast-info';
      el.textContent = msg;
      toast.appendChild(el);
      setTimeout(() => el.remove(), 3200);
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
    if (heroDesc) heroDesc.textContent = '모든 노트는 고유 ID(notes.json)로 안전하게 자동 보관되며, 이름·색상·폴더를 자유롭게 관리할 수 있습니다.';

    const folderInput = document.querySelector('#settings-save-dir, [data-testid="settings-save-dir"]');
    if (folderInput) {
      const group = folderInput.closest('.form-group, .settings-section');
      if (group) group.style.display = 'none';
    }

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

    const grid = $('notebook-grid');
    if (grid && !document.querySelector('.crpdf-section-header')) {
      const hdr = document.createElement('div');
      hdr.className = 'crpdf-section-header';
      hdr.innerHTML = `
        <div class="crpdf-folder-bar" id="crpdf-folder-bar"></div>
      `;
      grid.parentNode.insertBefore(hdr, grid);
    }
  }

  async function refreshFoldersBar() {
    const bar = $('crpdf-folder-bar');
    if (!bar) return;
    try {
      const res = await fetch('/api/notebooks', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const set = new Set(Array.isArray(data.folders) ? data.folders : []);
        if (Array.isArray(data.notebooks)) {
          data.notebooks.forEach((n) => {
            if (n.folder) set.add(n.folder);
          });
        }
        foldersList = Array.from(set);
      }
    } catch {
      // ignore
    }

    bar.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = `crpdf-folder-chip${activeFolder === '' ? ' active' : ''}`;
    allChip.textContent = '전체 노트';
    allChip.addEventListener('click', () => {
      activeFolder = '';
      applyFolderFilter();
      refreshFoldersBar();
    });
    bar.appendChild(allChip);

    foldersList.forEach((f) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `crpdf-folder-chip${activeFolder === f ? ' active' : ''}`;
      chip.textContent = f;
      chip.addEventListener('click', () => {
        activeFolder = f;
        applyFolderFilter();
        refreshFoldersBar();
      });
      bar.appendChild(chip);
    });

    const addFolderBtn = document.createElement('button');
    addFolderBtn.type = 'button';
    addFolderBtn.className = 'crpdf-folder-chip crpdf-folder-add';
    addFolderBtn.textContent = '+ 새 폴더';
    addFolderBtn.addEventListener('click', async () => {
      const name = prompt('새 폴더 이름을 입력하세요:');
      if (!name || !name.trim()) return;
      await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      activeFolder = name.trim();
      await refreshFoldersBar();
      applyFolderFilter();
    });
    bar.appendChild(addFolderBtn);
  }

  function applyFolderFilter() {
    const grid = $('notebook-grid');
    if (!grid) return;
    grid.querySelectorAll('.notebook-card').forEach((card) => {
      const f = card.getAttribute('data-notebook-folder') || '';
      card.hidden = Boolean(activeFolder && f !== activeFolder);
    });
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

  function openNoteEditModal(card) {
    const id = card.getAttribute('data-notebook-id');
    const curTitle = (card.querySelector('.notebook-title')?.textContent || '').trim();
    const curColor = card.getAttribute('data-notebook-color') || '#14B8A6';
    const curFolder = card.getAttribute('data-notebook-folder') || '';
    const pdfUrl = card.getAttribute('data-notebook-url') || `/pdf/${encodeURIComponent(id + '.pdf')}`;

    if (!editModalEl) {
      editModalEl = document.createElement('div');
      editModalEl.className = 'modal-backdrop';
      editModalEl.id = 'crpdf-note-edit-modal';
      document.body.appendChild(editModalEl);
    }

    const swatchesHtml = NOTE_COLORS.map((c) => `
      <button type="button" class="crpdf-color-swatch${c.toLowerCase() === curColor.toLowerCase() ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>
    `).join('');

    const folderOptions = ['<option value="">(폴더 없음)</option>']
      .concat(foldersList.map((f) => `<option value="${f.replace(/"/g, '&quot;')}"${f === curFolder ? ' selected' : ''}>${f}</option>`))
      .join('');

    editModalEl.innerHTML = `
      <div class="modal-card crpdf-edit-card" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h2>노트 설정 및 내보내기</h2>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="crpdf-edit-title">노트 이름</label>
            <input type="text" id="crpdf-edit-title" value="${curTitle.replace(/"/g, '&quot;')}" autocomplete="off">
          </div>
          <div class="form-group">
            <label>노트 색상</label>
            <div class="crpdf-swatch-row">${swatchesHtml}</div>
          </div>
          <div class="form-group">
            <label for="crpdf-edit-folder">폴더</label>
            <select id="crpdf-edit-folder" class="sort-select">${folderOptions}</select>
          </div>
        </div>
        <div class="modal-footer crpdf-edit-footer">
          <button type="button" class="btn btn-secondary" id="crpdf-edit-export">PDF 내보내기</button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn btn-ghost" id="crpdf-edit-cancel">취소</button>
            <button type="button" class="btn btn-primary" id="crpdf-edit-save">저장</button>
          </div>
        </div>
      </div>
    `;
    editModalEl.hidden = false;

    let selectedColor = curColor;
    editModalEl.querySelectorAll('.crpdf-color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        editModalEl.querySelectorAll('.crpdf-color-swatch').forEach((el) => el.classList.remove('active'));
        sw.classList.add('active');
        selectedColor = sw.getAttribute('data-color') || '#14B8A6';
      });
    });

    editModalEl.querySelector('#crpdf-edit-cancel').addEventListener('click', () => {
      editModalEl.hidden = true;
    });

    editModalEl.querySelector('#crpdf-edit-export').addEventListener('click', async () => {
      const exportTitle = (editModalEl.querySelector('#crpdf-edit-title').value || curTitle || 'note').trim();
      const exportFilename = /\.pdf$/i.test(exportTitle) ? exportTitle : `${exportTitle}.pdf`;
      const res = await fetch(pdfUrl, { cache: 'no-store' });
      if (res.ok) {
        const blob = await res.blob();
        downloadBlob(blob, exportFilename);
        showBannerNotice(`"${exportFilename}" 이름으로 내보냈습니다.`);
      }
    });

    editModalEl.querySelector('#crpdf-edit-save').addEventListener('click', async () => {
      const newTitle = (editModalEl.querySelector('#crpdf-edit-title').value || curTitle).trim();
      const newFolder = editModalEl.querySelector('#crpdf-edit-folder').value || '';
      const res = await fetch(`/api/notebooks/${encodeURIComponent(id)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, color: selectedColor, folder: newFolder }),
      });
      if (res.ok) {
        const updated = await res.json();
        const titleEl = card.querySelector('.notebook-title');
        if (titleEl) {
          titleEl.textContent = updated.title;
          titleEl.title = updated.title;
        }
        card.setAttribute('data-notebook-name', `${updated.title}.pdf`);
        card.setAttribute('data-notebook-color', updated.color);
        card.setAttribute('data-notebook-folder', updated.folder);
        const spine = card.querySelector('.notebook-spine');
        if (spine) spine.style.setProperty('--spine-color', updated.color);
        editModalEl.hidden = true;
        applyFolderFilter();
        refreshFoldersBar();
      }
    });
  }

  function decorateNotebookCards() {
    const grid = $('notebook-grid');
    if (!grid) return;

    const run = () => {
      grid.querySelectorAll('.notebook-card').forEach((card) => {
        if (!card.querySelector('.card-edit-btn')) {
          const thumb = card.querySelector('.notebook-thumb');
          if (thumb) {
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'card-edit-btn';
            editBtn.title = '이름·색상·폴더 변경 및 내보내기';
            editBtn.setAttribute('aria-label', '노트 설정');
            editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
            editBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openNoteEditModal(card);
            });
            thumb.appendChild(editBtn);
          }
        }
      });
      applyFolderFilter();
    };

    new MutationObserver(() => {
      run();
      refreshFoldersBar();
    }).observe(grid, { childList: true });
    run();
    refreshFoldersBar();
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

    const settingsBtn = $('settings-btn');
    actions.insertBefore(pptBtn, settingsBtn || null);
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

  function initThemeToggle() {
    const btn = document.getElementById('theme-toggle-btn');
    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    const apply = (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem('crpdf-theme', theme); } catch {}
      if (sun) sun.hidden = theme !== 'dark';
      if (moon) moon.hidden = theme === 'dark';
    };
    let saved = null;
    try { saved = localStorage.getItem('crpdf-theme'); } catch {}
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    apply(saved);
    if (btn) {
      btn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        apply(cur === 'dark' ? 'light' : 'dark');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    enhanceStudioLayout();
    bindTiles();
    bindContinue();
    bindPptImport();
    decorateNotebookCards();
  });
})();
