// Simple Calendar —— 纯逻辑单测
//   运行：node tools/test.mjs
//   不依赖 Obsidian：把 require('obsidian') 换成最小桩件。
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

/* ---------- obsidian 桩件 ---------- */
class Plugin {}
class ItemView {}
class PluginSettingTab {}
class Setting {}
class TFile {}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    return { Plugin, ItemView, PluginSettingTab, Setting, TFile, Notice: class {}, normalizePath: (p) => p, moment: null };
  }
  return originalLoad.call(this, request, ...rest);
};

const SimpleCalendarPlugin = require('../main.js');
const T = SimpleCalendarPlugin.__test;

/* ---------- 极简断言 ---------- */
let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) pass += 1;
  else fails.push(`✗ ${label}`);
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`✗ ${label}\n    实际：${a}\n    期望：${b}`);
};
const D = (y, m, d) => new Date(y, m - 1, d);

/* ---------- 1. 默认设置 ---------- */
eq(Object.keys(T.DEFAULT_SETTINGS).length, 12, '默认设置共 12 项');
eq(T.DEFAULT_SETTINGS.defaultView, 'month', '默认月视图');
eq(T.DEFAULT_SETTINGS.weekStartsOn, 'locale', '默认跟随系统周起始');
eq(T.DEFAULT_SETTINGS.followDailyNotes, true, '默认跟随核心日记设置');
eq(T.DEFAULT_SETTINGS.showDots, true, '默认显示有笔记的小点');
eq(T.DEFAULT_SETTINGS.weeklyFormat, 'gggg-[第]WW[周【周记】]', '周记默认格式');
eq(T.DEFAULT_SETTINGS.confirmBeforeCreate, false, '默认不弹确认（更快）');
eq(T.VIEWS, ['month', 'week', 'year'], '三种视图');

/* ---------- 2. normalizeSettings ---------- */
eq(T.normalizeSettings(null).defaultView, 'month', 'null → 默认');
eq(T.normalizeSettings({ defaultView: 'week' }).defaultView, 'week', '合法值被接受');
eq(T.normalizeSettings({ defaultView: '乱写' }).defaultView, 'month', '非法视图回退');
eq(T.normalizeSettings({ weekStartsOn: '乱写' }).weekStartsOn, 'locale', '非法周起始回退');
eq('extra' in T.normalizeSettings({ extra: 1 }), false, '未知键被丢弃');
eq(T.normalizeSettings({ showDots: false }).showDots, false, 'false 不被默认值覆盖');

/* ---------- 3. clampNumber / weekStartIndex ---------- */
eq(T.clampNumber(5, 0, 10, 0), 5, '区间内原样');
eq(T.clampNumber(99, 0, 10, 0), 10, '超上限');
eq(T.clampNumber('abc', 0, 10, 7), 7, '非数字回退');
eq(T.weekStartIndex('monday', 0), 1, '强制周一');
eq(T.weekStartIndex('sunday', 1), 0, '强制周日');
eq(T.weekStartIndex('locale', 0), 0, 'locale 用语言默认 0');
eq(T.weekStartIndex('locale', 1), 1, 'locale 用语言默认 1');
eq(T.weekStartIndex('locale', 9), 1, 'locale 越界回退 1');

/* ---------- 4. 周起始 / 加减天 ---------- */
eq(T.dayKey(T.startOfWeek(D(2026, 10, 11), 1)), '2026-10-05', '周一为周首：10/11 → 10/05');
eq(T.dayKey(T.startOfWeek(D(2026, 10, 11), 0)), '2026-10-11', '周日为周首：10/11 当天即周首');
eq(T.dayKey(T.startOfWeek(D(2026, 10, 5), 1)), '2026-10-05', '周一自己');
eq(T.dayKey(T.addDays(D(2026, 10, 31), 1)), '2026-11-01', '跨月加天');
eq(T.dayKey(T.addDays(D(2026, 1, 1), -1)), '2025-12-31', '跨年减天');
eq(T.startOfDay(new Date(2026, 9, 11, 23, 59, 59)).getHours(), 0, 'startOfDay 归零');
eq(T.sameDay(D(2026, 10, 11), new Date(2026, 9, 11, 23, 0)), true, '同一天（忽略时刻）');
eq(T.sameDay(D(2026, 10, 11), D(2026, 10, 12)), false, '不同天');
eq(T.dayKey(D(2026, 1, 5)), '2026-01-05', 'dayKey 补零');

