(function () {
  'use strict';

  const SPINE_PALETTE = [
    '#C95B3C', // terracotta
    '#4A7C6F', // sage
    '#3B6E8C', // slate
    '#B8843B', // ochre
    '#7C5578', // plum
    '#3D4F73', // navy
  ];

  const PRESET_DIMENSIONS = {
    a4: { widthMm: 210, heightMm: 297 },
    letter: { widthMm: 215.9, heightMm: 279.4 },
    '16x9': { widthMm: 297, heightMm: 167 },
  };

  const state = {
    config: {
      saveDir: '',
      autosaveIntervalSec: 30,
      autosaveEnabled: true,
      palmRejection: true,
      pseudoPressure: true,
    },
    notebooks: [],
    searchQuery: '',
    sortBy: 'recent',
    pendingDeleteName: null,
    activeOverlayId: null,
    lastFocusedEl: null,
    dragDepth: 0,
    isSubmittingCreate: false,
  };

  let bridge = null;
  let els = {};
  let saveStatusTimer = null;

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatMtime(mtimeSec) {
    if (!Number.isFinite(mtimeSec) || mtimeSec <= 0) return '';
    const ms = mtimeSec > 1e12 ? mtimeSec : mtimeSec * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function stripPdfExtension(name) {
    return name.replace(/\.pdf$/i, '');
  }

  function showToast(message, type = 'info', durationMs = 3500) {
    if (!els.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = String(message);
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, durationMs);
  }

  function createTrashIconSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute(
      'd',
      'M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H7a1 1 0 01-1-1V6h12z'
    );
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.9');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  /* ------------------------------------------------------------------------
   * Overlay / Modal / Drawer Management
   * ------------------------------------------------------------------------ */

  function openOverlay(overlayId, focusEl) {
    if (state.activeOverlayId && state.activeOverlayId !== overlayId) {
      closeOverlay(state.activeOverlayId, false);
    }
    state.lastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = document.getElementById(overlayId);
    if (!el) return;
    el.hidden = false;
    state.activeOverlayId = overlayId;
    if (focusEl && typeof focusEl.focus === 'function') {
      focusEl.focus();
    }
  }

  function closeOverlay(overlayId, restoreFocus = true) {
    const targetId = overlayId || state.activeOverlayId;
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (el) {
      el.hidden = true;
    }
    if (state.activeOverlayId === targetId) {
      state.activeOverlayId = null;
    }
    if (targetId === 'delete-modal') {
      state.pendingDeleteName = null;
    }
    if (restoreFocus && state.lastFocusedEl && typeof state.lastFocusedEl.focus === 'function') {
      state.lastFocusedEl.focus();
      state.lastFocusedEl = null;
    }
  }

  /* ------------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------------ */

  function renderConfig() {
    const cfg = state.config;
    const dirText = cfg.saveDir || '(미지정 / Not set)';
    els.saveDirPath.textContent = dirText;
    els.saveDirPath.title = dirText;

    const isAutoOn = Boolean(cfg.autosaveEnabled) && Number(cfg.autosaveIntervalSec) > 0;
    if (isAutoOn) {
      els.autosaveStatusPill.textContent = `자동 저장 ${cfg.autosaveIntervalSec}초`;
      els.autosaveStatusPill.classList.remove('is-off');
    } else {
      els.autosaveStatusPill.textContent = '자동 저장 꺼짐';
      els.autosaveStatusPill.classList.add('is-off');
    }

    els.settingAutosaveEnabled.checked = isAutoOn;
    const intervalVal = isAutoOn ? String(cfg.autosaveIntervalSec) : '0';
    const validOptions = new Set(['15', '30', '60', '0']);
    els.settingAutosaveInterval.value = validOptions.has(intervalVal) ? intervalVal : '30';
    els.settingPalmRejection.checked = Boolean(cfg.palmRejection);
    els.settingPseudoPressure.checked = Boolean(cfg.pseudoPressure);
  }

  function getFilteredAndSortedNotebooks() {
    const query = state.searchQuery.trim().toLowerCase();
    const list = state.notebooks.filter((nb) => {
      if (!query) return true;
      return nb.name.toLowerCase().includes(query);
    });

    list.sort((a, b) => {
      if (state.sortBy === 'name') {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (state.sortBy === 'size') {
        return (b.size || 0) - (a.size || 0);
      }
      // default: recent
      return (b.mtime || 0) - (a.mtime || 0);
    });

    return list;
  }

  function createNotebookCardElement(notebook) {
    const card = document.createElement('article');
    card.className = 'notebook-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('data-testid', 'notebook-card');
    card.setAttribute('data-notebook-id', notebook.id || stripPdfExtension(notebook.name));
    card.setAttribute('data-notebook-name', notebook.name);
    card.setAttribute('data-notebook-url', notebook.url || bridge.getPdfUrl(notebook.name));
    card.setAttribute('data-notebook-color', notebook.color || '');
    card.setAttribute('data-notebook-folder', notebook.folder || '');
    card.setAttribute('aria-label', `${stripPdfExtension(notebook.name)} 열기`);

    const thumb = document.createElement('div');
    thumb.className = 'notebook-thumb';

    const spine = document.createElement('div');
    spine.className = 'notebook-spine';
    const spineColor = notebook.color || SPINE_PALETTE[hashString(notebook.name) % SPINE_PALETTE.length];
    spine.style.setProperty('--spine-color', spineColor);
    thumb.appendChild(spine);

    const lines = document.createElement('div');
    lines.className = 'notebook-lines';
    lines.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 6; i += 1) {
      lines.appendChild(document.createElement('span'));
    }
    thumb.appendChild(lines);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'card-delete-btn';
    delBtn.setAttribute('data-testid', 'delete-notebook-btn');
    delBtn.setAttribute('aria-label', `${notebook.name} 삭제`);
    delBtn.title = '삭제 · Delete';
    delBtn.appendChild(createTrashIconSvg());
    delBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openDeleteModal(notebook.name);
    });
    thumb.appendChild(delBtn);

    const footer = document.createElement('div');
    footer.className = 'notebook-footer';

    const titleEl = document.createElement('h3');
    titleEl.className = 'notebook-title';
    titleEl.textContent = notebook.title || stripPdfExtension(notebook.name);
    titleEl.title = notebook.title || stripPdfExtension(notebook.name);

    footer.appendChild(titleEl);

    card.appendChild(thumb);
    card.appendChild(footer);

    const openNotebook = () => {
      const targetUrl = notebook.url || bridge.getPdfUrl(notebook.name);
      window.location.assign(targetUrl);
    };

    card.addEventListener('click', openNotebook);
    card.addEventListener('keydown', (event) => {
      if (event.target === delBtn || delBtn.contains(event.target)) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openNotebook();
      }
    });

    return card;
  }

  function renderShelf() {
    els.loadingGrid.hidden = true;
    els.notebookCountPill.textContent = `${state.notebooks.length}권`;

    const visible = getFilteredAndSortedNotebooks();
    while (els.notebookGrid.firstChild) {
      els.notebookGrid.removeChild(els.notebookGrid.firstChild);
    }

    if (state.notebooks.length === 0) {
      els.notebookGrid.hidden = true;
      els.emptySearchState.hidden = true;
      els.emptyState.hidden = false;
      return;
    }

    if (visible.length === 0) {
      els.notebookGrid.hidden = true;
      els.emptyState.hidden = true;
      els.emptySearchState.hidden = false;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const nb of visible) {
      fragment.appendChild(createNotebookCardElement(nb));
    }
    els.notebookGrid.appendChild(fragment);
    els.emptyState.hidden = true;
    els.emptySearchState.hidden = true;
    els.notebookGrid.hidden = false;
  }

  function setErrorBanner(message) {
    if (!message) {
      els.errorBanner.hidden = true;
      els.errorBannerText.textContent = '';
      return;
    }
    els.errorBannerText.textContent = String(message);
    els.errorBanner.hidden = false;
  }

  /* ------------------------------------------------------------------------
   * Data Loading & Host Actions
   * ------------------------------------------------------------------------ */

  async function refreshAll() {
    setErrorBanner('');
    try {
      const [config, notebooks] = await Promise.all([
        bridge.getConfig(),
        bridge.listNotebooks(),
      ]);
      state.config = config;
      state.notebooks = notebooks;
      renderConfig();
      renderShelf();
    } catch (err) {
      els.loadingGrid.hidden = true;
      setErrorBanner(
        `데이터를 불러오지 못했습니다: ${(err && err.message) || 'Unknown error'}`
      );
    }
  }

  async function refreshNotebooks() {
    try {
      state.notebooks = await bridge.listNotebooks();
      renderShelf();
    } catch (err) {
      showToast((err && err.message) || '노트 목록을 새로고침하지 못했습니다.', 'error');
    }
  }

  async function handlePickFolder() {
    els.changeFolderBtn.disabled = true;
    try {
      const res = await bridge.pickFolder();
      if (res && !res.cancelled && res.saveDir) {
        state.config.saveDir = res.saveDir;
        renderConfig();
        await refreshNotebooks();
        showToast('저장 폴더가 변경되었습니다. / Save folder updated.', 'success');
      }
    } catch (err) {
      showToast((err && err.message) || '폴더를 변경하지 못했습니다.', 'error');
    } finally {
      els.changeFolderBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
   * New Notebook Modal
   * ------------------------------------------------------------------------ */

  function syncCustomSizeVisibility() {
    const sizeVal = els.nbPageSize.value;
    const isCustom = sizeVal === 'custom';
    els.nbCustomSizeRow.hidden = !isCustom;
    if (!isCustom && PRESET_DIMENSIONS[sizeVal]) {
      els.nbWidthMm.value = String(PRESET_DIMENSIONS[sizeVal].widthMm);
      els.nbHeightMm.value = String(PRESET_DIMENSIONS[sizeVal].heightMm);
    }
  }

  function showCreateFormError(msg) {
    if (!msg) {
      els.nbFormError.hidden = true;
      els.nbFormError.textContent = '';
      return;
    }
    els.nbFormError.textContent = msg;
    els.nbFormError.hidden = false;
  }

  function openNewNotebookModal() {
    els.newNotebookForm.reset();
    els.nbPageSize.value = 'a4';
    els.nbWidthMm.value = '210';
    els.nbHeightMm.value = '297';
    els.nbPages.value = '1';
    syncCustomSizeVisibility();
    showCreateFormError('');
    openOverlay('new-notebook-modal', els.nbTitle);
  }

  async function handleCreateNotebookSubmit(event) {
    event.preventDefault();
    if (state.isSubmittingCreate) return;
    showCreateFormError('');

    const title = els.nbTitle.value.trim();
    if (!title) {
      showCreateFormError('노트 제목을 입력해 주세요. / Please enter a notebook title.');
      els.nbTitle.focus();
      return;
    }
    if (title === '.' || title.includes('..') || /[/\\:*?"<>|]/.test(title)) {
      showCreateFormError(
        '제목에 .. 또는 / \\ : * ? " < > | 문자는 사용할 수 없습니다. / Title cannot contain ".." or invalid path characters.'
      );
      els.nbTitle.focus();
      return;
    }

    const templateInput = els.newNotebookForm.querySelector('input[name="template"]:checked');
    const template = templateInput ? templateInput.value : 'blank';
    const pageSize = els.nbPageSize.value;

    let widthMm;
    let heightMm;
    if (pageSize === 'custom') {
      widthMm = Number(els.nbWidthMm.value);
      heightMm = Number(els.nbHeightMm.value);
      if (
        !Number.isFinite(widthMm) ||
        !Number.isFinite(heightMm) ||
        widthMm < 50 ||
        widthMm > 1000 ||
        heightMm < 50 ||
        heightMm > 1000
      ) {
        showCreateFormError(
          '가로/세로 규격은 50 ~ 1000 mm 사이로 입력해 주세요. / Width & height must be 50–1000 mm.'
        );
        return;
      }
    } else if (PRESET_DIMENSIONS[pageSize]) {
      widthMm = PRESET_DIMENSIONS[pageSize].widthMm;
      heightMm = PRESET_DIMENSIONS[pageSize].heightMm;
    }

    const pages = Math.floor(Number(els.nbPages.value));
    if (!Number.isFinite(pages) || pages < 1 || pages > 50) {
      showCreateFormError('페이지 수는 1 ~ 50 사이로 입력해 주세요. / Pages must be 1–50.');
      els.nbPages.focus();
      return;
    }

    state.isSubmittingCreate = true;
    els.nbSubmitBtn.disabled = true;

    try {
      const result = await bridge.createNotebook({
        title,
        template,
        pageSize,
        widthMm,
        heightMm,
        pages,
      });
      closeOverlay('new-notebook-modal', false);
      const targetUrl = (result && result.url) || bridge.getPdfUrl(result.name);
      window.location.assign(targetUrl);
    } catch (err) {
      showCreateFormError((err && err.message) || '노트를 생성하지 못했습니다.');
    } finally {
      state.isSubmittingCreate = false;
      els.nbSubmitBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
   * Import PDF (File Picker & Drag-and-Drop)
   * ------------------------------------------------------------------------ */

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    let importedCount = 0;
    for (const file of files) {
      try {
        await bridge.importNotebook(file, file.name);
        importedCount += 1;
      } catch (err) {
        showToast(
          `${file.name}: ${(err && err.message) || '가져오기 실패'}`,
          'error',
          4500
        );
      }
    }

    if (importedCount > 0) {
      await refreshNotebooks();
      showToast(
        `${importedCount}개의 PDF를 가져왔습니다. / Imported ${importedCount} PDF(s).`,
        'success'
      );
    }
  }

  function setupDragAndDrop() {
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) {
        return;
      }
      event.preventDefault();
      state.dragDepth += 1;
      els.dropOverlay.hidden = false;
    });

    window.addEventListener('dragover', (event) => {
      if (state.dragDepth > 0) {
        event.preventDefault();
      }
    });

    window.addEventListener('dragleave', (event) => {
      if (state.dragDepth <= 0) return;
      event.preventDefault();
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) {
        els.dropOverlay.hidden = true;
      }
    });

    window.addEventListener('drop', (event) => {
      if (state.dragDepth <= 0 && !(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length)) {
        return;
      }
      event.preventDefault();
      state.dragDepth = 0;
      els.dropOverlay.hidden = true;
      if (event.dataTransfer && event.dataTransfer.files) {
        importFiles(event.dataTransfer.files);
      }
    });
  }

  /* ------------------------------------------------------------------------
   * Delete Modal
   * ------------------------------------------------------------------------ */

  function openDeleteModal(name) {
    state.pendingDeleteName = name;
    els.deleteTargetName.textContent = name;
    openOverlay('delete-modal', els.deleteCancelBtn);
  }

  async function handleConfirmDelete() {
    const name = state.pendingDeleteName;
    if (!name) return;
    els.deleteConfirmBtn.disabled = true;
    try {
      await bridge.deleteNotebook(name);
      closeOverlay('delete-modal');
      await refreshNotebooks();
      showToast(`"${name}" 삭제됨 / Deleted.`, 'success');
    } catch (err) {
      showToast((err && err.message) || '노트를 삭제하지 못했습니다.', 'error');
    } finally {
      els.deleteConfirmBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
   * Settings Drawer
   * ------------------------------------------------------------------------ */

  function flashSavedStatus() {
    if (!els.settingsSaveStatus) return;
    els.settingsSaveStatus.textContent = '저장됨 · Saved';
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => {
      els.settingsSaveStatus.textContent = '';
    }, 2000);
  }

  async function persistSettingsPatch(nextPatch) {
    const prevConfig = { ...state.config };
    state.config = { ...state.config, ...nextPatch };
    renderConfig();
    try {
      const updated = await bridge.updateConfig(nextPatch);
      if (updated && typeof updated === 'object') {
        state.config = { ...state.config, ...updated };
      }
      renderConfig();
      flashSavedStatus();
    } catch (err) {
      state.config = prevConfig;
      renderConfig();
      showToast((err && err.message) || '설정을 저장하지 못했습니다.', 'error');
    }
  }

  function handleAutosaveToggleChange() {
    const enabled = els.settingAutosaveEnabled.checked;
    let intervalSec = Number(els.settingAutosaveInterval.value);
    if (enabled && (!Number.isFinite(intervalSec) || intervalSec <= 0)) {
      intervalSec = 30;
    } else if (!enabled) {
      intervalSec = 0;
    }
    persistSettingsPatch({
      autosaveEnabled: enabled,
      autosaveIntervalSec: intervalSec,
    });
  }

  function handleAutosaveIntervalChange() {
    const intervalSec = Number(els.settingAutosaveInterval.value);
    const enabled = Number.isFinite(intervalSec) && intervalSec > 0;
    persistSettingsPatch({
      autosaveEnabled: enabled,
      autosaveIntervalSec: enabled ? intervalSec : 0,
    });
  }

  /* ------------------------------------------------------------------------
   * Init & Event Wiring
   * ------------------------------------------------------------------------ */

  function cacheElements() {
    els = {
      searchInput: document.getElementById('search-input'),
      searchClearBtn: document.getElementById('search-clear-btn'),
      sortSelect: document.getElementById('sort-select'),
      newNotebookBtn: document.getElementById('new-notebook-btn'),
      importPdfBtn: document.getElementById('import-pdf-btn'),
      importFileInput: document.getElementById('import-file-input'),
      settingsBtn: document.getElementById('settings-btn'),
      saveDirPath: document.getElementById('save-dir-path'),
      changeFolderBtn: document.getElementById('change-folder-btn'),
      autosaveStatusPill: document.getElementById('autosave-status-pill'),
      notebookCountPill: document.getElementById('notebook-count-pill'),
      errorBanner: document.getElementById('error-banner'),
      errorBannerText: document.getElementById('error-banner-text'),
      retryBtn: document.getElementById('retry-btn'),
      loadingGrid: document.getElementById('loading-grid'),
      notebookGrid: document.getElementById('notebook-grid'),
      emptyState: document.getElementById('empty-state'),
      emptySearchState: document.getElementById('empty-search-state'),
      emptyNewBtn: document.getElementById('empty-new-btn'),
      emptyImportBtn: document.getElementById('empty-import-btn'),
      clearSearchEmptyBtn: document.getElementById('clear-search-empty-btn'),
      dropOverlay: document.getElementById('drop-overlay'),
      newNotebookModal: document.getElementById('new-notebook-modal'),
      newNotebookForm: document.getElementById('new-notebook-form'),
      nbTitle: document.getElementById('nb-title'),
      nbPageSize: document.getElementById('nb-page-size'),
      nbPages: document.getElementById('nb-pages'),
      nbCustomSizeRow: document.getElementById('nb-custom-size-row'),
      nbWidthMm: document.getElementById('nb-width-mm'),
      nbHeightMm: document.getElementById('nb-height-mm'),
      nbFormError: document.getElementById('nb-form-error'),
      nbSubmitBtn: document.getElementById('nb-submit-btn'),
      settingsDrawer: document.getElementById('settings-drawer'),
      settingsCloseBtn: document.getElementById('settings-close-btn'),
      settingsSaveStatus: document.getElementById('settings-save-status'),
      settingAutosaveEnabled: document.getElementById('setting-autosave-enabled'),
      settingAutosaveInterval: document.getElementById('setting-autosave-interval'),
      settingPalmRejection: document.getElementById('setting-palm-rejection'),
      settingPseudoPressure: document.getElementById('setting-pseudo-pressure'),
      deleteModal: document.getElementById('delete-modal'),
      deleteTargetName: document.getElementById('delete-target-name'),
      deleteCancelBtn: document.getElementById('delete-cancel-btn'),
      deleteConfirmBtn: document.getElementById('delete-confirm-btn'),
      toastContainer: document.getElementById('toast-container'),
    };
  }

  function wireEvents() {
    // Search & Sort
    els.searchInput.addEventListener('input', () => {
      state.searchQuery = els.searchInput.value;
      els.searchClearBtn.hidden = !state.searchQuery;
      renderShelf();
    });

    const clearSearch = () => {
      state.searchQuery = '';
      els.searchInput.value = '';
      els.searchClearBtn.hidden = true;
      renderShelf();
      els.searchInput.focus();
    };
    els.searchClearBtn.addEventListener('click', clearSearch);
    els.clearSearchEmptyBtn.addEventListener('click', clearSearch);

    els.sortSelect.addEventListener('change', () => {
      state.sortBy = els.sortSelect.value;
      renderShelf();
    });

    // Primary Toolbar & Empty CTAs
    els.newNotebookBtn.addEventListener('click', openNewNotebookModal);
    els.emptyNewBtn.addEventListener('click', openNewNotebookModal);

    const triggerImportPicker = () => els.importFileInput.click();
    els.importPdfBtn.addEventListener('click', triggerImportPicker);
    els.emptyImportBtn.addEventListener('click', triggerImportPicker);

    els.importFileInput.addEventListener('change', async () => {
      try {
        await importFiles(els.importFileInput.files);
      } finally {
        els.importFileInput.value = '';
      }
    });

    const openSettings = () => openOverlay('settings-drawer', els.settingsCloseBtn);
    els.settingsBtn.addEventListener('click', openSettings);
    els.autosaveStatusPill.addEventListener('click', openSettings);

    els.changeFolderBtn.addEventListener('click', handlePickFolder);
    els.retryBtn.addEventListener('click', refreshAll);

    // New Notebook Form
    els.nbPageSize.addEventListener('change', syncCustomSizeVisibility);
    els.newNotebookForm.addEventListener('submit', handleCreateNotebookSubmit);

    // Settings Controls
    els.settingAutosaveEnabled.addEventListener('change', handleAutosaveToggleChange);
    els.settingAutosaveInterval.addEventListener('change', handleAutosaveIntervalChange);
    els.settingPalmRejection.addEventListener('change', () => {
      persistSettingsPatch({ palmRejection: els.settingPalmRejection.checked });
    });
    els.settingPseudoPressure.addEventListener('change', () => {
      persistSettingsPatch({ pseudoPressure: els.settingPseudoPressure.checked });
    });

    // Delete Modal
    els.deleteConfirmBtn.addEventListener('click', handleConfirmDelete);

    // Close buttons & backdrop clicks
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeOverlay(btn.getAttribute('data-close-modal'));
      });
    });

    [els.newNotebookModal, els.settingsDrawer, els.deleteModal].forEach((backdrop) => {
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
          closeOverlay(backdrop.id);
        }
      });
    });

    // Global Escape key
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.activeOverlayId) {
        event.preventDefault();
        closeOverlay(state.activeOverlayId);
      }
    });

    // Refresh when returning from native PDF viewer via bfcache
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        refreshAll();
      }
    });

    setupDragAndDrop();
  }

  function init() {
    if (typeof window.createHostBridge !== 'function') {
      return;
    }
    bridge = window.createHostBridge();
    cacheElements();
    wireEvents();
    refreshAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
