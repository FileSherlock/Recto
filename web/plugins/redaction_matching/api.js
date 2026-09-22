/* =========================================================
       Inspection Logic — reads/writes utbState.boxes directly
       ========================================================= */

    /* ── Plugin-owned state & DOM ──────────────────────────────
       The core declares nothing plugin-specific: `state` holds only viewer
       state and `els` only core elements. So this plugin contributes its own
       fields onto both, here, at load time. Delete this folder and they go
       with it — which is exactly why the core no longer declares them.

       This file is a `scripts_before_viewer` entry, so it runs after state.js
       (which defines `state`/`els`) and before pdf-viewer.js — and the sidebar
       and Match-ribbon markup are already in the DOM at parse time.
       ───────────────────────────────────────────────────────── */
    Object.assign(state, {
      namesData: [],              // raw JSON entries from the candidate list
      customCandidates: [],       // names added manually (shared across all boxes)
      excludedPersons: new Set(), // indices into namesData that were deleted — global
      candidates: [],             // template/global union (template nameSettings ∪ custom)

      // Template name-format settings: edited when no box is selected, copied
      // onto each new redaction box. Per-box overrides live on box.nameSettings.
      nameSettings: {
        generateFull: true,
        generateFirstOnly: false,
        generateLastOnly: false,
        includePrefix: false,
        includeSuffix: false,
        // Every spelling a person has, by default: the memos write "Lex
        // Wexner" and "Adriana Mucinska", second aliases in the list, and a
        // name the list holds but never generates is a bar the page pixels
        // are never asked about.
        expandFirstAliases: true,
        expandLastAliases: true,
        includeNickname: false,
        startsWith: '',
        endsWith: '',
      },

      // Candidates pagination/sort
      page: 1,
      perPage: 15,
      sortBy: 'name',
      sortDir: 'asc',
    });

    Object.assign(els, {
      // Match controls — live in text_tool's formatting ribbon (shared IDs).
      // Absent when text_tool isn't installed; every read/write guards for that.
      tol:   document.getElementById('tolerance'),
      kern:  document.getElementById('kerning'),
      upper: document.getElementById('tt-name-case'),   // '' | 'all' | 'first' | 'last' (text_tool's utbCaseMode)

      // This plugin's own sidebar (templates/redaction_matching/sidebar_tools.html)
      nameInput:  document.getElementById('name-input'),
      pasteInput: document.getElementById('paste-input'),
      tableBody:  document.getElementById('names-body'),
      pageInfo:   document.getElementById('page-info'),

      allMatchesCard:    document.getElementById('all-matches-card'),
      allMatchesSummary: document.getElementById('all-matches-summary'),
      allMatchesBody:    document.getElementById('all-matches-body'),
    });

    // ── Helpers ─────────────────────────────────────────────────

    // A name as the bar writes it: box.uppercase is false, true, 'first' or
    // 'last' (text_tool's utbApplyCase; without it, capitals or as typed)
    const caseName = (box, s) => (typeof utbApplyCase === 'function' ? utbApplyCase(String(s), box?.uppercase)
      : box?.uppercase ? String(s).toUpperCase() : String(s));
    const caseMode = value => (typeof utbCaseMode === 'function' ? utbCaseMode(value) : value === 'all');
    const caseValue = mode => (typeof utbCaseValue === 'function' ? utbCaseValue(mode) : mode ? 'all' : '');

    /** Get all redaction-type UTB boxes. */
    function getRedactionBoxes() {
      return typeof utbState !== 'undefined'
        ? utbState.boxes.filter(b => b.type === 'redaction')
        : [];
    }

    /**
     * Box width a candidate's measured width is compared against — simply box.w.
     * The candidate's measured width (box.widths[c]) already places the Space W.
     * value between its words (see calculateWidthsForRedaction), so a multi-word
     * name's width adds up to the full box width directly. No hidden per-candidate
     * trailing-space subtraction.
     */
    function candidateEW(box) {
      return box.w;
    }
    window.candidateEW = candidateEW;

    /** Median of an array of numbers (robust to a stray double space). */
    function _median(nums) {
      const s = [...nums].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // A line counts as "not justified" when its median detected space is within
    // this much of the font's natural HarfBuzz advance — then we use the precise
    // natural value instead of the measured one. Relative, with an absolute floor;
    // doubles as the max error accepted from that substitution.
    const JUSTIFY_SPACE_TOL_FRAC = 0.12;
    const JUSTIFY_SPACE_TOL_FLOOR_PX = 0.5;

    /** Get the currently selected redaction box (or null). */
    function getSelectedRedaction() {
      if (typeof utbState === 'undefined' || !utbState.selectedId) return null;
      const box = utbState.getBox(utbState.selectedId);
      return box && box.type === 'redaction' ? box : null;
    }

    // ── Name generation from JSON ─────────────────────────────

    // Starts-with / ends-with filter. A candidate passes when it begins with
    // settings.startsWith (if set) and ends with settings.endsWith (if set) —
    // one or more letters each, case-insensitive. Applied to the rendered
    // candidate string, so it naturally adapts to the format: for a
    // first-name-only candidate the ending comes from the first name; for a
    // last-name-only candidate the start comes from the last name. Empty fields
    // impose no constraint.
    function matchesLetterFilter(str, settings) {
      const pre = (settings.startsWith || '').trim().toLowerCase();
      const suf = (settings.endsWith || '').trim().toLowerCase();
      if (!pre && !suf) return true;
      const s = (str || '').trim().toLowerCase();
      if (!s) return false;
      if (pre && !s.startsWith(pre)) return false;
      if (suf && !s.endsWith(suf)) return false;
      return true;
    }
    window.matchesLetterFilter = matchesLetterFilter;

    // opts.excluded — Set<personIndex> to skip entirely (deleted people).
    // opts.ownerMap — Map<string, Set<personIndex>>, populated if provided so a
    //                 displayed candidate can be traced back to the person(s) that
    //                 produced it (used by removeName to delete the whole name).
    function generateCandidatesFromData(namesData, settings, opts = {}) {
      const excluded = opts.excluded || null;
      const ownerMap = opts.ownerMap || null;
      const result = new Set();
      const add = (str, i) => {
        if (!matchesLetterFilter(str, settings)) return;
        result.add(str);
        if (ownerMap) {
          let owners = ownerMap.get(str);
          if (!owners) ownerMap.set(str, owners = new Set());
          owners.add(i);
        }
      };
      for (let i = 0; i < namesData.length; i++) {
        if (excluded && excluded.has(i)) continue;
        const person = namesData[i];
        const firsts = person.first.length > 0
          ? (settings.expandFirstAliases ? person.first : [person.first[0]])
          : [];
        const lasts = person.last.length > 0
          ? (settings.expandLastAliases ? person.last : [person.last[0]])
          : [];
        const pre = settings.includePrefix && person.prefix ? person.prefix + ' ' : '';
        const suf = settings.includeSuffix && person.suffix ? ' ' + person.suffix : '';

        if (settings.generateFull) {
          if (firsts.length > 0 && lasts.length > 0) {
            for (const f of firsts) for (const l of lasts) add(`${pre}${f} ${l}${suf}`.trim(), i);
          } else if (firsts.length > 0) {
            for (const f of firsts) add(`${pre}${f}${suf}`.trim(), i);
          } else if (lasts.length > 0) {
            for (const l of lasts) add(`${pre}${l}${suf}`.trim(), i);
          }
        }
        if (settings.generateFirstOnly) {
          for (const f of firsts) add(f, i);
        }
        if (settings.generateLastOnly) {
          for (const l of lasts) add(l, i);
        }
        if (settings.includeNickname && person.nickname) {
          add(person.nickname, i);
        }
      }
      return [...result];
    }

    // ── Per-box name settings ─────────────────────────────────
    //
    // The Name-format settings (Generate / Include / Expand aliases) are stored
    // per redaction box on box.nameSettings, with box.candidates holding that
    // box's generated list ∪ the shared custom names. The sidebar panel reflects
    // whichever scope is "active": the selected box, or — when nothing is
    // selected — state.nameSettings, the template copied onto each new box.

    /** Ensure a box has its own name settings (a copy of the template on first use). */
    function ensureBoxNameSettings(box) {
      if (!box.nameSettings) box.nameSettings = { ...state.nameSettings };
      return box.nameSettings;
    }

    /** The settings object the sidebar panel currently edits. */
    function getActiveNameSettings() {
      const box = getSelectedRedaction();
      return box ? ensureBoxNameSettings(box) : state.nameSettings;
    }

    /** Recompute a single box's candidate list: its format applied to the global
     *  people pool (minus deleted people) ∪ the shared custom names. Also caches an
     *  owner map (string → person indices) so a deleted row maps back to a person. */
    function rebuildBoxCandidates(box) {
      ensureBoxNameSettings(box);
      const ownerMap = new Map();
      const fromJson = generateCandidatesFromData(state.namesData, box.nameSettings, {
        excluded: state.excludedPersons,
        ownerMap,
      });
      box._candidateOwners = ownerMap;
      const customs = state.customCandidates.filter(c => matchesLetterFilter(c, box.nameSettings));
      box.candidates = [...new Set([...fromJson, ...customs])];
      return box.candidates;
    }

    /** A box's candidate list, computed lazily on first access. */
    function getBoxCandidates(box) {
      if (!box) return [];
      if (!box.candidates) rebuildBoxCandidates(box);
      return box.candidates;
    }

    function rebuildAllBoxCandidates() {
      for (const box of getRedactionBoxes()) rebuildBoxCandidates(box);
    }

    /** Maintain state.candidates: the template universe (template settings ∪ custom),
     *  used by the uppercase heuristic when snapping boxes to embedded text lines. */
    function rebuildTemplateUnion() {
      const fromJson = generateCandidatesFromData(state.namesData, state.nameSettings, {
        excluded: state.excludedPersons,
      });
      state.candidates = [...new Set([...fromJson, ...state.customCandidates])];
    }

    /** Push the active settings into the sidebar checkboxes + count. */
    function syncNameSettingsUI() {
      const s = getActiveNameSettings();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      set('ns-full',         s.generateFull);
      set('ns-first-only',   s.generateFirstOnly);
      set('ns-last-only',    s.generateLastOnly);
      set('ns-prefix',       s.includePrefix);
      set('ns-suffix',       s.includeSuffix);
      set('ns-nickname',     s.includeNickname);
      set('ns-expand-first', s.expandFirstAliases);
      set('ns-expand-last',  s.expandLastAliases);

      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
      setVal('ns-starts-with', s.startsWith);
      setVal('ns-ends-with',   s.endsWith);

      // Tell the user which scope these controls currently edit.
      const scopeEl = document.getElementById('name-format-scope');
      if (scopeEl) {
        const box = getSelectedRedaction();
        scopeEl.textContent = box ? '· this box' : '· new boxes';
        scopeEl.title = box
          ? 'Applies to the selected redaction box only'
          : 'No box selected — these become the defaults for new redaction boxes';
      }
      updateNameSettingsCount();
    }
    window.syncNameSettingsUI = syncNameSettingsUI;

    function rebuildCandidates() {
      rebuildTemplateUnion();
      rebuildAllBoxCandidates();
      updateNameSettingsCount();
      calculateAllWidths();
    }

    function updateNameSettingsCount() {
      const el = document.getElementById('name-settings-count');
      if (!el) return;
      const active = getActiveNameSettings();
      const jsonCount = generateCandidatesFromData(state.namesData, active, {
        excluded: state.excludedPersons,
      }).length;
      // Counts reflect the active letter filter too.
      const customCount = state.customCandidates.filter(c => matchesLetterFilter(c, active)).length;
      el.textContent = customCount > 0
        ? `${jsonCount} from list + ${customCount} custom`
        : `${jsonCount} from list`;
    }

    function readNameSettings() {
      const s = getActiveNameSettings();
      s.generateFull        = document.getElementById('ns-full').checked;
      s.generateFirstOnly   = document.getElementById('ns-first-only').checked;
      s.generateLastOnly    = document.getElementById('ns-last-only').checked;
      s.includePrefix       = document.getElementById('ns-prefix').checked;
      s.includeSuffix       = document.getElementById('ns-suffix').checked;
      s.includeNickname     = document.getElementById('ns-nickname').checked;
      s.expandFirstAliases  = document.getElementById('ns-expand-first').checked;
      s.expandLastAliases   = document.getElementById('ns-expand-last').checked;
      s.startsWith          = (document.getElementById('ns-starts-with')?.value || '').trim();
      s.endsWith            = (document.getElementById('ns-ends-with')?.value || '').trim();
    }

    function onNameSettingChange() {
      readNameSettings();
      const box = getSelectedRedaction();
      if (box) {
        // Per-box edit: rebuild and re-measure just this box.
        rebuildBoxCandidates(box);
        updateNameSettingsCount();
        calculateWidthsForRedaction(box.id);
      } else {
        // No selection: we edited the template for future boxes. Keep the
        // global heuristic universe in sync; existing boxes are untouched.
        rebuildTemplateUnion();
        updateNameSettingsCount();
        renderCandidates();
      }
    }

    // A refiner (when installed) announces, per bar, the letters it found
    // sticking out of the bar — slivers of the hidden name itself (the exposed
    // "S" of "SARAH"). They are the name's own first/last letters, so they
    // become that box's starts-with / ends-with filter — unless the user has
    // already typed one. Generic hook, no plugin named; nothing fires without a
    // refiner and nothing here breaks.
    window.PDFHooks?.on('redaction:refined', ({ boxId, remnants } = {}) => {
      if (!remnants?.length || typeof utbState === 'undefined') return;
      const box = utbState.getBox(boxId);
      if (!box || box.type !== 'redaction') return;
      const s = ensureBoxNameSettings(box);
      const pre = remnants.filter(r => r.side === 'left').map(r => r.text).join('');
      const suf = remnants.filter(r => r.side === 'right').map(r => r.text).join('');
      let changed = false;
      if (pre && !s.startsWith) { s.startsWith = pre; s.startsWithAuto = true; changed = true; }
      if (suf && !s.endsWith)   { s.endsWith = suf;   s.endsWithAuto = true;   changed = true; }
      if (!changed) return;
      rebuildBoxCandidates(box);
      if (utbState.selectedId === box.id) syncNameSettingsUI();
      calculateWidthsForRedaction(box.id);
    });

    /** Surface a names-list load failure loudly instead of silently emptying the list. */
    function showNamesLoadError(msg) {
      const countEl = document.getElementById('name-settings-count');
      if (countEl) countEl.textContent = '⚠ names list failed to load';

      let banner = document.getElementById('names-load-error');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'names-load-error';
        banner.title = 'Click to dismiss';
        banner.style.cssText = [
          'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
          'z-index:99999', 'max-width:90vw', 'padding:10px 14px',
          'background:#b00020', 'color:#fff', 'font:13px/1.4 system-ui,sans-serif',
          'border-radius:6px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
          'cursor:pointer', 'white-space:pre-wrap'
        ].join(';');
        banner.addEventListener('click', () => banner.remove());
        document.body.appendChild(banner);
      }
      banner.textContent = `Names list failed to load — ${msg}`;
    }

    async function loadNamesData() {
      try {
        const resp = await fetch(assetURL('plugins/redaction_matching/names.json'));
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching names file`);

        const raw = await resp.text();
        try {
          state.namesData = JSON.parse(raw);
        } catch (parseErr) {
          // Pinpoint the offending spot. Chrome reports "...position N...",
          // Firefox reports "line N column N"; fall back to the raw message otherwise.
          let where = '';
          const posM = /position (\d+)/.exec(parseErr.message);
          const lcM  = /line (\d+) column (\d+)/.exec(parseErr.message);
          if (posM) {
            const pos = +posM[1];
            const before = raw.slice(0, pos);
            where = ` (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`;
          } else if (lcM) {
            where = ` (line ${lcM[1]}, column ${lcM[2]})`;
          }
          throw new Error(`names file is not valid JSON${where}: ${parseErr.message}`);
        }

        rebuildCandidates();
      } catch (e) {
        console.error('Failed to load names list:', e);
        showNamesLoadError(e.message);
      }
    }

    document.addEventListener('DOMContentLoaded', loadNamesData);
    document.addEventListener('DOMContentLoaded', syncNameSettingsUI);

    // Enter in the name field adds the candidate. This binding used to live in
    // the core's app.js; it is plugin UI, so it lives with the plugin now.
    document.addEventListener('DOMContentLoaded', () => {
      els.nameInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') addName();
      });
    });

    // Candidates-sidebar toggle. The host <aside>, its toggle button, CSS and
    // this wiring all belong to this plugin — the core owns no right panel. The
    // panel starts open (button carries `active`); clicking collapses/expands.
    document.addEventListener('DOMContentLoaded', () => {
      const btn   = document.getElementById('toggle-tools');
      const panel = document.getElementById('tools-sidebar');
      btn?.addEventListener('click', () => {
        const nowHidden = panel?.classList.toggle('hidden');
        btn.classList.toggle('active', !nowHidden);
      });
    });

    // ── Candidate management ──────────────────────────────────

    // Names come one per line or comma-separated ("Jane Doe, John Smith"), in
    // the Add field and in Paste Mode alike. A comma is a separator, never
    // part of a name: "Smith, John" is two names here.
    const splitNames = text => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

    function addCustomNames(names) {
      let added = 0;
      for (const n of names) {
        if (state.customCandidates.includes(n)) continue;
        state.customCandidates.push(n);
        added++;
      }
      if (added) {
        rebuildTemplateUnion();
        rebuildAllBoxCandidates();
        updateNameSettingsCount();
        calculateAllWidths();
      }
      return added;
    }
    function addName() {
      const names = splitNames(els.nameInput.value);
      if (!names.length) return;
      addCustomNames(names);
      els.nameInput.value = '';
    }
    function processPaste() {
      addCustomNames(splitNames(els.pasteInput.value));
      els.pasteInput.value = '';
      document.getElementById('paste-area').style.display = 'none';
    }

    function clearAll() {
      if (confirm('Clear custom names and restore all deleted names?')) {
        state.customCandidates = [];
        state.excludedPersons.clear();
        rebuildCandidates();
      }
    }
    // Every name goes — the shipped list's people as well as the custom ones —
    // so a document can be matched against nothing but the names typed in.
    // "Clear Custom" brings the shipped list back.
    function deleteAllNames() {
      if (!confirm('Delete every name, the shipped list included? "Clear Custom" restores the list.')) return;
      state.customCandidates = [];
      state.excludedPersons = new Set(state.namesData.map((_, i) => i));
      rebuildCandidates();
    }

    // Delete a candidate globally. Clicking a row (which may show just a first or
    // last name) removes the WHOLE person from the shared pool, so every variant
    // disappears from every box. Custom names are simply dropped from the list.
    function removeName(name) {
      const box = getSelectedRedaction();
      const owners = box && box._candidateOwners ? box._candidateOwners.get(name) : null;
      if (owners) for (const idx of owners) state.excludedPersons.add(idx);
      state.customCandidates = state.customCandidates.filter(c => c !== name);

      rebuildTemplateUnion();
      rebuildAllBoxCandidates();
      updateNameSettingsCount();
      calculateAllWidths();
    }

    // ── Width calculation ─────────────────────────────────────

    async function calculateAllWidths() {
        const boxes = getRedactionBoxes();
        if (boxes.length === 0) return;
        for (const box of boxes) {
            await calculateWidthsForRedaction(box.id);
        }
        updateAllMatchesView(null);
    }

    async function calculateWidthsForRedaction(boxId) {
      await document.fonts.ready;
      const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;

      // Determine the inter-word space width for this redaction's line.
      //
      // The font's natural space advance (from HarfBuzz) is the truth for any
      // line that ISN'T justified — it's exact, while the on-page measurements
      // carry rounding and coverage noise. Justification only ever STRETCHES
      // spaces above that natural advance; it never compresses them. So:
      //
      //   1. Drop measured spaces that read clearly BELOW natural — those are
      //      artifacts: a space partly hidden under the redaction box reads
      //      small (e.g. the lone 2.7 among ~4.0s), it is not a real spacing.
      //   2. Look at the typical (median) of what remains:
      //        • clusters at / around natural  → line is NOT justified
      //          → snap to the precise HarfBuzz advance.
      //        • sits clearly ABOVE natural     → line IS justified
      //          → trust the measured median stretch.
      //
      // This is what lets the un-justified last lines (which sit in a sea of
      // justified text) be detected as un-justified and use the exact width.
      //
      // The natural advance is computed at the LINE's own font + size (from its
      // embedded spans), not the redaction's global defaults, so a size mismatch
      // can't skew the comparison.
      if (box.lineId && (box.spaceWidth == null || box.defaultSpaceWidth !== false)) {
        const lineSpans = utbState.boxes.filter(
          b => b.lineId === box.lineId && b.type === 'embedded' && b.baseCharPositions
        );
        const detected = lineSpans
          .flatMap(b => b.baseCharPositions.filter(cp => cp.c === ' '))
          .map(cp => cp.w || 0)
          .filter(w => w > 0);

        if (detected.length > 0) {
          // Source font sizes are clean whole points (12pt here); per-span
          // extraction adds sub-point noise (one line reads 11.8, the next 12.0)
          // which would otherwise leak straight into the natural space width and
          // make same-size lines disagree (3.9 vs 4.0). Snap the line's measured
          // size to the nearest whole point — per line, so a genuinely different
          // size (e.g. a heading) is still respected.
          //
          // sizePt stays in PDF POINTS: the shaper applies the 4/3
          // (96/72 DPI) scale itself, so 12pt already renders as the 16px-space.
          // Passing 16 here would over-size the space by 4/3.
          const lineSizePt = _median(lineSpans.map(b => b.sizePt).filter(s => s > 0));
          const rawSizePt = lineSizePt || box.sizePt;
          const sizePt = rawSizePt ? Math.round(rawSizePt) : rawSizePt;
          const lineFont = lineSpans[0]?.fontFamily || box.fontFamily;
          let natural = null;
          if (typeof getNaturalSpaceWidth === 'function') {
            natural = await getNaturalSpaceWidth({
              fontFamily: lineFont,
              sizePt: sizePt,
              kerning: box.kerning,
            });
          }

          let spaceW;
          if (natural != null) {
            const tol = Math.max(JUSTIFY_SPACE_TOL_FLOOR_PX, natural * JUSTIFY_SPACE_TOL_FRAC);
            // Ignore sub-natural artifacts (covered / truncated spaces), then
            // judge justification from what's left.
            const real = detected.filter(w => w >= natural - tol);
            const typical = real.length ? _median(real) : natural;
            spaceW = (typical > natural + tol) ? typical : natural;
          } else {
            // No HarfBuzz reference — fall back to the robust raw median.
            spaceW = _median(detected);
          }

          box.spaceWidth = spaceW;
          box.defaultSpaceWidth = false;
          box.nativeSpaceWidth = natural != null ? natural : _median(detected);
          if (typeof renderBox === 'function') renderBox(box);
          if (typeof syncToolbarToBox === 'function' && utbState.selectedId === box.id) {
            syncToolbarToBox(box);
          }
        }
      }

      const candidates = getBoxCandidates(box);
      // A bar that forms a name with another bar (linkFor) also needs its own
      // half of every person measured — the first names, or the last names —
      // so the pair readings can be judged bar by bar.
      const link = linkFor(box);
      const strings = [...new Set([...candidates, ...(link ? halfStrings(box, link) : [])])];
      if (strings.length === 0) {
        box.widths = {};
        if (utbState.selectedId === boxId) {
            renderCandidates();
        }
        return;
      }

      // Candidate widths come from HarfBuzz (text_tool's Shaping.widths) — the same
      // deterministic shaper text_tool and getNaturalSpaceWidth already use,
      // reported in the document's image-pixel space so they compare directly
      // against box.w. This used to measure in the browser via getBBox(), which
      // was NON-DETERMINISTIC: before the page font finished laying out, a fresh
      // SVG <text> node reports fallback-font metrics, so the same name measured
      // a few px wider on some app restarts than on others. HarfBuzz reads the
      // true font metrics identically every run.
      const size  = box.sizePt;          // POINTS — the shaper applies the DPI scale itself
      const scale = GEO.docScale();      // px-per-pt × 100 for this document

      // A manual Space W. overrides the font's natural space advance: the slider
      // sets the inter-word gap directly, so the shaper substitutes it for every
      // space glyph and a multi-word candidate adds up to the full box width.
      const manualSpace = box.spaceWidth != null && box.defaultSpaceWidth === false;

      // letter-spacing (rare on redactions) adds a fixed advance between
      // every pair of glyphs; the shaper doesn't model it, so fold it in.
      const lsPx = box.letterSpacing ? box.letterSpacing * GEO.docPtToPx(box.sizePt) : 0;
      const spaced = (c, w) => lsPx ? w + lsPx * Math.max(0, caseName(box, c).length - 1) : w;

      box.widths = {};
      box.widthFace = null;
      try {
        // text_tool's shaper (HarfBuzz in the browser); without it nothing is measured
        const data = typeof Shaping !== 'undefined' ? await Shaping.widths({
          strings: strings.map(c => caseName(box, c)),     // as the bar writes them
          // The bar's face is its text line's (adopted when the bar was
          // connected to the line), resolved through the font catalogue.
          family: box.fontFamily,
          bold: !!box.bold,
          italic: !!box.italic,
          size, scale,
          kerning: box.kerning,
          // Plain advances: a producer that set no ligatures (Word, by
          // default) laid "Groff" at f + f, and HarfBuzz's ff/tt ligatures
          // would put such a name half a pixel short of its bar — outside
          // the pen lattice. The reader's set (below) is plain too.
          ligatures: false,
          space_width: manualSpace ? box.spaceWidth : null,
        }) : null;
        if (data) {
          const results = data.results || [];
          strings.forEach((c, i) => { box.widths[c] = spaced(c, results[i]?.width ?? 0); });
        }
      } catch (e) {
        console.warn('[redaction_matching] candidate widths failed', e);
      }

      // The page's own face, when a reader has read the row: an optional
      // provider (ocr_tool over the reader's glyph set) lays the strings out
      // in the face that actually drew the page — the same advances when it
      // is the installed build, the producer's when it is another (LAWS §6:
      // a 2008 Times draws the current outlines at other advances). A string
      // the set cannot draw keeps its HarfBuzz width; without a provider
      // nothing changes.
      if (typeof ocrMeasureWidths === 'function') {
        try {
          const r = await ocrMeasureWidths(box, strings);
          if (r && Array.isArray(r.widths)) {
            strings.forEach((c, i) => { if (r.widths[i] != null) box.widths[c] = spaced(c, r.widths[i]); });
            box.widthFace = r.face || null;
          }
        } catch (e) {
          console.warn('[redaction_matching] page-face widths failed', e);
        }
      }

      await scoreMatches(box);
      // The partner bar's pair readings depend on this bar's widths — judge
      // them now that both halves are measured.
      if (link && link.other.widths && Object.keys(link.other.widths).length) await scoreMatches(link.other);

      if (utbState.selectedId === boxId) {
          renderCandidates();
          updateAllMatchesView(link ? null : boxId);
      }
    }

    // ── Pagination & sorting ──────────────────────────────────

    function changePage(delta) {
      state.page += delta;
      renderCandidates();
    }

    function setSort(f) {
      if (state.sortBy === f) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortBy = f; state.sortDir = 'asc'; }
      state.page = 1;
      renderCandidates();
    }

    // ── Candidates table ──────────────────────────────────────

    function renderCandidates() {
      document.getElementById('sort-icon').textContent = state.sortDir === 'asc' ? '▲' : '▼';

      const box = getSelectedRedaction();
      const candidates = box ? getBoxCandidates(box) : state.candidates;

      const sorted = [...candidates].sort((a, b) => {
        let va = state.sortBy === 'width' && box ? (box.widths[a] || 0) : a.toLowerCase();
        let vb = state.sortBy === 'width' && box ? (box.widths[b] || 0) : b.toLowerCase();
        if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
        if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
        return 0;
      });

      const totalPages = Math.ceil(sorted.length / state.perPage) || 1;
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;

      const start = (state.page - 1) * state.perPage;
      const slice = sorted.slice(start, start + state.perPage);
      els.pageInfo.textContent = `List: ${candidates.length} (${state.page}/${totalPages})`;

      const btnPrev = document.getElementById('btn-prev-page');
      const btnNext = document.getElementById('btn-next-page');
      if (btnPrev) btnPrev.disabled = state.page <= 1;
      if (btnNext) btnNext.disabled = state.page >= totalPages;

      const info = box ? getBoxMatchInfo(box) : { matches: [], entries: [] };
      const matches = info.matches;
      const shown = box ? shownMatch(box, info.entries).name : null;
      els.tableBody.innerHTML = slice.map(n => {
        const w = box ? box.widths[n] : undefined;
        const isMatch = matches.includes(n);
        const esc = n.replace(/'/g, "&apos;");
        const disp = caseName(box, n);
        const rowClass = isMatch ? (n === shown ? 'best-match shown-match' : 'best-match') : '';
        const fontStyle = box ? ` style="font-family:${box.fontFamily || 'inherit'};"` : '';
        const pick = isMatch ? ` data-name="${escAttr(n)}" title="Fits this bar — click to show it on the bar"` : '';

        return `
          <tr class="${rowClass}">
            <td${fontStyle}${pick}>
              ${escAttr(disp)}
            </td>
            <td class="col-right">${w !== undefined ? w.toFixed(2) : '-'}</td>
            <td class="col-del"><button class="btn-del" onclick="removeName('${esc.replace(/'/g, "\\'")}')">&times;</button></td>
          </tr>
        `;
      }).join('');
    }


    // ── Selection ─────────────────────────────────────────────

    async function selectRedaction(boxId) {
      const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;

      // Navigate to the redaction's page first if not already there
      if (state.currentPage !== box.page) {
        await goToPage(box.page);
      }

      utbState.selectedId = box.id;

      // Redaction-specific controls — the Match controls live in text_tool's
      // formatting ribbon, so these els are absent when text_tool isn't loaded.
      // Guard each write (can't use ?. on an assignment target) so selection
      // still works standalone. Reads elsewhere already guard with ?..
      if (els.tol) els.tol.value = box.tolerance;
      if (els.kern) els.kern.checked = !!box.kerning;
      if (els.upper) els.upper.value = caseValue(box.uppercase);

      // Reflect this box's per-box name-format settings in the sidebar panel.
      syncNameSettingsUI();

      // Deselect all SVG groups, then select this one
      if (typeof selectBoxInSVG === 'function') selectBoxInSVG(box.id);

      // Sync the formatting toolbar
      if (typeof syncToolbarToBox === 'function') syncToolbarToBox(box);

      // Highlight the matching row in the All Matches table
      document.querySelectorAll('#all-matches-body tr').forEach(el => el.classList.remove('selected-row'));
      const rowEl = document.getElementById(`match-row-${box.id}`);
      if (rowEl) {
        rowEl.classList.add('selected-row');
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      // Scroll the SVG element into view within the viewer
      const svgGroup = document.querySelector(`.utb-group[data-id="${box.id}"]`);
      if (svgGroup) {
        const parentRect = els.viewerContainer.getBoundingClientRect();
        const targetRect = svgGroup.getBoundingClientRect();
        if (targetRect.top < parentRect.top || targetRect.bottom > parentRect.bottom) {
          els.viewerContainer.scrollTo({
            top: els.viewerContainer.scrollTop + (targetRect.top - parentRect.top) - (parentRect.height / 2),
            behavior: 'smooth'
          });
        }
      }

      renderCandidates();
      updateAllMatchesView(boxId);
    }

    // ── Matches: which names fit a bar, and which one it shows ─

    // When a refiner has rebuilt the bar from the reader's OCR pens on both
    // sides, its width is exact to mupdf's ¼-px pen lattice — a pen cannot land
    // anywhere else — so a name either fits to a quarter pixel or it does not.
    // Two ⅛-px snaps of slack. The pixel tolerance field is for bars whose
    // edges are only as good as a raster (guide/plugins/redaction-refiner/
    // pixel-evidence-plan.md §0). On the reference page this turns 62 names
    // within 3 px into the 5 that tie to the font unit.
    const PEN_TOL_PX = 0.3;

    /** Is the bar's width pen-exact? Set by an optional refiner on
     *  box.refineInfo; a bar moved or resized since is no longer exact. */
    function penExact(box) {
      const i = box.refineInfo;
      return !!(i && i.exact && i.x === box.x && i.w === box.w);
    }

    /** The tolerance in force: the pen lattice when the width is pen-exact
     *  (a tighter user field still wins), else the user's pixel field. */
    function effectiveTolerance(box) {
      const t = box.tolerance ?? 3;
      return penExact(box) ? Math.min(t, PEN_TOL_PX) : t;
    }
    window.effectiveTolerance = effectiveTolerance;

    // How much narrower (`under`) and wider (`over`) than the bar a name may
    // measure and still fit. `over` is the tolerance in force. `under` grows
    // to the redactor's padding when an edge is the detector's: with no
    // reader pen on that side the bar ends where the black box ends, and the
    // box was drawn with room to spare (4.4 px past BLEDSOE on the reference
    // page). The padding is the redaction tool's, a few pixels, so it is
    // taken as a fraction of the size with a cap. Without a refiner every
    // edge is the detector's.
    const DETECTOR_PAD_EM = 0.4;
    const DETECTOR_PAD_MAX_PX = 10;
    function fitRange(box) {
      const over = effectiveTolerance(box);
      const i = box.refineInfo;
      const detectorEdge = !i || !i.left || !i.right;
      const pad = Math.min(DETECTOR_PAD_MAX_PX, DETECTOR_PAD_EM * emPx(box));
      return { over, under: detectorEdge ? Math.max(over, pad) : over };
    }
    window.fitRange = fitRange;
    const fitsRange = (r, d) => d <= r.over && -d <= r.under;   // d = measured − bar

    // Page-pixel verdicts, ranked: a name the page could not contradict first,
    // one the bar left no evidence for next, a contradicted one last.
    const VERDICT_RANK = { consistent: 0, 'no-evidence': 1, contradicted: 2 };
    const verdictOf = (box, name) => box.verdicts?.[name]?.verdict || null;

    // ── Two bars, one name ────────────────────────────────────
    // A name can be redacted as two bars: its halves a space apart on one row
    // ("[Nadia] [Marcinkova]"), or split by a line break ("…, [Nadia]" ending
    // one row and "[Marcinkova], …" opening the next). A refiner's verdict on
    // each bar (box.refineInfo) tells the two cases apart without any new
    // geometry: `blocked` says a sibling bar bounded the neighbour search on
    // that side, and no neighbour there means nothing but the sibling — the
    // row case; the line case is the last bar of a row (no word and no bar
    // after it) followed by the first bar of the next row (nothing before it).
    // Either way the two bars are read as ONE person: a first name against
    // the first bar and a last name against the second, each within its own
    // tolerance. The gap between the bars is detector ink, not a measured
    // pen, so the halves are never summed across it. Pair readings sit beside
    // the single-name readings in the list, and picking one pins both halves.
    // Without a refiner no bar carries a verdict and no bar is ever linked.
    const LINK_ROW_GAP_EM = 0.75;          // a same-row pair is at most this far apart
    const LINK_LINE_PITCH = [0.5, 1.8];    // the next row starts this many bar heights down

    function emPx(box) {
      const pxPerPt = (typeof GEO !== 'undefined' && typeof GEO.docPxPerPt === 'function') ? GEO.docPxPerPt() : 96 / 72;
      return (box.sizePt || 12) * pxPerPt;
    }
    function sameRow(a, b) {
      const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return overlap >= Math.min(a.h, b.h) * 0.5;
    }
    // Is b on the row right after a's, starting further left than a ends?
    function nextRow(a, b) {
      const dy = b.y - a.y;
      return dy >= LINK_LINE_PITCH[0] * a.h && dy <= LINK_LINE_PITCH[1] * a.h && b.x < a.x + a.w;
    }
    // A bar with nothing readable on `side`: no word and no sibling bar.
    const openSide = (b, side) => !!b.refineInfo && !b.refineInfo[side] && !b.refineInfo.blocked?.[side];
    // A bar whose only company on `side` is a sibling bar.
    const barSide = (b, side) => !!b.refineInfo && !b.refineInfo[side] && !!b.refineInfo.blocked?.[side];

    /** The bar this one forms a name with — { other, role, kind } or null.
     *  `role` is this bar's half ('first' | 'last'); `kind` is 'row' (a space
     *  apart) or 'line' (split over a line break). */
    function linkFor(box) {
      if (!box.refineInfo) return null;
      const bars = getRedactionBoxes().filter(b => b.id !== box.id && b.page === box.page && b.refineInfo);
      const maxGap = LINK_ROW_GAP_EM * emPx(box);
      if (barSide(box, 'right')) {
        const right = bars.filter(b => sameRow(box, b) && b.x >= box.x + box.w - 2.5).sort((p, q) => p.x - q.x)[0];
        if (right && right.x - (box.x + box.w) <= maxGap && barSide(right, 'left')) return { other: right, role: 'first', kind: 'row' };
      }
      if (barSide(box, 'left')) {
        const left = bars.filter(b => sameRow(box, b) && b.x + b.w <= box.x + 2.5).sort((p, q) => q.x - p.x)[0];
        if (left && box.x - (left.x + left.w) <= maxGap && barSide(left, 'right')) return { other: left, role: 'last', kind: 'row' };
      }
      if (openSide(box, 'right')) {
        const next = bars.filter(b => nextRow(box, b) && openSide(b, 'left')).sort((p, q) => p.x - q.x)[0];
        if (next) return { other: next, role: 'first', kind: 'line' };
      }
      if (openSide(box, 'left')) {
        const prev = bars.filter(b => nextRow(b, box) && openSide(b, 'right')).sort((p, q) => q.x - p.x)[0];
        if (prev) return { other: prev, role: 'last', kind: 'line' };
      }
      return null;
    }
    window.linkFor = linkFor;

    // Every person as the (first, last) split the two bars could show — the
    // first bar's settings shape the first half (aliases, prefix, its letter
    // filter), the second bar's the last half. The same strings the First
    // only / Last only formats generate, constrained to come from ONE person.
    // A custom name splits at its last space.
    function pairPersons(A, B) {
      const sA = ensureBoxNameSettings(A), sB = ensureBoxNameSettings(B);
      const out = [];
      const add = (first, last) => {
        if (!first || !last) return;
        if (!matchesLetterFilter(first, sA) || !matchesLetterFilter(last, sB)) return;
        out.push({ first, last });
      };
      state.namesData.forEach((person, i) => {
        if (state.excludedPersons.has(i)) return;
        const firsts = sA.expandFirstAliases ? person.first : person.first.slice(0, 1);
        const lasts = sB.expandLastAliases ? person.last : person.last.slice(0, 1);
        const pre = sA.includePrefix && person.prefix ? person.prefix + ' ' : '';
        const suf = sB.includeSuffix && person.suffix ? ' ' + person.suffix : '';
        for (const f of firsts) for (const l of lasts) add(pre + f, l + suf);
      });
      for (const c of state.customCandidates) {
        const m = /^(.+)\s+(\S+)$/.exec(c.trim());
        if (m) add(m[1], m[2]);
      }
      return out;
    }

    /** The strings this bar has to have measured for its pair readings: its
     *  own half of every person. */
    function halfStrings(box, link) {
      const A = link.role === 'first' ? box : link.other;
      const B = link.role === 'first' ? link.other : box;
      return [...new Set(pairPersons(A, B).map(p => link.role === 'first' ? p.first : p.last))];
    }
    window.halfStrings = halfStrings;

    /** This bar's pair readings — persons whose first name fits the first bar
     *  and whose last name fits the second — as entries showing this bar's
     *  half. Empty until both bars have measured their halves. */
    function pairReadings(box, link = linkFor(box)) {
      if (!link) return [];
      const A = link.role === 'first' ? box : link.other;
      const B = link.role === 'first' ? link.other : box;
      if (!ensureBoxNameSettings(A).generateFull) return [];   // a pair IS a full name
      const rA = fitRange(A), rB = fitRange(B);
      const seen = new Set();
      const out = [];
      for (const p of pairPersons(A, B)) {
        const key = `pair:${p.first}|${p.last}`;
        if (seen.has(key)) continue;
        const wa = A.widths?.[p.first], wb = B.widths?.[p.last];
        if (wa === undefined || wb === undefined) continue;
        if (!fitsRange(rA, wa - A.w) || !fitsRange(rB, wb - B.w)) continue;
        const da = Math.abs(wa - A.w), db = Math.abs(wb - B.w);
        seen.add(key);
        const mine = link.role === 'first';
        out.push({
          key, kind: 'pair', full: `${p.first} ${p.last}`, first: p.first, last: p.last,
          name: mine ? p.first : p.last, partnerName: mine ? p.last : p.first,
          partnerId: link.other.id, link: link.kind, diff: Math.max(da, db),
        });
      }
      return out;
    }

    /** A reading's page verdict. A pair is judged on both bars: contradicted
     *  anywhere is contradicted, consistent on both is consistent, otherwise
     *  no evidence — null while neither half has been scored. */
    function entryVerdict(box, e) {
      if (e.kind !== 'pair') return verdictOf(box, e.name);
      const other = typeof utbState !== 'undefined' ? utbState.getBox(e.partnerId) : null;
      const a = verdictOf(box, e.name), b = other ? verdictOf(other, e.partnerName) : null;
      if (a === 'contradicted' || b === 'contradicted') return 'contradicted';
      if (a === 'consistent' && b === 'consistent') return 'consistent';
      if (!a && !b) return null;
      return 'no-evidence';
    }

    /** Candidates that fit the bar, best first: by page verdict when a
     *  hypothesis tester scored them, then by closeness. In Times many names
     *  share a width to the font unit ("SARAH KELLEN" 15416/2048 em, "JUSTIN
     *  NELSON" 15417), so this is a list, not a winner. Returns
     *  { entries, matches, tol, loose, link }: `entries` are the readings
     *  ({ key, kind: 'single' | 'pair', name, full, diff, … }), `matches` the
     *  names they show on this bar. When nothing fits the pen-exact width,
     *  the nearest single names within the user's pixel tolerance are
     *  returned with loose = true so they stay visible — as near misses,
     *  never as fits. */
    function getBoxMatchInfo(box) {
      const d = c => box.widths[c] - candidateEW(box, c);
      const entry = (c, near) => ({ key: c, kind: 'single', name: c, full: c, diff: Math.abs(d(c)), near });
      const measured = getBoxCandidates(box).filter(c => box.widths[c] !== undefined);
      const range = fitRange(box);
      const link = linkFor(box);
      const fits = [...measured.filter(c => fitsRange(range, d(c))).map(c => entry(c, false)), ...pairReadings(box, link)];
      // Names the pen lattice excludes but the pixel tolerance admits. With a
      // hypothesis tester they are scored too, and one the page could not
      // contradict joins the list — width ranks, the page decides (a bar's
      // pens can slip a lattice step, or a width can be off by a shaping
      // choice: while HarfBuzz still formed the tt ligature, RICHARD BARNETT
      // measured 0.51 px short of its bar and only this kept it in view).
      // Without a tester they are the loose fallback when nothing fits.
      const field = { over: box.tolerance ?? 3, under: Math.max(box.tolerance ?? 3, range.under) };
      const near = range.over < field.over
        ? measured.filter(c => !fitsRange(range, d(c)) && fitsRange(field, d(c))).map(c => entry(c, true))
        : [];
      // Order: page verdict; then a pair reading before a single one (it
      // explains two bars with one person); then a fit before a near miss;
      // then closeness.
      const rank = e => VERDICT_RANK[entryVerdict(box, e)] ?? 1;
      const best = (x, y) => (rank(x) - rank(y))
        || ((x.kind === 'pair' ? 0 : 1) - (y.kind === 'pair' ? 0 : 1))
        || ((x.near ? 1 : 0) - (y.near ? 1 : 0))
        || (x.diff - y.diff);
      let entries = [...fits, ...near.filter(e => entryVerdict(box, e) === 'consistent')].sort(best);
      let tol = range.over;
      let loose = false;
      if (!entries.length && near.length) {
        entries = near.sort(best);
        tol = field.over;
        loose = true;
      }
      return { entries, matches: entries.map(e => e.name), near, tol, loose, link };
    }
    window.getBoxMatchInfo = getBoxMatchInfo;

    function getBoxMatches(box) {
      return getBoxMatchInfo(box).matches;
    }
    window.getBoxMatches = getBoxMatches;

    // ── Page-pixel verdicts (optional seam) ───────────────────
    // A hypothesis tester may define window.ocrTestHypothesis(box, name) →
    // { verdict: 'consistent' | 'contradicted' | 'no-evidence', open, edge,
    //   unexplained, … } | null   (ocr_tool over tol0's engine/hypothesis.js —
    // guide/plugins/redaction-refiner/pixel-evidence-plan.md). It draws the
    // name where the refiner put the bar and lets the page bytes outside the
    // bar's body contradict it. Every name a reading shows on this bar is
    // tested here — a pair's half on its own bar, so the two halves are judged
    // independently and never summed across the gap. Verdicts live on
    // box.verdicts and are rebuilt whenever the widths are; without a
    // provider nothing runs.
    async function scoreMatches(box) {
      box.verdicts = null;
      if (typeof ocrTestHypothesis !== 'function') return;
      const { entries, near } = getBoxMatchInfo(box);
      const verdicts = {};
      for (const name of new Set([...entries, ...near].map(e => e.name))) {
        try { verdicts[name] = await ocrTestHypothesis(box, name); }
        catch (e) { console.warn('[redaction_matching] hypothesis test failed for', name, e); verdicts[name] = null; }
      }
      box.verdicts = verdicts;
    }
    window.scoreMatches = scoreMatches;

    const asEntry = e => (typeof e === 'string' ? { key: e, kind: 'single', name: e, full: e } : e);

    /** The reading a bar labels itself with: the one the user picked (by
     *  clicking a name or cycling with [ / ]) while it still fits; else the
     *  partner bar's pick when that is a pair reading — one person, both
     *  halves; else the best-ranked. */
    function shownMatch(box, entries) {
      const list = entries.map(asEntry);
      if (!list.length) return { name: null, index: -1, entry: null };
      let i = box.matchPick ? list.findIndex(e => e.key === box.matchPick) : -1;
      if (i < 0) {
        const pick = linkFor(box)?.other.matchPick;
        if (pick && pick.startsWith('pair:')) i = list.findIndex(e => e.key === pick);
      }
      if (i < 0) i = 0;
      return { name: list[i].name, index: i, entry: list[i] };
    }
    window.shownMatch = shownMatch;

    /** Pin a reading as the bar's label (by key — a name, or a pair's
     *  `pair:first|last`; must be one of its readings). A pair pins both bars. */
    function setBoxMatch(boxId, key) {
      const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;
      box.matchPick = key;
      const entry = getBoxMatchInfo(box).entries.find(e => e.key === key);
      const other = entry?.kind === 'pair' ? utbState.getBox(entry.partnerId) : null;
      if (other) other.matchPick = key;
      updateAllMatchesView(other ? null : boxId);
      if (utbState.selectedId === boxId) renderCandidates();
    }
    window.setBoxMatch = setBoxMatch;

    /** Step the shown label through the bar's readings (wraps around). */
    function cycleBoxMatch(delta, boxId = typeof utbState !== 'undefined' ? utbState.selectedId : null) {
      const box = boxId ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;
      const { entries } = getBoxMatchInfo(box);
      if (entries.length < 2) return;
      const { index } = shownMatch(box, entries);
      setBoxMatch(boxId, entries[(index + delta + entries.length) % entries.length].key);
    }
    window.cycleBoxMatch = cycleBoxMatch;

    // [ / ] cycle the selected bar's label — never while typing in a field or
    // editing a box inline (there the keys are characters).
    document.addEventListener('keydown', e => {
      if (e.key !== '[' && e.key !== ']') return;
      if (typeof utbState === 'undefined' || utbState.editingId || !utbState.selectedId) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      const box = utbState.getBox(utbState.selectedId);
      if (!box || box.type !== 'redaction') return;
      e.preventDefault();
      cycleBoxMatch(e.key === ']' ? 1 : -1);
    });

    const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Clicks inside the All Matches table: a name chip pins that reading on
    // its bar; the ‹ › buttons step through the bar's readings. Delegated once
    // so names with quotes never have to survive an inline onclick.
    document.addEventListener('DOMContentLoaded', () => {
      els.allMatchesBody?.addEventListener('click', e => {
        const chip = e.target.closest('.match-chip');
        const btn = e.target.closest('.match-cycle-btn');
        if (!chip && !btn) return;
        e.stopPropagation();
        const boxId = (chip || btn).dataset.box;
        if (typeof utbState !== 'undefined' && utbState.selectedId !== boxId) selectRedaction(boxId);
        if (chip) setBoxMatch(boxId, chip.dataset.key);
        else cycleBoxMatch(parseInt(btn.dataset.cycle, 10) || 1, boxId);
      });
      // In the candidates table a fitting name is clickable too.
      els.tableBody?.addEventListener('click', e => {
        const cell = e.target.closest('td[data-name]');
        if (!cell) return;
        const box = getSelectedRedaction();
        if (box && getBoxMatches(box).includes(cell.dataset.name)) setBoxMatch(box.id, cell.dataset.name);
      });
    });

    // ── All Matches summary view ──────────────────────────────

    const VERDICT_MARK = { consistent: '✓', contradicted: '✗', 'no-evidence': '–' };
    // The label's colour on the page (text_tool's box.labelColor): the page
    // pixels vouched for the name, left no evidence, or contradicted it. A bar
    // without a verdict keeps the type's colour.
    const VERDICT_COLOR = { consistent: '#3ddc84', 'no-evidence': '#fdd663', contradicted: '#f28b82' };
    const LINK_TITLE = 'Two bars can be one name — a space apart, or split over a line break. '
      + 'A pair reading (dashed chip) takes a first name that fits this bar and a last name that fits the other bar, from one person; '
      + 'each half is judged on its own bar. Click it to label both bars.';

    function linkText(link) {
      if (link.kind === 'row') {
        return link.role === 'first'
          ? '⟷ the bar to the right may hold the rest of this name'
          : '⟷ the bar to the left may hold the start of this name';
      }
      return link.role === 'first'
        ? '↵ this name may continue on the next line'
        : '↵ this may continue a name from the line before';
    }

    function verdictText(box, name) {
      const vd = box.verdicts?.[name];
      if (!vd) return '';
      return `${vd.verdict}${vd.open ? ` · open ${vd.open.match ?? 0}/${vd.open.ink ?? 0} match` : ''}${vd.unexplained ? ` · ${vd.unexplained} unexplained` : ''}`;
    }

    function chipTitle(box, e, v, loose) {
      const d = box.widths[e.name] - candidateEW(box, e.name);
      const width = `width ${d >= 0 ? '+' : ''}${d.toFixed(2)} px`;
      if (e.kind !== 'pair') {
        const nearNote = e.near && !loose ? ' — outside the pen lattice, kept because the page does not contradict it' : '';
        return v ? `${verdictText(box, e.name)} · ${width}${nearNote}` : `${width} — click to show this name on the bar`;
      }
      const other = typeof utbState !== 'undefined' ? utbState.getBox(e.partnerId) : null;
      const ov = other ? verdictText(other, e.partnerName) : '';
      const where = e.link === 'row'
        ? (e.name === e.first ? 'the bar to the right' : 'the bar to the left')
        : (e.name === e.first ? 'the first bar of the next line' : 'the last bar of the line before');
      return `${e.full} — one name in two bars. This bar: ${e.name} (${verdictText(box, e.name) || width}); `
        + `${where}: ${e.partnerName}${ov ? ` (${ov})` : ''} — click to label both bars`;
    }

    function updateAllMatchesView(onlyId = null) {
      const redactionBoxes = getRedactionBoxes();

      if (!redactionBoxes.length) {
        els.allMatchesCard.style.display = 'none';
        return;
      }

      els.allMatchesCard.style.display = 'block';
      let matchCount = 0;

      els.allMatchesBody.innerHTML = redactionBoxes.map(box => {
        const fontStyle = `font-family: ${box.fontFamily || 'inherit'}; font-feature-settings: "kern" ${box.kerning ? 1 : 0};`;

        const { entries, tol, loose, link } = getBoxMatchInfo(box);
        const { name: shown, index } = shownMatch(box, entries);

        if (entries.length && !loose) matchCount++;

        // The bar's label is the shown reading (picked, else best), in the
        // colour of its verdict
        if (onlyId === null || onlyId === box.id) {
          const newLabel = shown ? caseName(box, shown) : '';
          box.text = newLabel;
          box.labelText = newLabel;
          const v = index >= 0 && entries[index] ? entryVerdict(box, entries[index]) : null;
          box.labelColor = (v && VERDICT_COLOR[v]) || null;
          if (typeof renderBox === 'function') renderBox(box);
        }

        const chips = entries.map((e, i) => {
          const disp = caseName(box, e.name);
          const v = entryVerdict(box, e);
          const mark = v ? `<span class="match-verdict">${VERDICT_MARK[v]}</span>` : '';
          const cls = `match-chip${i === index ? ' active' : ''}${v ? ' verdict-' + v : ''}${e.kind === 'pair' ? ' pair' : ''}${e.near && !loose ? ' near' : ''}`;
          return `<span class="${cls}" style="${fontStyle}"
                    data-box="${box.id}" data-key="${escAttr(e.key)}" title="${escAttr(chipTitle(box, e, v, loose))}">${mark}${escAttr(disp)}</span>`;
        }).join('');
        const nConsistent = entries.filter(e => entryVerdict(box, e) === 'consistent').length;
        const counter = box.verdicts ? `${nConsistent} of ${entries.length} consistent` : `${index + 1}/${entries.length}`;
        const cycle = entries.length > 1
          ? `<span class="match-cycle" title="Several names fit this width — click one, or press [ / ] with the bar selected">
               <button class="match-cycle-btn" data-box="${box.id}" data-cycle="-1">&lsaquo;</button>${counter}<button class="match-cycle-btn" data-box="${box.id}" data-cycle="1">&rsaquo;</button>
             </span>`
          : '';
        const faceNote = box.widthFace ? ` · ${escAttr(box.widthFace)}` : '';
        const faceTitle = box.widthFace ? ` Names measured in the page's own face (the reader's ${box.widthFace} set).` : '';
        const tolNote = penExact(box)
          ? `<span class="match-tol" title="Both edges come from the reader's ¼-px pens: the width is exact to the lattice.${escAttr(faceTitle)}">±${tol.toFixed(2)} px · pens${faceNote}</span>`
          : `<span class="match-tol" title="Edges from the raster — the Tolerance field applies.${escAttr(faceTitle)}">±${tol} px${faceNote}</span>`;
        const looseNote = loose
          ? `<div class="match-loose">No name fits the pen-exact width (±${PEN_TOL_PX} px). Nearest within ±${tol} px:</div>`
          : '';
        const linkNote = link
          ? `<div class="match-link" title="${escAttr(LINK_TITLE)}">${linkText(link)}</div>`
          : '';
        const matchHtml = entries.length
          ? `${linkNote}${looseNote}${cycle}${chips}${tolNote}`
          : `${linkNote}<span class="no-match">No obvious matches</span>${tolNote}`;

        const isSelected = utbState.selectedId === box.id ? 'selected-row' : '';

        return `
          <tr id="match-row-${box.id}" class="${isSelected}" style="cursor: pointer;" onclick="selectRedaction('${box.id}')" title="Click to view on document">
            <td>${box.page}</td>
            <td class="col-right">${box.w.toFixed(2)}</td>
            <td>${matchHtml}</td>
          </tr>
        `;
      }).join('');

      els.allMatchesSummary.textContent = `${matchCount} of ${redactionBoxes.length} redactions have potential matches.`;

      const progress = redactionBoxes.length ? (matchCount / redactionBoxes.length) * 100 : 0;
      const progressBar = document.getElementById('match-progress-bar');
      if (progressBar) progressBar.style.width = `${progress}%`;
    }


    // ── Redaction creation ────────────────────────────────────

    function handleManualAddBox(pageNum, pxX, pxY) {
      const nearestLine = typeof utbFindNearestLine === 'function'
        ? utbFindNearestLine(pageNum, pxY, 2.0) : null;

      const finalY      = nearestLine ? nearestLine.y      : pxY;
      const finalH      = nearestLine ? nearestLine.h      : 20;
      const finalLineId = nearestLine ? nearestLine.lineId : null;
      const lineFont    = nearestLine?.font;
      const lineSizePt  = nearestLine?.sizePt;

      createNewRedaction(pageNum, pxX - 50, finalY, 100, finalH, finalLineId, lineFont, lineSizePt);
    }

    function createNewRedaction(pageNum, x, y, width, height, lineId = null, lineFont = null, lineSizePt = null) {
      const normFn = typeof normUtbFont === 'function' ? normUtbFont : (n => n);
      const fontFamily = (lineFont ? normFn(lineFont) : null)
                      || document.getElementById('fabric-font-family')?.value
                      || 'Times New Roman';
      // Font-size input is in POINTS — no DPI conversion.
      const sizePt     = lineSizePt
                      || parseFloat(document.getElementById('fabric-font-size')?.value)
                      || 12;

      const newBox = utbState.addBox(new UnifiedTextBox({
        type:       'redaction',
        page:       pageNum,
        text:       '',
        lineId:     lineId,
        x: x, y: y, w: width, h: height,
        fontFamily:   fontFamily,
        sizePt:       sizePt,
        kerning:      els.kern?.checked ?? true,
        uppercase:    caseMode(els.upper?.value),
        tolerance:    parseFloat(els.tol?.value) || 0,
        widths:       {},
        labelText:    '',
        manualLabel:  false,
        nameSettings: { ...state.nameSettings },  // inherit current template
      }));

      if (typeof renderBox === 'function') renderBox(newBox);

      selectRedaction(newBox.id);
      calculateWidthsForRedaction(newBox.id);
    }
