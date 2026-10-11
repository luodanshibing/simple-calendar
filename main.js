'use strict';

/* ==========================================================================
 * Simple Calendar — 轻量日历（月 / 周 / 年视图）
 * --------------------------------------------------------------------------
 * 替代已停更的 Calendar：点日期进入或生成日记，点周记按钮进入或生成周记，
 * 生成走 Templater（模板里的 <% %> 会被真正执行），可挂到侧边栏。
 *
 * 改代码前先读这五条设计红线：
 *   1. 零依赖   不用 Svelte / React，原生 DOM + 事件委托（整个视图一个监听器）。
 *   2. 不读正文 判断"这天有没有笔记"只用 vault 的路径索引，绝不 read() 文件内容 ——
 *              这正是 Calendar 变慢的原因（它为算字数把每天的文件都读一遍）。
 *   3. 一次渲染 整月/整年一次构建 DocumentFragment 后替换，不做逐格监听。
 *   4. 事件驱动 只有 库增删改名（防抖 250ms）与"跨天"（每分钟一次字符串比较）才重绘。
 *   5. 无构建   本文件既是源码也是产物，直接改它。
 *
 * 文件结构：
 *   §1 常量与默认设置
 *   §2 纯函数（无副作用；tools/test.mjs 覆盖这部分）
 *   §3 SimpleCalendarPlugin  生命周期 / 视图注册 / 建笔记 / Templater 对接
 *   §4 CalendarView          月 / 周 / 年三种视图
 *   §5 CalendarSettingTab    设置页
 *   §6 导出
 * ========================================================================== */

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, TFile, Notice, normalizePath } = obsidian;

/** moment 由 Obsidian 提供（不额外打包） */
const momentLib = obsidian.moment || (typeof window !== 'undefined' ? window.moment : null);

const VIEW_TYPE = 'simple-calendar-view';
const VIEWS = ['month', 'week', 'year'];
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const VAULT_EVENT_DEBOUNCE_MS = 250;
const DAY_ROLLOVER_CHECK_MS = 60000;
const FALLBACK_DAILY = { folder: '', format: 'YYYY-MM-DD', template: '' };

const DEFAULT_SETTINGS = {
  /* 视图 */
  defaultView: 'month', // month | week | year
  weekStartsOn: 'locale', // locale | monday | sunday
  showDots: true,
  /* 启动时若侧边栏没有日历就打开它 */
  openOnStart: true,

  /* 日记：默认跟随 Obsidian 核心「日记」设置 */
  followDailyNotes: true,
  dailyFormat: 'YYYY-MM-DD',
  dailyFolder: '',
  dailyTemplate: '',

  /* 周记：默认与日记同目录（本插件自带，不依赖 Periodic Notes） */
  weeklyFormat: 'gggg-[第]WW[周【周记】]',
  weeklyFolder: '',
  weeklyTemplate: '',

  /* 创建行为 */
  confirmBeforeCreate: false,
};

/* §2 纯函数 =============================================================== */

/** 合并设置：只接受已知键，旧 data.json 的多余字段不会影响界面 */
function normalizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  if (VIEWS.indexOf(out.defaultView) < 0) out.defaultView = DEFAULT_SETTINGS.defaultView;
  if (['locale', 'monday', 'sunday'].indexOf(out.weekStartsOn) < 0) out.weekStartsOn = DEFAULT_SETTINGS.weekStartsOn;
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** 一周从哪天开始：0=周日 1=周一。locale 时用调用方给的语言默认值 */
function weekStartIndex(weekStartsOn, localeWeekStart) {
  if (weekStartsOn === 'monday') return 1;
  if (weekStartsOn === 'sunday') return 0;
  return clampNumber(localeWeekStart, 0, 1, 1);
}

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d, weekStartsOn) {
  const x = startOfDay(d);
  const shift = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -shift);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 周号（1–53） */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 周一..周日 → 1..7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 移到本周周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** ISO 周所属年份（跨年周用它：2024-12-30 属于 2025 年第 1 周） */