/* ---------- 5. ISO 周号 / 周所属年 ---------- */
eq(T.isoWeek(D(2024, 1, 1)), 1, '2024-01-01 是第 1 周');
eq(T.isoWeek(D(2023, 1, 1)), 52, '2023-01-01 属于上一年第 52 周');
eq(T.isoWeek(D(2024, 12, 30)), 1, '2024-12-30 是次年第 1 周');
eq(T.isoWeek(D(2026, 10, 11)), 41, '2026-10-11 是第 41 周');
eq(T.isoWeekYear(D(2024, 12, 30)), 2025, '跨年周归属 2025');
eq(T.isoWeekYear(D(2023, 1, 1)), 2022, '2023-01-01 归属 2022');
eq(T.isoWeekYear(D(2026, 10, 11)), 2026, '年内周归属当年');

/* ---------- 6. 月网格 ---------- */
const g = T.buildMonthGrid(2026, 9, 1); // 2026 年 10 月，周一为周首
eq(g.length, 42, '固定 42 格');
eq(T.dayKey(g[0].date), '2026-09-28', '第一格是 9/28（周一）');
eq(g[0].inMonth, false, '第一格不属于本月');
eq(g.filter((c) => c.inMonth).length, 31, '10 月 31 天');
eq(g[3].inMonth, true, '第 4 格进入本月');
eq(T.dayKey(g[41].date), '2026-11-08', '最后一格 11/8');
const feb = T.buildMonthGrid(2024, 1, 1);
eq(feb.filter((c) => c.inMonth).length, 29, '2024 年 2 月 29 天（闰年）');
const feb25 = T.buildMonthGrid(2025, 1, 1);
eq(feb25.filter((c) => c.inMonth).length, 28, '2025 年 2 月 28 天');
const gSun = T.buildMonthGrid(2026, 9, 0);
eq(T.dayKey(gSun[0].date), '2026-09-27', '周日为周首时第一格是 9/27');

/* ---------- 7. 周 / 年 ---------- */
const wk = T.buildWeekDays(D(2026, 10, 11), 1);
eq(wk.length, 7, '一周 7 天');
eq(T.dayKey(wk[0]), '2026-10-05', '周视图从周一开始');
eq(T.dayKey(wk[6]), '2026-10-11', '周视图到周日结束');
const yr = T.buildYearGrid(2026, 1);
eq(yr.length, 12, '年视图 12 个月');
eq(yr[0].label, '1月', '第一个月标签');
eq(yr[11].label, '12月', '最后一个月标签');
eq(yr.reduce((n, m) => n + m.cells.length, 0), 504, '12 × 42 = 504 格');

/* ---------- 8. 路径拼接 ---------- */
eq(T.notePath('B Listing/B3 日记清单', '2026-10-11【日记】'), 'B Listing/B3 日记清单/2026-10-11【日记】.md', '常规拼接');
eq(T.notePath('', 'x'), 'x.md', '空文件夹 = 库根');
eq(T.notePath('/', 'x'), 'x.md', '只有斜杠也当根');
eq(T.notePath('a/b/', 'x'), 'a/b/x.md', '去掉尾部斜杠');
eq(T.notePath(null, 'x'), 'x.md', 'null 文件夹不崩');

