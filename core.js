/**
 * core.js — 香料报价单核心业务逻辑（纯逻辑，不依赖 DOM）
 * 可在浏览器(localStorage)与 Node(测试adapter)中运行。
 * 通过 CommonJS exports + window.Core 双端暴露。
 * ----------------------------------------------------------
 * 开发阶段：阶段0/1/2/3/4/5/6（备份恢复）
 */
(function (root) {
  'use strict';

  // ================= 存储键与默认值 =================
  var KEYS = {
    shop: 'xm_shop_info',
    current: 'xm_current',
    history: 'xm_history',
    noSeq: 'xm_no_seq',
    plans: 'xm_plans'
  };

  var DEFAULTS = {
    shop: { shopName: '', scope: '', address: '', phone: '', contact: '' },
    current: { customer: '', no: '', date: '', items: [] },
    history: [],
    noSeq: 1,
    plans: []
  };

  // ================= 存储适配器 =================
  // 浏览器注入 localStorage；Node 测试注入内存对象。
  var store = null;

  function setStore(adapter) {
    store = adapter;
  }

  function getStore() {
    return store;
  }

  function _get(key) {
    try {
      var raw = store && store.getItem(key);
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function _set(key, value) {
    var json = JSON.stringify(value); // 抛错则说明数据不可序列化，拦截
    store.setItem(key, json);
    return true;
  }

  // ================= 统一读写 =================
  function readAll() {
    var data = {};
    Object.keys(KEYS).forEach(function (k) {
      var v = _get(KEYS[k]);
      data[k] = v === null ? deepClone(DEFAULTS[k]) : v;
    });
    return data;
  }

  function saveAll(data) {
    Object.keys(data).forEach(function (k) {
      if (KEYS[k]) _set(KEYS[k], data[k]);
    });
    return true;
  }

  function deepClone(o) {
    if (o === null || typeof o !== 'object') return o;
    return JSON.parse(JSON.stringify(o));
  }

  // ================= 阶段1：金额计算 =================
  function toNum(v) {
    var n = Number(v);
    return isNaN(n) || !isFinite(n) ? 0 : n;
  }

  /** 行金额 = 数量 × 单价 */
  function calcRow(row) {
    return Math.round(toNum(row.qty) * toNum(row.price) * 100) / 100;
  }

  /** 空行判定：名称/数量/单价三者全空视为空行 */
  function rowIsEmpty(row) {
    return !row || (!String(row.name || '').trim() && !String(row.qty || '').trim() && !String(row.price || '').trim());
  }

  /**
   * 计算整单合计（仅统计非空行）
   * 返回 { count, totalQty, total }：行数、总数量、合计金额
   */
  function calcTotal(items) {
    var count = 0, totalQty = 0, total = 0;
    (items || []).forEach(function (row) {
      if (rowIsEmpty(row)) return;
      count++;
      totalQty = Math.round((totalQty + toNum(row.qty)) * 1000) / 1000;
      total = Math.round((total + calcRow(row)) * 100) / 100;
    });
    return { count: count, totalQty: totalQty, total: total };
  }

  /**
   * 金额转中文大写（分精度的角分处理）
   * 0 -> 零元整；负号 -> 负
   */
  function toChineseUppercase(amount) {
    var n = toNum(amount);
    if (n === 0) return '零元整';
    var sign = n < 0 ? '负' : '';
    var abs = Math.abs(n);
    var intPart = Math.floor(abs);
    var cents = Math.round((abs - intPart) * 100); // 0..99

    var DIG = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
    var UNIT4 = ['', '拾', '佰', '仟'];
    var GROUP = ['', '万', '亿', '万亿'];

    /** 组内读数：0<=n<=9999 */
    function sectionCN(n) {
      if (n === 0) return '';
      var s = String(n);
      var out = '', pendingZero = false;
      for (var i = 0; i < s.length; i++) {
        var d = Number(s[i]);
        var pos = s.length - 1 - i;
        if (d === 0) {
          if (out !== '') pendingZero = true;
        } else {
          if (pendingZero) { out += '零'; pendingZero = false; }
          out += DIG[d] + UNIT4[pos];
        }
      }
      return out;
    }

    // 拆分为每4位一组，groups[0]=最低组
    var groups = [];
    var m = intPart;
    if (m === 0) groups.push(0);
    while (m > 0) { groups.push(m % 10000); m = Math.floor(m / 10000); }

    function hasNonZeroBelow(idx) {
      for (var i = idx; i >= 0; i--) if (groups[i] > 0) return true;
      return false;
    }

    var intCN = '', pendingZero = false;
    for (var g = groups.length - 1; g >= 0; g--) {
      var val = groups[g];
      if (val === 0) {
        // 全零段：前面有更高非零组、后面还有非零组 → 需补零
        if (intCN !== '' && hasNonZeroBelow(g - 1)) pendingZero = true;
        continue;
      }
      if (pendingZero) { intCN += '零'; pendingZero = false; }
      intCN += sectionCN(val) + GROUP[g];
      // 判断与更低非零组的衔接是否需要零
      var nIdx = -1;
      for (var i = g - 1; i >= 0; i--) { if (groups[i] > 0) { nIdx = i; break; } }
      if (nIdx !== -1) {
        var sep = false;
        for (var j = g - 1; j > nIdx; j--) if (groups[j] === 0) { sep = true; break; }
        if (val % 10 === 0 || groups[nIdx] < 1000 || sep) pendingZero = true;
        else pendingZero = false;
      } else {
        pendingZero = false;
      }
    }
    if (intCN === '') intCN = '零';

    // 小数部分：角 / 分
    var jiao = Math.floor(cents / 10);
    var fen = cents % 10;
    var fracCN = '';
    if (jiao > 0) fracCN += DIG[jiao] + '角';
    else if (fen > 0) fracCN += '零';
    if (fen > 0) fracCN += DIG[fen] + '分';
    if (!fracCN) fracCN = '整';

    return sign + intCN + '元' + fracCN;
  }

  // ================= 阶段2：抬头信息与单号 =================
  /** 读取店名/主营/地址/电话/联系人（失败回退默认） */
  function loadShopInfo() {
    var v = _get(KEYS.shop);
    return (v && typeof v === 'object') ? Object.assign({}, DEFAULTS.shop, v) : deepClone(DEFAULTS.shop);
  }

  /** 保存抬头信息 */
  function saveShopInfo(shop) {
    var clean = {};
    Object.keys(DEFAULTS.shop).forEach(function (k) {
      clean[k] = shop && shop[k] !== undefined ? String(shop[k]) : '';
    });
    _set(KEYS.shop, clean);
    return clean;
  }

  /** 读取当前单据 */
  function loadCurrent() {
    var v = _get(KEYS.current);
    if (!v || typeof v !== 'object') return deepClone(DEFAULTS.current);
    return {
      customer: v.customer || '',
      no: v.no || '',
      date: v.date || todayStr(),
      items: Array.isArray(v.items) ? v.items : []
    };
  }

  /** 保存当前单据 */
  function saveCurrent(cur) {
    _set(KEYS.current, cur);
    return true;
  }

  /** 获取今天日期 YYYY-MM-DD */
  function todayStr(offsetDays) {
    var d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** 取下一单号并自增基数；seq 缺省读存储 */
  function nextNo(seq) {
    var base = (seq === undefined || seq === null) ? Number(_get(KEYS.noSeq)) || 1 : Number(seq);
    if (!(base >= 1)) base = 1;
    _set(KEYS.noSeq, base + 1);
    return String(base);
  }

  /** 读取当前单号基数 */
  function getNoSeq() {
    var v = Number(_get(KEYS.noSeq));
    return v >= 1 ? v : 1;
  }

  // ================= 阶段3：单据数据组装 =================
  /**
   * 把当前单据+抬头组装成用于渲染单据模式的完整数据
   * 返回 { shop, doc: { customer,no,date, rows:[{i,name,qty,unit,price,amount}], total, totalCN } }
   * rows 已过滤空行并补 i(从1编号)
   */
  function buildDocData() {
    var shop = loadShopInfo();
    var cur = loadCurrent();
    var rows = [];
    var items = Array.isArray(cur.items) ? cur.items : [];
    var seq = 1;
    items.forEach(function (r) {
      if (rowIsEmpty(r)) return;
      rows.push({
        i: seq++,
        name: String(r.name || '').trim(),
        qty: String(r.qty || '').trim(),
        unit: String(r.unit || '').trim(),
        price: String(r.price || '').trim(),
        amount: calcRow(r)
      });
    });
    var total = calcTotal(items).total;
    return {
      shop: shop,
      doc: {
        customer: cur.customer || '',
        no: cur.no || '',
        date: cur.date || todayStr(),
        rows: rows,
        total: total,
        totalCN: toChineseUppercase(total)
      }
    };
  }

  /** 校验是否可生成单据：至少一条完整商品 */
  function validateForDoc() {
    var cur = loadCurrent();
    var items = Array.isArray(cur.items) ? cur.items : [];
    var nonEmpty = items.filter(function (r) { return !rowIsEmpty(r); });
    if (nonEmpty.length === 0) return { ok: false, reason: 'empty' };
    return { ok: true, count: nonEmpty.length };
  }

  // ================= 阶段4：历史记录 =================
  /** 读取历史数组（损坏回退空数组） */
  function loadHistory() {
    var v = _get(KEYS.history);
    return Array.isArray(v) ? v : [];
  }

  /** 保存历史数组 */
  function saveHistory(list) {
    _set(KEYS.history, Array.isArray(list) ? list : []);
    return true;
  }

  /** 生成唯一 id */
  function genId() {
    return 'doc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /**
   * 保存当前单据为历史快照，返回新快照对象
   * 快照 = { id, customer, no, date, items(含amount), total, totalCN, ts }
   */
  function saveToHistory() {
    var cur = loadCurrent();
    var items = (Array.isArray(cur.items) ? cur.items : []).filter(function (r) { return !rowIsEmpty(r); })
      .map(function (r) {
        return { name: r.name, qty: r.qty, unit: r.unit, price: r.price, amount: calcRow(r) };
      });
    var total = calcTotal(items).total;
    var snap = {
      id: genId(),
      customer: cur.customer || '',
      no: cur.no || '',
      date: cur.date || todayStr(),
      items: items,
      total: total,
      totalCN: toChineseUppercase(total),
      ts: Date.now()
    };
    var list = loadHistory();
    list.unshift(snap); // 最新在前
    saveHistory(list);
    return snap;
  }

  /** 按 id 删除历史单 */
  function deleteHistory(id) {
    var list = loadHistory().filter(function (h) { return h.id !== id; });
    saveHistory(list);
    return list.length;
  }

  /** 清空全部历史 */
  function clearHistory() {
    saveHistory([]);
    return true;
  }

  /** 复制重开：把指定 id 的历史单载入为当前单据（可再修改），返回新 current */
  function reopenHistory(id) {
    var h = loadHistory().filter(function (x) { return x.id === id; })[0];
    if (!h) return null;
    var cur = {
      customer: h.customer,
      no: h.no,
      date: h.date,
      items: (h.items || []).map(function (r) { return { name: r.name, qty: r.qty, unit: r.unit, price: r.price }; })
    };
    saveCurrent(cur);
    return cur;
  }

  // ================= 阶段5：今日计划 =================
  /** 读取计划数组（损坏回退空） */
  function loadPlans() {
    var v = _get(KEYS.plans);
    return Array.isArray(v) ? v : [];
  }

  /** 保存计划数组 */
  function savePlans(list) {
    _set(KEYS.plans, Array.isArray(list) ? list : []);
    return true;
  }

  /** 新增待办，date 缺省今天 */
  function addPlan(text, date) {
    var item = { id: genId(), text: String(text || '').trim(), done: false, date: date || todayStr() };
    var list = loadPlans();
    list.push(item);
    savePlans(list);
    return item;
  }

  /** 切换完成状态，返回更新后条目 */
  function togglePlan(id) {
    var list = loadPlans();
    var hit = null;
    list.forEach(function (p) { if (p.id === id) { p.done = !p.done; hit = p; } });
    savePlans(list);
    return hit;
  }

  /** 删除一条计划 */
  function delPlan(id) {
    var list = loadPlans().filter(function (p) { return p.id !== id; });
    savePlans(list);
    return list.length;
  }

  // ================= 阶段6：备份与恢复 =================
  /** 导出：把全部数据序列化为 JSON 字符串 */
  function exportData() {
    var data = readAll();
    return JSON.stringify({ app: '香料报价单', version: 1, exportedAt: new Date().toISOString(), data: data });
  }

  /**
   * 导入：解析备份 JSON 并写回各键
   * 返回 { ok, reason, keys }；失败返回 { ok:false, reason }
   */
  function importData(jsonStr) {
    var parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return { ok: false, reason: 'parse' };
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'shape' };
    var d = parsed.data;
    if (!d || typeof d !== 'object') return { ok: false, reason: 'nodata' };

    var applied = [];
    // 逐个键校验+写入，非法类型拒绝该键但继续
    function validShop(v) { return v && typeof v === 'object'; }
    function validCurrent(v) { return v && typeof v === 'object' && Array.isArray(v.items); }
    function validHistory(v) { return Array.isArray(v); }
    function validNoSeq(v) { return Number(v) >= 1; }
    function validPlans(v) { return Array.isArray(v); }

    if (validShop(d.shop)) { _set(KEYS.shop, d.shop); applied.push('shop'); }
    if (validCurrent(d.current)) { _set(KEYS.current, d.current); applied.push('current'); }
    if (validHistory(d.history)) { _set(KEYS.history, d.history); applied.push('history'); }
    if (validNoSeq(d.noSeq)) { _set(KEYS.noSeq, Number(d.noSeq)); applied.push('noSeq'); }
    if (validPlans(d.plans)) { _set(KEYS.plans, d.plans); applied.push('plans'); }

    if (applied.length === 0) return { ok: false, reason: 'nothing' };
    return { ok: true, keys: applied };
  }

  /** 备份文件扩展名建议（供下载命名） */
  function backupFilename() {
    return '报价单备份_' + todayStr() + '.json';
  }

  // ================= 导出 =================
  var api = {
    KEYS: KEYS,
    DEFAULTS: DEFAULTS,
    setStore: setStore,
    getStore: getStore,
    readAll: readAll,
    saveAll: saveAll,
    deepClone: deepClone,
    _get: _get,
    _set: _set,
    // 阶段1
    toNum: toNum,
    calcRow: calcRow,
    rowIsEmpty: rowIsEmpty,
    calcTotal: calcTotal,
    toChineseUppercase: toChineseUppercase,
    // 阶段2
    loadShopInfo: loadShopInfo,
    saveShopInfo: saveShopInfo,
    loadCurrent: loadCurrent,
    saveCurrent: saveCurrent,
    todayStr: todayStr,
    nextNo: nextNo,
    getNoSeq: getNoSeq,
    // 阶段3
    buildDocData: buildDocData,
    validateForDoc: validateForDoc,
    // 阶段4
    loadHistory: loadHistory,
    saveHistory: saveHistory,
    genId: genId,
    saveToHistory: saveToHistory,
    deleteHistory: deleteHistory,
    clearHistory: clearHistory,
    reopenHistory: reopenHistory,
    // 阶段5
    loadPlans: loadPlans,
    savePlans: savePlans,
    addPlan: addPlan,
    togglePlan: togglePlan,
    delPlan: delPlan,
    // 阶段6
    exportData: exportData,
    importData: importData,
    backupFilename: backupFilename
  };

  // 双端暴露
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Core = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
//（注：内容由AI生成）