function isoWeekYear(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

/** 月视图网格：固定 6 行 × 7 列 = 42 格（行数固定，翻月不跳高度） */
function buildMonthGrid(year, month, weekStartsOn) {
  const gridStart = startOfWeek(new Date(year, month, 1), weekStartsOn);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const date = addDays(gridStart, i);
    cells.push({ date: date, inMonth: date.getMonth() === month });
  }
  return cells;
}

/** 周视图：以 date 所在周为基准返回 7 天 */
function buildWeekDays(date, weekStartsOn) {
  const start = startOfWeek(date, weekStartsOn);
  const out = [];
  for (let i = 0; i < 7; i += 1) out.push(addDays(start, i));
  return out;
}

/** 年视图：12 个月，每月一份 42 格网格 */
function buildYearGrid(year, weekStartsOn) {
  const months = [];
  for (let m = 0; m < 12; m += 1) {
    months.push({ month: m, label: MONTH_CN[m], cells: buildMonthGrid(year, m, weekStartsOn) });
  }
  return months;
}

/** 拼路径：文件夹 + 文件名 + .md（空文件夹 = 库根） */
function notePath(folder, name) {
  const clean = String(folder == null ? '' : folder).replace(/^\/+|\/+$/g, '');
  const file = `${String(name).replace(/^\/+/, '')}.md`;
  return clean ? `${clean}/${file}` : file;
}

/** 核心日记配置（daily-notes.json 的形状），坏数据回退默认 */
function parseDailyNotes(raw, fallback) {
  const base = Object.assign({}, FALLBACK_DAILY, fallback || {});
  if (!raw) return base;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return base;
    }
  }
  if (!obj || typeof obj !== 'object') return base;
  return {
    folder: typeof obj.folder === 'string' ? obj.folder : base.folder,
    format: typeof obj.format === 'string' && obj.format ? obj.format : base.format,
    template: typeof obj.template === 'string' ? obj.template : base.template,
  };
}

/**
 * 核心日记模板的占位符替换（Templater 不可用时的兜底）。
 * 只处理 {{date}} / {{date:格式}} / {{time}} / {{time:格式}} / {{title}}。
 */
function substituteCoreTemplate(text, ctx, formatFn) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const fmt = typeof formatFn === 'function' ? formatFn : (d) => dayKey(d);
  const ctxDate = (ctx && ctx.date) || new Date();
  const now = (ctx && ctx.now) || new Date();
  const title = ctx && ctx.title != null ? String(ctx.title) : '';
  return text.replace(/\{\{\s*(date|time|title)\s*(?::([^}]*))?\}\}/gi, (whole, kind, pattern) => {
    const key = String(kind).toLowerCase();
    if (key === 'title') return title;
    return fmt(key === 'time' ? now : ctxDate, pattern || (key === 'time' ? 'HH:mm' : 'YYYY-MM-DD'));
  });
}