/* ---------- 9. 核心日记配置解析 ---------- */
const real = { folder: 'B Listing/B3 日记清单', template: '1 Obsidian/模板/YYYY-MM-DD【日记】.md', format: 'YYYY-MM-DD【日记】' };
const parsedReal = T.parseDailyNotes(real, null);
eq(parsedReal.folder, real.folder, '对象解析：文件夹');
eq(parsedReal.format, real.format, '对象解析：格式');
eq(parsedReal.template, real.template, '对象解析：模板');
eq(T.parseDailyNotes(JSON.stringify(real), null).folder, real.folder, 'JSON 字符串也能解析');
eq(T.parseDailyNotes('{坏 json', null).format, 'YYYY-MM-DD', '坏 JSON 回退默认');
eq(T.parseDailyNotes(null, null).folder, '', 'null 回退默认');
eq(T.parseDailyNotes({ folder: 'x' }, null).format, 'YYYY-MM-DD', '缺 format 用默认');
eq(T.parseDailyNotes({ format: '' }, null).format, 'YYYY-MM-DD', '空 format 用默认');
eq(T.parseDailyNotes({ format: 123 }, null).format, 'YYYY-MM-DD', '类型不对也用默认');

/* ---------- 10. 核心模板占位符替换 ---------- */
const fmt = (d, f) => (f === 'YYYY' ? String(d.getFullYear()) : T.dayKey(d));
eq(T.substituteCoreTemplate('日期 {{date}}', { date: D(2026, 10, 11), now: D(2026, 10, 11), title: 'T' }, fmt), '日期 2026-10-11', '{{date}}');
eq(T.substituteCoreTemplate('年 {{date:YYYY}}', { date: D(2026, 10, 11) }, fmt), '年 2026', '{{date:格式}}');
eq(T.substituteCoreTemplate('标题 {{title}}', { title: '2026-10-11【日记】' }, fmt), '标题 2026-10-11【日记】', '{{title}}');
eq(T.substituteCoreTemplate('{{ title }}', { title: 'X' }, fmt), 'X', '花括号内有空格也能认');
eq(T.substituteCoreTemplate('{{unknown}}', {}, fmt), '{{unknown}}', '未知占位符不动');
eq(T.substituteCoreTemplate('', {}, fmt), '', '空文本返回空');
eq(T.substituteCoreTemplate(null, {}, fmt), '', 'null 返回空');

/* ---------- 11. 标题 / 平移 / 解析 ---------- */
eq(T.viewTitle('year', D(2026, 10, 11), 1), '2026 年', '年标题');
eq(T.viewTitle('month', D(2026, 10, 11), 1), '2026 年 10 月', '月标题');
eq(T.viewTitle('week', D(2026, 10, 11), 1), '第 41 周 · 10月5–11日', '周标题');
eq(T.viewTitle('week', D(2026, 1, 1), 1), '第 1 周 · 2025/12/29 – 2026/1/4', '跨年周标题带年份');
eq(T.dayKey(T.shiftCursor('month', D(2026, 1, 31), 1)), '2026-02-01', '月平移不溢出（1/31 → 2 月）');
eq(T.dayKey(T.shiftCursor('month', D(2026, 1, 15), -1)), '2025-12-01', '月平移跨年');
eq(T.dayKey(T.shiftCursor('week', D(2026, 10, 11), 1)), '2026-10-18', '周平移 +7 天');
eq(T.viewTitle('year', T.shiftCursor('year', D(2026, 6, 1), 1), 1), '2027 年', '年平移');
eq(T.dayKey(T.parseDayKey('2026-10-11')), '2026-10-11', 'parseDayKey 正常');
eq(T.parseDayKey('2026-13-99'), null, 'parseDayKey 非法格式');
eq(T.parseDayKey(''), null, 'parseDayKey 空串');
eq(T.parseDayKey(null), null, 'parseDayKey null');

/* ---------- 12. 导出 ---------- */
ok(typeof SimpleCalendarPlugin === 'function', '默认导出是插件类');
eq(SimpleCalendarPlugin.VIEW_TYPE, 'simple-calendar-view', '导出 VIEW_TYPE');

/* ---------- 汇总 ---------- */
if (fails.length === 0) {
  console.log(`\n通过 ${pass} 项，失败 0 项\n全部通过 ✓\n`);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项\n`);
  for (const f of fails) console.log(f);
  process.exitCode = 1;
}