/** 表头标题 */
function viewTitle(view, cursor, weekStartsOn) {
  const y = cursor.getFullYear();
  if (view === 'year') return `${y} 年`;
  if (view === 'week') {
    const start = startOfWeek(cursor, weekStartsOn);
    const end = addDays(start, 6);
    let range;
    if (start.getFullYear() !== end.getFullYear()) {
      // 跨年周：必须带年份，否则"12月29日–1月4日"看不出是哪一年
      range = `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()} – ${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}`;
    } else if (start.getMonth() === end.getMonth()) {
      range = `${start.getMonth() + 1}月${start.getDate()}–${end.getDate()}日`;
    } else {
      range = `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
    }
    return `第 ${isoWeek(cursor)} 周 · ${range}`;
  }
  return `${y} 年 ${cursor.getMonth() + 1} 月`;
}

/** 按视图平移光标 */
function shiftCursor(view, cursor, delta) {
  const d = new Date(cursor.getTime());
  if (view === 'year') {
    d.setFullYear(d.getFullYear() + delta);
    return d;
  }
  if (view === 'week') return addDays(d, 7 * delta);
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return d;
}

/** "YYYY-MM-DD" → 本地时区零点 Date */
function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key == null ? '' : key));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  // 拒绝 2026-13-99 这类"看着合法"的越界值：new Date 会静默滚到下一年
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** 造元素（不依赖 Obsidian 的 DOM 扩展，便于在 fragment 里用） */
function mk(tag, cls, text, attr) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  if (attr) for (const k of Object.keys(attr)) el.setAttribute(k, attr[k]);
  return el;
}

/* §3 插件主体 ============================================================= */

class SimpleCalendarPlugin extends Plugin {
  constructor() {
    super(...arguments);
    /** 解析后的日记/周记配置缓存（设置变更时清掉，避免每次渲染都读配置） */
    this.configCache = null;
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    this.addCommand({ id: 'open-calendar', name: '打开日历（侧边栏）', callback: () => this.activateView() });
    this.addCommand({
      id: 'open-today-daily',
      name: '打开今天的日记',
      callback: () => this.openOrCreate('daily', new Date(), false),
    });
    this.addCommand({
      id: 'open-this-week',
      name: '打开本周的周记',
      callback: () => this.openOrCreate('weekly', new Date(), false),
    });

    this.addSettingTab(new CalendarSettingTab(this.app, this));

    // 库内增删改名 → 防抖重绘（只查存在性，代价极低）
    let timer = null;
    const scheduleRedraw = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        this.redrawViews();
      }, VAULT_EVENT_DEBOUNCE_MS);
    };
    this.registerEvent(this.app.vault.on('create', scheduleRedraw));
    this.registerEvent(this.app.vault.on('delete', scheduleRedraw));
    this.registerEvent(this.app.vault.on('rename', scheduleRedraw));
    this.register(() => {
      if (timer !== null) window.clearTimeout(timer);
    });

    // 跨天：每分钟比一次日期字符串，只有真换天才重绘
    this.lastKnownDay = dayKey(new Date());
    this.registerInterval(
      window.setInterval(() => {
        const today = dayKey(new Date());
        if (this.lastKnownDay !== today) {
          this.lastKnownDay = today;
          this.redrawViews();
        }
      }, DAY_ROLLOVER_CHECK_MS)
    );

    if (this.settings.openOnStart) {
      this.app.workspace.onLayoutReady(() => {
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) this.activateView();
      });
    }
  }

  /** 打开日历视图（默认右侧栏；用户可自行拖到别处或固定） */
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  redrawViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof CalendarView) view.render();
    }
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.configCache = null; // 设置变了，配置缓存作废
  }

  /* ---------------- 日记 / 周记 配置 ---------------- */

  /** 核心「日记」设置：优先内部 API，退回读 .obsidian/daily-notes.json */
  async readCoreDailyNotes() {
    try {
      const internal = this.app.internalPlugins;
      const core = internal && internal.getPluginById ? internal.getPluginById('daily-notes') : null;
      const options = core && core.instance && core.instance.options;
      if (options && typeof options === 'object') return parseDailyNotes(options, FALLBACK_DAILY);
    } catch (e) {
      /* 落到文件读取 */
    }
    try {
      const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`);
      return parseDailyNotes(raw, FALLBACK_DAILY);
    } catch (e) {
      return Object.assign({}, FALLBACK_DAILY);
    }
  }

  /** 当前生效配置（把"跟随核心""周记跟随日记目录"解析成具体值；带缓存） */
  async resolveConfig() {
    if (this.configCache) return this.configCache;
    const core = await this.readCoreDailyNotes();
    const s = this.settings;
    const daily = {
      folder: s.followDailyNotes ? core.folder : s.dailyFolder,
      format: s.followDailyNotes ? core.format || FALLBACK_DAILY.format : s.dailyFormat || FALLBACK_DAILY.format,
      template: s.followDailyNotes ? core.template : s.dailyTemplate,
    };
    const weekly = {
      folder: s.weeklyFolder || daily.folder,
      format: s.weeklyFormat || DEFAULT_SETTINGS.weeklyFormat,
      template: s.weeklyTemplate,
    };
    this.configCache = { daily: daily, weekly: weekly, core: core };
    return this.configCache;
  }

  /** moment 格式化（取不到 moment 时退回 YYYY-MM-DD，不崩） */
  formatDate(date, fmt) {
    if (momentLib) return momentLib(date).format(fmt);
    return dayKey(date);
  }

  pathFor(date, cfg) {
    return notePath(cfg.folder, this.formatDate(date, cfg.format));
  }

  isExisting(path) {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
  }

  /* ---------------- 打开 / 新建 ---------------- */

  /**
   * 打开或创建某天的日记 / 某周的周记。
   * @param {'daily'|'weekly'} kind
   * @param {Date} date 日记=当天；周记=那一周里的任意一天
   * @param {boolean} newTab 是否新标签页打开（Ctrl/Cmd + 点击）
   */
  async openOrCreate(kind, date, newTab) {
    const config = await this.resolveConfig();
    const cfg = kind === 'weekly' ? config.weekly : config.daily;
    const title = this.formatDate(date, cfg.format);
    const path = notePath(cfg.folder, title);

    const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (existing instanceof TFile) {
      await this.openFile(existing, newTab);
      return existing;
    }

    if (this.settings.confirmBeforeCreate && !window.confirm(`新建「${title}」？`)) return null;

    const created = await this.createNote(path, title, cfg, date);
    if (created) await this.openFile(created, newTab);
    return created;
  }

  async openFile(file, newTab) {
    const leaf = newTab ? this.app.workspace.getLeaf('tab') : this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  /** 建笔记：Templater →（不可用则）核心占位符替换 → 空文件 */
  async createNote(path, title, cfg, date) {
    const templateFile = this.resolveTemplateFile(cfg.template);

    const viaTemplater = await this.createWithTemplater(templateFile, cfg.folder, title);
    if (viaTemplater) return viaTemplater;

    try {
      let body = '';
      if (templateFile instanceof TFile) {
        const raw = await this.app.vault.read(templateFile);
        const self = this;
        body = substituteCoreTemplate(raw, { date: date, now: new Date(), title: title }, (d, f) => self.formatDate(d, f));
      }
      return await this.app.vault.create(normalizePath(path), body);
    } catch (e) {
      new Notice(`新建失败：${e && e.message ? e.message : e}`);
      return null;
    }
  }

  resolveTemplateFile(templatePath) {
    if (!templatePath) return null;
    const p = templatePath.endsWith('.md') ? templatePath : `${templatePath}.md`;
    const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
    return f instanceof TFile ? f : null;
  }

  /**
   * 交给 Templater 建笔记 —— 模板里的 <% tp.file.title %> 之类只有它会执行。
   * 已核实签名：create_new_note_from_template(template, folder?, filename?, openNewNote=true)，
   * filename 不带 .md，内部用 getAvailablePath，不会覆盖已有文件。
   */
  async createWithTemplater(templateFile, folder, title) {
    if (!(templateFile instanceof TFile)) return null;
    const tp = this.app.plugins && this.app.plugins.plugins ? this.app.plugins.plugins['templater-obsidian'] : null;
    const api = tp && tp.templater;
    if (!api || typeof api.create_new_note_from_template !== 'function') return null;
    try {
      const file = await api.create_new_note_from_template(templateFile, folder || undefined, title, false);
      return file instanceof TFile ? file : null;
    } catch (e) {
      new Notice(`Templater 生成失败，改用普通模板：${e && e.message ? e.message : e}`);
      return null;
    }
  }
}

/* §4 日历视图 ============================================================= */

class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.cursor = startOfDay(new Date());
    this.view = plugin.settings.defaultView;
    this.cfg = null;
    this.handler = null;
    this.rendering = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '日历';
  }

  getIcon() {
    return 'calendar';
  }

  async onOpen() {
    this.containerEl.addClass('simple-calendar-container');
    await this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  /** 重绘（先拿配置，再一次性画） */
  async render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.cfg = await this.plugin.resolveConfig();
      this.draw();
    } finally {
      this.rendering = false;
    }
  }

  /** 同步绘制：整块构建 + 一次替换 + 一个事件委托 */
  draw() {
    const s = this.plugin.settings;
    const ws = weekStartIndex(s.weekStartsOn, 1);
    const today = startOfDay(new Date());
    const root = this.contentEl;
    root.empty();
    root.addClass('simple-calendar');

    root.appendChild(this.buildHeader(ws, today));

    const body = root.createDiv({ cls: 'sc-body' });
    if (this.view === 'year') this.buildYear(body, ws, today);
    else if (this.view === 'week') this.buildWeek(body, ws, today);
    else this.buildMonth(body, ws, today);

    if (!this.handler) {
      this.handler = (e) => this.onClick(e, ws);
      root.addEventListener('click', this.handler);
    }
  }

  /* ---------------- 表头 ---------------- */

  buildHeader(ws, today) {
    const head = mk('div', 'sc-header');
    const row = mk('div', 'sc-nav-row');
    row.appendChild(mk('button', 'sc-nav', '‹', { 'data-nav': 'prev', title: '上一周期' }));
    const title = mk('button', 'sc-title', viewTitle(this.view, this.cursor, ws), { 'data-nav': 'today', title: '回到今天' });
    if (!sameDay(this.cursor, today) && this.view === 'month') title.classList.add('is-offset');
    row.appendChild(title);
    row.appendChild(mk('button', 'sc-nav', '›', { 'data-nav': 'next', title: '下一周期' }));
    head.appendChild(row);

    const tabs = mk('div', 'sc-tabs');
    for (const v of VIEWS) {
      const label = v === 'month' ? '月' : v === 'week' ? '周' : '年';
      tabs.appendChild(mk('button', `sc-tab${this.view === v ? ' is-active' : ''}`, label, { 'data-view': v, title: `${label}视图` }));
    }
    if (this.view === 'week') {
      const wk = mk('button', 'sc-tab sc-weekly', '周记 →', { 'data-weekly': '1', title: '打开或生成本周的周记' });
      if (this.cfg && this.plugin.isExisting(this.plugin.pathFor(this.cursor, this.cfg.weekly))) wk.classList.add('has-note');
      tabs.appendChild(wk);
    }
    head.appendChild(tabs);
    return head;
  }

  /* ---------------- 月视图 ---------------- */

  buildMonth(body, ws, today) {
    const s = this.plugin.settings;
    const grid = mk('div', 'sc-grid sc-grid-month');
    for (let i = 0; i < 7; i += 1) grid.appendChild(mk('div', 'sc-dow', WEEKDAY_CN[(ws + i) % 7]));

    const frag = document.createDocumentFragment();
    for (const cell of buildMonthGrid(this.cursor.getFullYear(), this.cursor.getMonth(), ws)) {
      const key = dayKey(cell.date);
      const el = mk(
        'div',
        `sc-cell${cell.inMonth ? '' : ' is-out'}${sameDay(cell.date, today) ? ' is-today' : ''}`,
        null,
        { 'data-date': key, title: key }
      );
      el.appendChild(mk('div', 'sc-daynum', String(cell.date.getDate())));
      if (s.showDots) el.appendChild(mk('div', 'sc-dot-slot'));
      frag.appendChild(el);
    }
    grid.appendChild(frag);
    body.appendChild(grid);
    this.markExisting(grid);
  }

  /* ---------------- 周视图 ---------------- */

  buildWeek(body, ws, today) {
    const s = this.plugin.settings;
    const wrap = mk('div', 'sc-week');
    const frag = document.createDocumentFragment();
    for (const d of buildWeekDays(this.cursor, ws)) {
      const key = dayKey(d);
      const row = mk('div', `sc-week-row${sameDay(d, today) ? ' is-today' : ''}`, null, { 'data-date': key, title: key });
      row.appendChild(mk('div', 'sc-week-dow', `周${WEEKDAY_CN[d.getDay()]}`));
      row.appendChild(mk('div', 'sc-week-date', `${d.getMonth() + 1}/${d.getDate()}`));
      if (s.showDots) row.appendChild(mk('div', 'sc-dot-slot'));
      row.appendChild(mk('div', 'sc-week-hint', '进入 / 生成'));
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
    body.appendChild(wrap);
    this.markExisting(wrap);
  }

  /* ---------------- 年视图 ---------------- */

  buildYear(body, ws, today) {
    const s = this.plugin.settings;
    const wrap = mk('div', 'sc-year');
    const frag = document.createDocumentFragment();
    for (const m of buildYearGrid(this.cursor.getFullYear(), ws)) {
      const box = mk('div', 'sc-mini');
      box.appendChild(mk('div', 'sc-mini-title', m.label, { 'data-goto-month': String(m.month), title: '切到该月' }));
      const grid = mk('div', 'sc-mini-grid');
      for (const c of m.cells) {
        const cell = mk(
          'div',
          `sc-mini-cell${c.inMonth ? '' : ' is-out'}${sameDay(c.date, today) ? ' is-today' : ''}`,
          null,
          { 'data-date': dayKey(c.date), title: dayKey(c.date) }
        );
        if (s.showDots) cell.appendChild(mk('div', 'sc-dot-slot'));
        grid.appendChild(cell);
      }
      box.appendChild(grid);
      frag.appendChild(box);
    }
    wrap.appendChild(frag);
    body.appendChild(wrap);
    this.markExisting(wrap);
  }

  /**
   * 给日期格标上"这天有笔记"。
   * 只查 vault 的路径索引，不读文件内容 —— 这是快的关键。
   */
  markExisting(scope) {
    if (!this.plugin.settings.showDots || !this.cfg) return;
    const cells = scope.querySelectorAll('[data-date]');
    for (let i = 0; i < cells.length; i += 1) {
      const el = cells[i];
      const slot = el.querySelector('.sc-dot-slot');
      if (!slot) continue;
      const date = parseDayKey(el.getAttribute('data-date'));
      if (!date) continue;
      if (this.plugin.isExisting(this.plugin.pathFor(date, this.cfg.daily))) slot.classList.add('has-note');
    }
  }

  /* ---------------- 交互（事件委托） ---------------- */

  async onClick(e, ws) {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const kind = nav.getAttribute('data-nav');
      this.cursor = kind === 'today' ? startOfDay(new Date()) : shiftCursor(this.view, this.cursor, kind === 'next' ? 1 : -1);
      await this.render();
      return;
    }

    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      const v = viewBtn.getAttribute('data-view');
      if (VIEWS.indexOf(v) >= 0 && v !== this.view) {
        this.view = v;
        await this.render();
      }
      return;
    }

    const monthBtn = e.target.closest('[data-goto-month]');
    if (monthBtn) {
      const d = new Date(this.cursor.getTime());
      d.setDate(1);
      d.setMonth(Number(monthBtn.getAttribute('data-goto-month')));
      this.cursor = d;
      this.view = 'month';
      await this.render();
      return;
    }

    if (e.target.closest('[data-weekly]')) {
      await this.plugin.openOrCreate('weekly', this.cursor, e.ctrlKey || e.metaKey);
      return;
    }

    const dayCell = e.target.closest('[data-date]');
    if (dayCell) {
      const date = parseDayKey(dayCell.getAttribute('data-date'));
      if (date) await this.plugin.openOrCreate('daily', date, e.ctrlKey || e.metaKey);
    }
  }
}

/* §5 设置页 =============================================================== */

class CalendarSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Calendar 设置' });
    const bind = (key, cast) => async (value) => {
      s[key] = cast ? cast(value) : value;
      await p.saveSettings();
      p.redrawViews();
    };

    /* ---------- 视图 ---------- */
    containerEl.createEl('h3', { text: '视图' });
    new Setting(containerEl)
      .setName('默认视图')
      .setDesc('打开日历时显示月 / 周 / 年哪种视图')
      .addDropdown((d) =>
        d
          .addOption('month', '月')
          .addOption('week', '周')
          .addOption('year', '年')
          .setValue(s.defaultView)
          .onChange(async (v) => {
            s.defaultView = v;
            await p.saveSettings();
            for (const leaf of p.app.workspace.getLeavesOfType(VIEW_TYPE)) {
              if (leaf.view instanceof CalendarView) {
                leaf.view.view = v;
                await leaf.view.render();
              }
            }
          })
      );
    new Setting(containerEl)
      .setName('每周起始')
      .setDesc('一星期从哪天开始')
      .addDropdown((d) =>
        d
          .addOption('locale', '跟随系统（中文默认周一）')
          .addOption('monday', '周一')
          .addOption('sunday', '周日')
          .setValue(s.weekStartsOn)
          .onChange(bind('weekStartsOn'))
      );
    new Setting(containerEl)
      .setName('标记有笔记的日子')
      .setDesc('只查文件是否存在，不读内容 —— 不影响速度')
      .addToggle((t) => t.setValue(!!s.showDots).onChange(bind('showDots')));
    new Setting(containerEl)
      .setName('启动时打开日历')
      .setDesc('若侧边栏里还没有日历，启动时自动打开（关掉则要手动从命令面板打开）')
      .addToggle((t) => t.setValue(!!s.openOnStart).onChange(bind('openOnStart')));

    /* ---------- 日记 ---------- */
    containerEl.createEl('h3', { text: '日记' });
    new Setting(containerEl)
      .setName('跟随 Obsidian「日记」设置')
      .setDesc('读取核心日记插件的文件夹 / 格式 / 模板；关掉则用下面三项')
      .addToggle((t) => t.setValue(!!s.followDailyNotes).onChange(bind('followDailyNotes')));
    new Setting(containerEl)
      .setName('日记格式')
      .setDesc('moment 格式，例如 YYYY-MM-DD【日记】')
      .addText((t) => t.setValue(s.dailyFormat).onChange(bind('dailyFormat', (v) => v.trim() || FALLBACK_DAILY.format)));
    new Setting(containerEl)
      .setName('日记文件夹')
      .setDesc('留空 = 库根目录')
      .addText((t) => t.setValue(s.dailyFolder).onChange(bind('dailyFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('日记模板')
      .setDesc('留空则跟随核心设置；Templater 语法（<% %>）会被正确执行')
      .addText((t) => t.setValue(s.dailyTemplate).onChange(bind('dailyTemplate', (v) => v.trim())));

    /* ---------- 周记 ---------- */
    containerEl.createEl('h3', { text: '周记' });
    new Setting(containerEl)
      .setName('周记格式')
      .setDesc('moment 格式；gggg = ISO 周所属年份，WW = 两位周号')
      .addText((t) => t.setValue(s.weeklyFormat).onChange(bind('weeklyFormat', (v) => v.trim() || DEFAULT_SETTINGS.weeklyFormat)));
    new Setting(containerEl)
      .setName('周记文件夹')
      .setDesc('留空 = 与日记同目录')
      .addText((t) => t.setValue(s.weeklyFolder).onChange(bind('weeklyFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('周记模板')
      .setDesc('例如 1 Obsidian/模板/YYYY-第WW周【周记】.md')
      .addText((t) => t.setValue(s.weeklyTemplate).onChange(bind('weeklyTemplate', (v) => v.trim())));

    /* ---------- 创建 ---------- */
    containerEl.createEl('h3', { text: '创建' });
    new Setting(containerEl)
      .setName('新建前确认')
      .setDesc('关掉则点一下就直接生成（更快）')
      .addToggle((t) => t.setValue(!!s.confirmBeforeCreate).onChange(bind('confirmBeforeCreate')));

    /* ---------- 关于 ---------- */
    containerEl.createEl('h3', { text: '关于' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '为什么快：判断"这天有没有笔记"只查库里的路径索引，从不读取文件内容；整屏一次渲染、事件委托；' +
        '只有库增删改名（防抖）与跨天（每分钟一次字符串比较）才重绘。不依赖 Periodic Notes，也不用 Svelte / React。',
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '生成时优先交给 Templater 执行模板（<% %> 语法）；Templater 不可用时退回核心 {{date}}/{{title}} 占位符替换，最后才建空文件。',
    });
  }
}

/* §6 导出 ================================================================= */

module.exports = SimpleCalendarPlugin;
module.exports.VIEW_TYPE = VIEW_TYPE;
module.exports.__test = {
  DEFAULT_SETTINGS,
  VIEWS,
  FALLBACK_DAILY,
  normalizeSettings,
  clampNumber,
  weekStartIndex,
  startOfDay,
  addDays,
  startOfWeek,
  sameDay,
  dayKey,
  isoWeek,
  isoWeekYear,
  buildMonthGrid,
  buildWeekDays,
  buildYearGrid,
  notePath,
  parseDailyNotes,
  substituteCoreTemplate,
  viewTitle,
  shiftCursor,
  parseDayKey,
};
