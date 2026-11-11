/* ============================================================
   Zentect · 现状骨架原型（app.js）
   仅负责原型演示：状态切换 / 抽屉 / 参数分层 / 弹窗 / 轻交互
   ============================================================ */
(function () {
  "use strict";

  function qs(s, r) { return (r || document).querySelector(s); }
  function qsa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  /* ---------- 列表空态：项目 / 剧集 / 人物 共用 ---------- */
  function syncListEmpty() {
    [
      [".proj-grid", "#projEmpty", ".pcard"],
      [".show-grid", "#showEmpty", ".show-card"],
      [".chr-grid", "#chrEmpty", ".chr-card"]
    ].forEach(function (t) {
      var grid = qs(t[0]);
      var empty = qs(t[1]);
      if (!grid || !empty) return;
      var n = qsa(t[2], grid).length;
      empty.classList.toggle("on", n === 0);
      // 页头计数同步（仅列表页有 .pg-head .pg-count）
      var cnt = qs(".pg-head .pg-count");
      if (cnt) cnt.textContent = "(" + n + ")";
    });
  }

  /* ---------- 列表加载骨架屏：?skeleton=1 预览（剧集 / 人物） ---------- */
  function initSkeleton() {
    if (!/[?&]skeleton=1/.test(location.search)) return;
    [
      ["#chrSkeleton", ".chr-grid", "#chrEmpty"],
      ["#showSkeleton", ".show-grid", "#showEmpty"]
    ].forEach(function (t) {
      var sk = qs(t[0]);
      var grid = qs(t[1]);
      if (!sk || !grid) return;
      sk.hidden = false;
      grid.style.display = "none";
      var empty = qs(t[2]);
      if (empty) empty.classList.remove("on");
      /* 真源标题栏计数取自数据长度，加载中为 0 */
      var cnt = qs(".pg-head .pg-count");
      if (cnt) cnt.textContent = "(0)";
    });
  }

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  window.ptToast = function (text) {
    var el = qs("#ptToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ptToast";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:9px 14px;border-radius:9px;background:rgba(22,22,22,.95);border:1px solid rgba(255,255,255,.16);color:#f5f5f5;font-size:12px;z-index:999;opacity:0;transition:opacity .18s ease;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = "0"; }, 1800);
  };

  /* ---------- 通用：确认 / 选择 / 进度 / 预览 ---------- */
  function ptDialog(opts) {
    var mask = document.createElement("div");
    mask.className = "dlg-mask pt-mask on";
    var foot = "";
    if (opts.foot !== false) {
      foot = '<div class="dlg-ft"><div class="spacer"></div>' +
        (opts.cancelText === false ? "" : '<button class="btn btn-ghost" data-pt-cancel>' + (opts.cancelText || "取消") + "</button>") +
        (opts.okText ? '<button class="btn ' + (opts.danger ? "btn-danger" : "btn-primary") + '" data-pt-ok>' + opts.okText + "</button>" : "") +
        "</div>";
    }
    mask.innerHTML =
      '<div class="dlg ' + (opts.size || "sm") + '" role="dialog">' +
        '<div class="dlg-hd"><div class="ttl"><h2>' + (opts.title || "提示") + "</h2></div>" +
        '<button class="dlg-x" data-pt-cancel title="关闭"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
        '<div class="dlg-bd">' + (opts.body || "") + "</div>" + foot +
      "</div>";
    document.body.appendChild(mask);

    function close() {
      mask.classList.remove("on");
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 160);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    qsa("[data-pt-cancel]", mask).forEach(function (b) { b.addEventListener("click", close); });
    mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
    var ok = qs("[data-pt-ok]", mask);
    if (ok) {
      ok.addEventListener("click", function () {
        if (opts.onOk) opts.onOk(close);
        else close();
      });
    }
    return { el: mask, close: close };
  }

  function ptConfirm(opts) {
    return ptDialog({
      title: opts.title || "确认操作",
      body: '<div class="dlg-desc" style="white-space:pre-line;">' + (opts.message || "") + "</div>",
      okText: opts.okText || "确定",
      danger: !!opts.danger,
      onOk: function (close) {
        close();
        if (opts.toast) window.ptToast(opts.toast);
        if (opts.onOk) opts.onOk();
      }
    });
  }

  function ptChoose(opts) {
    var items = opts.items || [];
    var body = '<div class="pt-list">' + items.map(function (it, i) {
      return '<button class="pt-item' + (i === 0 ? " on" : "") + '" data-pt-val="' + (it.value || it.label) + '">' +
        "<b>" + it.label + "</b>" + (it.meta ? "<span>" + it.meta + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    var d = ptDialog({
      title: opts.title || "请选择",
      body: body,
      okText: opts.okText || "选择",
      size: opts.size || "sm",
      onOk: function (close) {
        var on = qs(".pt-item.on", d.el);
        var val = on ? on.getAttribute("data-pt-val") : "";
        var label = on ? qs("b", on).textContent : "";
        close();
        if (opts.onPick) opts.onPick(val, label);
      }
    });
    qsa(".pt-item", d.el).forEach(function (b) {
      b.addEventListener("click", function () {
        qsa(".pt-item", d.el).forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
      });
    });
    return d;
  }

  function ptProgress(opts) {
    var d = ptDialog({
      title: opts.title || "处理中",
      body: '<div class="pt-prog"><div class="pt-prog-bar"><i data-pt-fill style="width:0%;"></i></div>' +
        '<div class="pt-prog-txt" data-pt-txt>' + (opts.label || "正在处理…") + "</div></div>",
      foot: false
    });
    var fill = qs("[data-pt-fill]", d.el);
    var txt = qs("[data-pt-txt]", d.el);
    var p = 0;
    var timer = setInterval(function () {
      p = Math.min(100, p + 9 + Math.random() * 11);
      fill.style.width = p + "%";
      if (p >= 100) {
        clearInterval(timer);
        txt.textContent = opts.doneLabel || "完成";
        setTimeout(function () {
          d.close();
          if (opts.toast) window.ptToast(opts.toast);
          if (opts.onDone) opts.onDone();
        }, 520);
      }
    }, 140);
    return d;
  }

  function ptPreview(opts) {
    return ptDialog({
      title: opts.title || "预览",
      body: '<div class="pt-stage"><span class="pt-stage-ico">▷</span><span class="pt-stage-tc">' + (opts.tc || "00:00.000") + "</span></div>" +
        '<div class="pt-kv"><span>时间码</span><b>' + (opts.tc || "00:00.000") + "</b></div>" +
        '<div class="pt-kv"><span>时长</span><b>' + (opts.duration || "—") + "</b></div>" +
        '<div class="pt-kv"><span>内容</span><b>' + (opts.desc || "镜头片段") + "</b></div>" +
        '<div class="pt-note">预览会同步播放画面与配音（原型演示）</div>',
      okText: "关闭",
      cancelText: false,
      onOk: function (close) { close(); }
    });
  }

  function ptModuleName(mod) {
    var el = qs(".set-mod-name", mod);
    if (!el) return "模型";
    var clone = el.cloneNode(true);
    qsa("span", clone).forEach(function (s) { s.parentNode.removeChild(s); });
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  function ptRowLabel(row) {
    var no = qs(".st-mono", row) || qs(".st-no", row);
    return no ? no.textContent.trim() : "本段";
  }

  /* ---------- 设置页：模型配置（添加 / 编辑 / 删除） ----------
     依据 src/modules/settings/ai-config/backend/AiConfigService.ts 的 PROVIDER_CONFIGS
     与 AITab.tsx 的两步弹窗：选择提供商 → 表单（别名 / 接口地址 / API Key / 模型） */
  var MODEL_PROVIDERS = {
    doubao: {
      name: "火山方舟", full: "火山方舟 (ByteDance)", icon: "方",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      models: ["doubao-seed-1-6-251015", "doubao-seed-1-6-250615", "doubao-seed-1-6-vision-250815", "doubao-seed-1-6-flash-250828", "doubao-seed-1-6-thinking-250715"],
      keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey"
    },
    deepseek: {
      name: "DeepSeek", full: "DeepSeek", icon: "D",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      keyUrl: "https://platform.deepseek.com/api_keys"
    },
    qwen: {
      name: "通义千问", full: "通义千问 (Alibaba Cloud)", icon: "千",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3-max", "qwen-long"],
      keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key"
    },
    hunyuan: {
      name: "腾讯混元", full: "腾讯混元 (Tencent Hunyuan)", icon: "混",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      models: ["hunyuan-turbos-latest", "hunyuan-a13b", "hunyuan-vision", "hunyuan-t1-vision-20250916", "hunyuan-translation"],
      keyUrl: "https://console.cloud.tencent.com/hunyuan/start"
    },
    custom: {
      name: "自定义", full: "自定义 (OpenAI 兼容)", icon: "∞",
      baseUrl: "", models: [], keyUrl: ""
    }
  };

  function mdlEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function ptModelDialog(opts) {
    opts = opts || {};
    var editing = opts.mode === "edit";
    var picked = null;
    var selectedCount = editing ? (opts.selected || 0) : 0;

    var body =
      '<div data-mdl-panel="provider">' +
        '<div class="mdl-lead">选择模型提供商</div>' +
        '<div class="mdl-prov-grid">' +
          Object.keys(MODEL_PROVIDERS).map(function (k) {
            var p = MODEL_PROVIDERS[k];
            return '<button class="mdl-prov" data-mdl-prov="' + k + '">' +
              '<span class="mdl-prov-ico">' + p.icon + '</span>' +
              '<span class="mdl-prov-tx"><b>' + p.name + '</b><em>' + p.full + '</em></span>' +
            '</button>';
          }).join("") +
        '</div>' +
        '<div class="mdl-note">自定义供应商需提供 OpenAI 兼容的接口地址。</div>' +
      '</div>' +
      '<div data-mdl-panel="form" style="display:none;">' +
        '<div class="mdl-form-h">' +
          '<span class="mdl-prov-ico" data-mdl-ico></span>' +
          '<div class="mdl-prov-tx"><b data-mdl-pname></b><em data-mdl-pfull></em></div>' +
          '<button class="mdl-back" data-mdl-back>更换提供商</button>' +
        '</div>' +
        '<div class="mdl-label">别名<span>可选</span></div>' +
        '<input class="mdl-input" data-mdl-alias placeholder="例如：方舟主力">' +
        '<div class="mdl-label">接口地址<span class="req">*</span></div>' +
        '<input class="mdl-input" data-mdl-url placeholder="https://...">' +
        '<div class="mdl-label">API Key<span class="req">*</span></div>' +
        '<div class="mdl-key">' +
          '<input class="mdl-input" data-mdl-key type="password" placeholder="输入 API Key">' +
          '<button class="mdl-eye" data-mdl-eye>显示</button>' +
        '</div>' +
        '<div class="mdl-hint" data-mdl-keyhint></div>' +
        '<div class="mdl-label">模型<span class="req">*</span><button class="mdl-fetch" data-mdl-fetch>拉取模型</button></div>' +
        '<div data-mdl-models></div>' +
        '<div class="mdl-err" data-mdl-err></div>' +
        '<div class="mdl-foot">' +
          '<button class="btn btn-ghost" data-mdl-test>测试连接</button>' +
          '<span class="mdl-test-st" data-mdl-testst></span>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-primary" data-mdl-done>' + (editing ? "保存" : "完成") + '</button>' +
        '</div>' +
        '<div class="mdl-note">改动离开字段后自动保存</div>' +
      '</div>';

    var d = ptDialog({ title: editing ? "编辑模型" : "添加模型", size: "md", body: body, foot: false });
    var el = d.el;
    var panelProv = qs('[data-mdl-panel="provider"]', el);
    var panelForm = qs('[data-mdl-panel="form"]', el);
    var errEl = qs("[data-mdl-err]", el);
    var modelWrap = qs("[data-mdl-models]", el);
    var fetchBtn = qs("[data-mdl-fetch]", el);
    var testSt = qs("[data-mdl-testst]", el);

    function showErr(msg) { errEl.textContent = msg; errEl.classList.add("on"); }
    function clearErr() { errEl.textContent = ""; errEl.classList.remove("on"); }

    function renderModels(p) {
      if (picked === "custom") {
        fetchBtn.style.display = "none";
        modelWrap.innerHTML =
          '<textarea class="mdl-input mdl-ta" data-mdl-custom placeholder="每行一个模型 ID，例如：my-model-v1"></textarea>' +
          '<div class="mdl-hint">自定义供应商直接填写模型 ID，每行一个</div>';
        return;
      }
      fetchBtn.style.display = "";
      var checked = selectedCount || p.models.length;
      modelWrap.innerHTML = '<div class="mdl-chips">' + p.models.map(function (m, i) {
        return '<button class="mdl-chip' + (i < checked ? " on" : "") + '" data-mdl-model="' + m + '">' +
          '<span class="ck">✓</span>' + m + '</button>';
      }).join("") + '</div>';
    }

    function fillForm(k, preset) {
      picked = k;
      var p = MODEL_PROVIDERS[k];
      qs("[data-mdl-ico]", el).textContent = p.icon;
      qs("[data-mdl-pname]", el).textContent = p.name;
      qs("[data-mdl-pfull]", el).textContent = p.full;
      qs("[data-mdl-alias]", el).value = (preset && preset.alias) || "";
      var url = qs("[data-mdl-url]", el);
      url.value = (preset && preset.url) || p.baseUrl;
      url.readOnly = k !== "custom";
      url.classList.toggle("mdl-ro", k !== "custom");
      var keyIn = qs("[data-mdl-key]", el);
      keyIn.value = "";
      keyIn.placeholder = editing ? "已保存，留空表示不修改" : "输入 API Key";
      var hint = qs("[data-mdl-keyhint]", el);
      hint.innerHTML = p.keyUrl
        ? '前往控制台获取 API Key：<a href="' + p.keyUrl + '" target="_blank" rel="noreferrer">' + p.keyUrl.replace(/^https?:\/\//, "").split("/")[0] + ' ↗</a>'
        : "OpenAI 兼容接口需同时提供接口地址与模型 ID";
      renderModels(p);
      clearErr();
      testSt.className = "mdl-test-st";
      testSt.textContent = "";
      panelProv.style.display = "none";
      panelForm.style.display = "";
    }

    function showProviders() {
      picked = null;
      panelForm.style.display = "none";
      panelProv.style.display = "";
    }

    qsa("[data-mdl-prov]", el).forEach(function (b) {
      b.addEventListener("click", function () { fillForm(b.getAttribute("data-mdl-prov"), null); });
    });
    qs("[data-mdl-back]", el).addEventListener("click", showProviders);

    qs("[data-mdl-eye]", el).addEventListener("click", function () {
      var i = qs("[data-mdl-key]", el);
      var show = i.type === "password";
      i.type = show ? "text" : "password";
      this.textContent = show ? "隐藏" : "显示";
    });

    modelWrap.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-mdl-model]");
      if (chip) chip.classList.toggle("on");
    });

    fetchBtn.addEventListener("click", function () {
      if (!picked || picked === "custom") return;
      var p = MODEL_PROVIDERS[picked];
      fetchBtn.disabled = true;
      fetchBtn.textContent = "拉取中…";
      setTimeout(function () {
        qsa("[data-mdl-model]", el).forEach(function (c) { c.classList.add("on"); });
        fetchBtn.disabled = false;
        fetchBtn.textContent = "拉取模型";
        window.ptToast("已拉取 " + p.models.length + " 个模型，已全选");
      }, 700);
    });

    qs("[data-mdl-test]", el).addEventListener("click", function () {
      var k = qs("[data-mdl-key]", el).value.trim();
      if (!editing && k.length < 10) { showErr("请先填写有效的 API Key（至少 10 位）"); return; }
      if (editing && k && k.length < 10) { showErr("API Key 至少 10 位"); return; }
      clearErr();
      testSt.className = "mdl-test-st";
      testSt.textContent = "测试中…";
      setTimeout(function () {
        testSt.className = "mdl-test-st ok";
        testSt.textContent = "连接成功 · 延迟 128ms";
      }, 900);
    });

    qs("[data-mdl-done]", el).addEventListener("click", function () {
      if (!picked) return;
      var p = MODEL_PROVIDERS[picked];
      var url = qs("[data-mdl-url]", el).value.trim();
      var apiKey = qs("[data-mdl-key]", el).value.trim();
      var alias = qs("[data-mdl-alias]", el).value.trim();
      var list = [];
      if (picked === "custom") {
        var ta = qs("[data-mdl-custom]", el);
        list = (ta ? ta.value : "").split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      } else {
        qsa("[data-mdl-model].on", el).forEach(function (c) { list.push(c.getAttribute("data-mdl-model")); });
      }
      if (!/^https?:\/\//i.test(url)) return showErr("请填写有效的接口地址（以 http:// 或 https:// 开头）");
      if (!editing && apiKey.length < 10) return showErr("请填写有效的 API Key（至少 10 位）");
      if (editing && apiKey && apiKey.length < 10) return showErr("API Key 至少 10 位");
      if (!list.length) return showErr(picked === "custom" ? "请至少填写一个模型 ID" : "请至少选择一个模型");
      var data = { provider: picked, name: alias || p.name, icon: p.icon, url: url, models: list.length, modelList: list };
      d.close();
      if (opts.onSave) opts.onSave(data);
    });

    if (editing) fillForm(opts.provider || "doubao", { alias: opts.alias, url: opts.url });
    else if (opts.provider) fillForm(opts.provider, null);
  }

  function initModelConfig() {
    if (!qs("[data-model-add]")) return;

    var EDIT_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    var DEL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';

    function cardName(card) {
      var n = qs(".set-prov-name", card);
      return n && n.childNodes[0] ? n.childNodes[0].textContent.trim() : "该供应商";
    }
    function cardProvider(card) {
      var k = card.getAttribute("data-prov");
      return k && MODEL_PROVIDERS[k] ? k : "custom";
    }
    function selectedOf(card) {
      var meta = qs(".set-prov-meta", card);
      var m = meta ? /已选\s*(\d+)/.exec(meta.textContent) : null;
      return m ? parseInt(m[1], 10) : 0;
    }
    function buildCard(data) {
      var el = document.createElement("div");
      el.className = "set-prov";
      el.setAttribute("data-prov", data.provider);
      el.innerHTML =
        '<div class="set-prov-ico ' + data.provider + '">' + mdlEsc(data.icon) + '</div>' +
        '<div class="set-prov-main">' +
          '<div class="set-prov-name">' + mdlEsc(data.name) + ' <em>(' + mdlEsc(MODEL_PROVIDERS[data.provider].name) + ')</em></div>' +
          '<div class="set-prov-meta">已选 ' + data.models + ' / 共 ' + data.models + '</div>' +
        '</div>' +
        '<div class="set-prov-act">' +
          '<button class="set-switch on" data-set-switch title="启用"></button>' +
          '<button class="set-icobtn" data-model-edit title="编辑">' + EDIT_SVG + '</button>' +
          '<button class="set-icobtn danger" data-model-del title="删除">' + DEL_SVG + '</button>' +
        '</div>';
      var sw = qs("[data-set-switch]", el);
      if (sw) sw.addEventListener("click", function () { sw.classList.toggle("on"); });
      return el;
    }

    // 空态：对齐真源 AITab 的 apiProfiles.length === 0 分支
    function syncProvEmpty() {
      var list = qs(".set-providers");
      var empty = qs("#provEmpty");
      if (!list || !empty) return;
      empty.hidden = !!qs(".set-prov", list);
    }

    // 删除供应商后，映射节点回退为「未绑定」（对齐真源：绑定失效即退回未绑定）
    function unbindProvider(alias) {
      qsa(".set-select").forEach(function (sel) {
        var hit = false;
        qsa("option", sel).forEach(function (opt) {
          if (opt.textContent.indexOf("(" + alias + ")") !== -1) {
            if (opt.selected) hit = true;
            opt.parentNode.removeChild(opt);
          }
        });
        if (!hit) return;
        var un = qsa("option", sel).filter(function (o) { return o.textContent.trim() === "未绑定"; })[0];
        if (un) un.selected = true;
        sel.classList.add("empty");
      });
    }

    // 新增 / 编辑供应商后回填映射下拉（对齐真源 AITab：enabledProfiles 平铺 modelOptions，只列已勾选模型）
    // 选项文本固定为 `模型 (别名)`；改名时按模型名续绑，模型被取消勾选则退回「未绑定」
    function syncProviderOptions(prevName, data) {
      var name = data.name;
      var models = data.modelList || [];
      qsa(".set-node .set-select").forEach(function (sel) {
        var cur = sel.options[sel.selectedIndex];
        var m = cur ? /^(.+?)\s*\(([^)]*)\)$/.exec(cur.text.trim()) : null;
        var boundModel = m ? m[1] : "";
        var wasOurs = !!m && m[2] === (prevName || name);

        // 编辑：移除本供应商的旧选项（改名或取消勾选的模型）
        if (prevName) {
          qsa("option", sel).forEach(function (opt) {
            var mm = /^(.+?)\s*\(([^)]*)\)$/.exec(opt.textContent.trim());
            if (!mm || mm[2] !== prevName) return;
            if (mm[2] !== name || models.indexOf(mm[1]) < 0) opt.parentNode.removeChild(opt);
          });
        }

        // 回填缺失的「模型 (别名)」，插在「未绑定」之前
        var un = qsa("option", sel).filter(function (o) { return o.textContent.trim() === "未绑定"; })[0];
        var texts = qsa("option", sel).map(function (o) { return o.textContent.trim(); });
        models.forEach(function (model) {
          var t = model + " (" + name + ")";
          if (texts.indexOf(t) >= 0) return;
          var opt = document.createElement("option");
          opt.textContent = t;
          if (un) sel.insertBefore(opt, un); else sel.appendChild(opt);
        });

        if (!wasOurs) return;
        var next = models.indexOf(boundModel) >= 0 ? boundModel + " (" + name + ")" : "未绑定";
        if (sel.value === next) return;
        sel.value = next;
        sel.classList.toggle("empty", next === "未绑定");
      });
    }

    qs("[data-model-add]").addEventListener("click", function () {
      ptModelDialog({
        mode: "add",
        onSave: function (data) {
          var list = qs(".set-providers");
          if (list) list.appendChild(buildCard(data));
          syncProvEmpty();
          syncProviderOptions(null, data);
          window.ptToast("已添加模型 · " + data.name);
        }
      });
    });

    document.addEventListener("click", function (e) {
      var del = e.target.closest("[data-model-del]");
      if (del) {
        var card = del.closest(".set-prov");
        var name = cardName(card);
        ptConfirm({
          title: "确认删除",
          message: "确定删除「" + name + "」的配置？\n删除后不可恢复，正在使用此供应商的管线节点将退回到未绑定状态。",
          okText: "确认删除",
          danger: true,
          toast: "已删除「" + name + "」的配置",
          onOk: function () { if (card) card.remove(); syncProvEmpty(); unbindProvider(name); }
        });
        return;
      }
      var edit = e.target.closest("[data-model-edit]");
      if (edit) {
        var card2 = edit.closest(".set-prov");
        var k = cardProvider(card2);
        ptModelDialog({
          mode: "edit",
          provider: k,
          alias: cardName(card2),
          url: MODEL_PROVIDERS[k].baseUrl,
          selected: selectedOf(card2),
          onSave: function (data) {
            var oldName = cardName(card2);
            var nm = qs(".set-prov-name", card2);
            var meta = qs(".set-prov-meta", card2);
            if (nm) nm.innerHTML = mdlEsc(data.name) + ' <em>(' + mdlEsc(MODEL_PROVIDERS[data.provider].name) + ')</em>';
            if (meta) meta.textContent = "已选 " + data.models + " / 共 " + data.models;
            syncProviderOptions(oldName, data);
            window.ptToast("已保存配置 · " + data.name);
          }
        });
      }
    });
  }

  /* ---------- 设置页：健康检查详情（7 项） ----------
     依据 src/modules/settings/frontend/components/HealthPage.tsx 的详情 Modal：
     字段列表（label / value）+ 可选清单（名称 / 是否可用 / 使用方），无底部按钮，点遮罩或 ✕ 关闭 */
  var HEALTH_DETAILS = {
    database: {
      label: "数据库",
      fields: [
        { label: "类型", value: "SQLite" },
        { label: "版本", value: "3.51.0" },
        { label: "文件路径", value: "C:\\Users\\cchenging\\AppData\\Roaming\\Zentect\\zentect.db" },
        { label: "文件大小", value: "128.6 MB" },
        { label: "状态", value: "已连接" }
      ]
    },
    ffmpeg: {
      label: "FFmpeg",
      fields: [
        { label: "版本", value: "7.1.1" },
        { label: "路径", value: "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe" },
        { label: "状态", value: "可用" }
      ]
    },
    python: {
      label: "Python 运行环境",
      fields: [
        { label: "版本", value: "3.11.9" },
        { label: "可执行路径", value: "C:\\Users\\cchenging\\AppData\\Local\\Zentect\\runtime\\python.exe" },
        { label: "状态", value: "已就绪" }
      ]
    },
    runtime: {
      label: "AI 运行时依赖",
      fields: [{ label: "缺失包总数", value: "2 个" }],
      listTitle: "运行时包",
      list: [
        ["PyTorch 2.5.1+cu121", true, "Demucs / Paraformer / CLIP"],
        ["Torchaudio 2.5.1", true, "Demucs"],
        ["Demucs 4.0.1", true, "音频分离"],
        ["FunASR 1.2.6", true, "台词识别"],
        ["Transformers 4.46.3", true, "CLIP"],
        ["Tokenizers 0.20.3", true, "CLIP"],
        ["Kokoro 0.9.4", true, "Kokoro TTS"],
        ["Misaki 0.8.4", true, "Kokoro TTS"],
        ["SoundFile 0.12.1", true, "Kokoro TTS / 音频分析"],
        ["OrderedSet 4.1.0", true, "Kokoro TTS"],
        ["Pypinyin 0.53.0", true, "Kokoro TTS"],
        ["Cn2An 0.5.23", true, "Kokoro TTS"],
        ["NumPy 1.26.4", true, "基础数值"],
        ["SciPy 1.14.1", true, "音频分析"],
        ["Librosa 0.10.2", true, "音频分析"],
        ["Pillow 11.0.0", true, "关键帧"],
        ["OpenCV 4.10.0", true, "关键帧"],
        ["ONNX Runtime 1.20.1", true, "视觉推理"],
        ["ModelScope 1.22.0", true, "模型下载"],
        ["FastAPI 0.115.5", true, "AI 运行时"],
        ["Uvicorn 0.32.1", true, "AI 运行时"],
        ["WebSockets 13.1", true, "AI 运行时"],
        ["Psutil 6.1.0", true, "系统监控"],
        ["Requests 2.32.3", true, "模型下载"],
        ["InsightFace", false, "人物识别"],
        ["Face Alignment", false, "人物识别"]
      ]
    },
    llm: {
      label: "大模型通道",
      fields: [{ label: "当前默认通道", value: "火山方舟" }],
      listTitle: "LLM 通道",
      list: [
        ["火山方舟（默认）", true],
        ["DeepSeek", true],
        ["通义千问", true],
        ["腾讯混元", false]
      ]
    },
    tts: {
      label: "TTS 语音合成",
      fields: [{ label: "当前默认引擎", value: "火山引擎 TTS" }],
      listTitle: "TTS 引擎",
      list: [
        ["火山引擎 TTS（默认）", true],
        ["MiniMax TTS", false],
        ["微软 Edge TTS（内置）", true]
      ]
    },
    cloud_api: {
      label: "云端 API",
      fields: [
        { label: "LLM 通道", value: "3/4 已配置" },
        { label: "TTS 引擎", value: "2/3 可用" }
      ]
    }
  };

  function healthDetailBody(def) {
    var h = "";
    if (def.fields && def.fields.length) {
      h += '<div class="hd-fields">' + def.fields.map(function (f) {
        return '<div class="hd-row"><span>' + mdlEsc(f.label) + "</span><b>" + mdlEsc(f.value) + "</b></div>";
      }).join("") + "</div>";
    }
    if (def.list && def.list.length) {
      h += '<div class="hd-list">' +
        (def.listTitle ? '<div class="hd-list-t">' + mdlEsc(def.listTitle) + "</div>" : "") +
        def.list.map(function (it) {
          return '<div class="hd-item"><i class="' + (it[1] ? "ok" : "bad") + '">' + (it[1] ? "✓" : "✕") + "</i>" +
            "<span>" + mdlEsc(it[0]) + "</span>" +
            (it[2] ? "<em>" + mdlEsc(it[2]) + "</em>" : "") + "</div>";
        }).join("") + "</div>";
    }
    return h;
  }

  function initHealthDetail() {
    if (!qs("[data-health-detail]")) return;
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-health-detail]");
      if (!btn) return;
      var def = HEALTH_DETAILS[btn.getAttribute("data-health-detail")];
      if (!def) return;
      ptDialog({ title: def.label, size: "md", body: healthDetailBody(def), foot: false });
    });
  }

  /* ---------- 任务中心：胶囊 + 抽屉 ---------- */
  var TASK_PHASES = {
    idle: {
      cls: "idle", label: "待启动", action: "开始", title: "待启动 · 素材已就绪",
      elapsed: "—", node: "尚未开始", err: false,
      subs: ["idle", "idle", "idle", "idle"],
      steps: ["idle", "idle", "idle", "idle", "idle"],
      revs: ["—", "—", "—", "—", "—"]
    },
    paused: {
      cls: "idle", label: "已中止", action: "继续", title: "已中止 · 可从当前步骤继续",
      elapsed: "02:11", node: "已中止", err: false,
      subs: ["done", "done", "done", "idle"],
      steps: ["done", "done", "done", "idle", "idle"],
      revs: ["rev 3", "rev 2", "rev 5", "—", "—"]
    },
    running: {
      cls: "run", label: "运行中", action: "详情", title: "素材助理 · 关键帧提取 2/4",
      elapsed: "02:14", node: "关键帧提取 2/4", err: false,
      subs: ["done", "done", "run", "idle"],
      steps: ["run", "done", "done", "idle", "idle"],
      revs: ["rev 3", "rev 2", "rev 5", "—", "—"]
    },
    failed: {
      cls: "fail", label: "失败", action: "修复", title: "配音合成失败 · 第 3 句",
      elapsed: "03:07", node: "配音合成 · 第 3 句", err: true,
      subs: ["done", "done", "done", "done"],
      steps: ["done", "done", "done", "fail", "idle"],
      revs: ["rev 3", "rev 2", "rev 5", "—", "—"]
    },
    "needs-rerun": {
      cls: "stale", label: "需重跑", action: "查看", title: "产物已过期 · 2 步需重跑",
      elapsed: "—", node: "产物已过期", err: false,
      subs: ["done", "done", "done", "done"],
      steps: ["done", "stale", "done", "stale", "done"],
      revs: ["rev 3", "rev 2 · 过期", "rev 5", "rev 4 · 过期", "rev 2"]
    },
    completed: {
      cls: "done", label: "已完成", action: "详情", title: "已完成 · 可导出",
      elapsed: "05:32", node: "全部步骤已产出", err: false,
      subs: ["done", "done", "done", "done"],
      steps: ["done", "done", "done", "done", "done"],
      revs: ["rev 3", "rev 2", "rev 5", "rev 4", "rev 2"]
    }
  };
  var TASK_STATUS = {
    idle: ["待开始", "none"],
    run: ["进行中", "st"],
    done: ["已完成", "ok"],
    fail: ["失败", "bad"],
    stale: ["已过期", "warn"]
  };
  var TASK_STEP_NAME = { 1: "素材助理", 2: "看片员", 3: "首席编剧", 4: "专业播音", 5: "剪辑大师" };
  var TASK_NODE_NAME = { 1: "关键帧提取 2/4", 2: "画面描述", 3: "脚本创作", 4: "配音合成", 5: "画面匹配" };
  var TASK_SUB_DONE = ["18.4s", "12.1s", "完成", "完成"];

  function initTaskCenter() {
    var drawer = qs("#taskDrawer");
    if (!drawer) return;
    var mask = qs("#taskMask");
    var current = "running";

    function openDrawer() {
      drawer.classList.add("on");
      drawer.setAttribute("aria-hidden", "false");
      if (mask) mask.classList.add("on");
    }
    function closeDrawer() {
      drawer.classList.remove("on");
      drawer.setAttribute("aria-hidden", "true");
      if (mask) mask.classList.remove("on");
    }

    function syncCapsuleStep() {
      if (current !== "running") return;
      var curInd = qs(".ind.cur");
      var n = parseInt(curInd ? curInd.getAttribute("data-step") : "1", 10) || 1;
      var title = qs("[data-tc-title]");
      if (title) title.textContent = TASK_STEP_NAME[n] + " · " + TASK_NODE_NAME[n];
      var node = qs("[data-tc-node]");
      if (node) node.textContent = "当前节点：" + TASK_NODE_NAME[n];
      var bi = qs("[data-bar-idx]");
      if (bi) bi.textContent = String(n);
      var bn = qs("[data-bar-name]");
      if (bn) bn.textContent = TASK_STEP_NAME[n];
      var bs = qs("[data-bar-state]");
      var bp = qs("[data-bar-prog]");
      var cls = curInd ? curInd.className : "run";
      if (bs) {
        if (/done/.test(cls)) { bs.className = "st-state done"; bs.innerHTML = '<i class="st-dot"></i>已完成'; }
        else if (/check/.test(cls)) { bs.className = "st-state check"; bs.innerHTML = '<i class="st-dot"></i>待确认'; }
        else if (/ready/.test(cls)) { bs.className = "st-state"; bs.innerHTML = '<i class="st-dot"></i>可开始'; }
        else { bs.className = "st-state run"; bs.innerHTML = '<i class="st-dot"></i>运行中'; }
      }
      if (bp) bp.style.width = /done|check/.test(cls) ? "100%" : /ready/.test(cls) ? "0%" : "68%";
    }

    function setPhase(phase) {
      var key = TASK_PHASES[phase] ? phase : "running";
      current = key;
      var cfg = TASK_PHASES[key];

      var cap = qs("[data-task-cap]");
      if (cap) {
        cap.className = "cv-state task-cap is-" + cfg.cls;
        var title = qs("[data-tc-title]", cap);
        if (title) title.textContent = cfg.title;
        var meta = qs("[data-tc-meta]", cap);
        if (meta) meta.style.display = (key === "running" || key === "failed") ? "" : "none";
        var err = qs("[data-tc-err]", cap);
        if (err) err.style.display = cfg.err ? "" : "none";
        var act = qs("[data-tc-action]", cap);
        if (act) act.textContent = cfg.action;
        var node = qs("[data-tc-node]", cap);
        if (node) node.textContent = "当前节点：" + cfg.node;
        var abort = qs("[data-task-abort]", cap);
        if (abort) abort.style.display = (key === "running" || key === "failed") ? "" : "none";
        if (key === "failed") {
          var bi = qs("[data-bar-idx]", cap);
          if (bi) bi.textContent = "4";
          var bn = qs("[data-bar-name]", cap);
          if (bn) bn.textContent = "专业播音";
          var bs = qs("[data-bar-state]", cap);
          if (bs) { bs.className = "st-state fail"; bs.innerHTML = '<i class="st-dot"></i>失败'; }
          var bp = qs("[data-bar-prog]", cap);
          if (bp) bp.style.width = "42%";
        }
        if (key === "running") syncCapsuleStep();
      }

      var ph = qs("[data-td-phase]", drawer);
      if (ph) { ph.className = "td-phase " + cfg.cls; ph.textContent = cfg.label; }
      var pt = qs("[data-td-phase-text]", drawer);
      if (pt) pt.textContent = cfg.label;
      var el = qs("[data-td-elapsed]", drawer);
      if (el) el.textContent = cfg.elapsed;
      var nd = qs("[data-td-node]", drawer);
      if (nd) nd.textContent = cfg.node;

      cfg.steps.forEach(function (st, i) {
        var row = qs('[data-ts="' + (i + 1) + '"]', drawer);
        if (!row) return;
        var dot = qs("[data-ts-dot]", row);
        if (dot) dot.className = "td-dot " + st;
        var badge = qs("[data-ts-badge]", row);
        if (badge) { badge.className = "td-badge " + TASK_STATUS[st][1]; badge.textContent = TASK_STATUS[st][0]; }
        var rev = qs("[data-ts-rev]", row);
        if (rev) rev.textContent = cfg.revs[i];
      });

      qsa("[data-sub]", drawer).forEach(function (row, i) {
        var st = cfg.subs[i] || "idle";
        var md = qs(".td-mini", row);
        if (md) md.className = "td-mini " + st;
        var em = qs("em", row);
        if (em) em.textContent = st === "done" ? TASK_SUB_DONE[i] : st === "run" ? "62%" : "待开始";
      });

      var fail = qs("[data-td-fail]", drawer);
      if (fail) fail.style.display = cfg.err ? "" : "none";
      var log = qs("[data-td-log]", drawer);
      if (log) log.classList.remove("on");
      var logBtn = qs("[data-task-log]", drawer);
      if (logBtn) logBtn.textContent = "查看日志";

      var cyc = qs("[data-task-cycle]");
      if (cyc) cyc.textContent = "任务态：" + cfg.label;
      try {
        var u = new URL(location.href);
        if (key === "running") u.searchParams.delete("task");
        else u.searchParams.set("task", key);
        history.replaceState(null, "", u.toString());
      } catch (e) { /* ignore */ }
    }

    qsa("[data-task-open]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        /* 胶囊动作：待启动 / 已中止时按钮不再是“详情”，而是开始 / 继续 */
        if (qs("[data-tc-action]", b)) {
          if (current === "idle") {
            setPhase("running");
            window.ptToast("已开始执行 · 素材助理");
            return;
          }
          if (current === "paused") {
            setPhase("running");
            window.ptToast("已从当前步骤继续执行");
            return;
          }
        }
        openDrawer();
      });
    });
    qsa("[data-task-close]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); closeDrawer(); });
    });
    if (mask) mask.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    qsa("[data-task-abort]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptConfirm({
          title: "中止任务",
          message: "中止本次任务？\n已完成的步骤产物会保留，可从当前步骤继续。",
          okText: "中止",
          danger: true,
          toast: "已中止本次任务",
          onOk: function () { setPhase("paused"); closeDrawer(); }
        });
      });
    });

    qsa("[data-task-retry]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptProgress({
          title: "重试此步",
          label: "正在重试「配音合成 · 第 3 句」…",
          doneLabel: "重试完成，继续执行…",
          toast: "已重试配音合成 · 从第 3 句继续",
          onDone: function () { setPhase("running"); openDrawer(); }
        });
      });
    });

    qsa("[data-task-manual]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        closeDrawer();
        var mode = qsa(".mode-seg button");
        if (mode[0]) mode[0].classList.add("on");
        if (mode[1]) mode[1].classList.remove("on");
        var s4 = qs('.pt-step[data-step="4"]');
        if (s4) s4.click();
        window.ptToast("已转为手动模式 · 已定位到第 4 步");
      });
    });

    qsa("[data-task-log]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var log = qs("[data-td-log]", drawer);
        if (!log) return;
        var on = log.classList.toggle("on");
        b.textContent = on ? "收起日志" : "查看日志";
      });
    });

    /* 抽屉五步：非步骤 1 的行可点击，定位到编辑器对应步骤 */
    qsa(".td-step-row", drawer).forEach(function (row) {
      if (row.hasAttribute("data-ts-toggle")) return;
      row.addEventListener("click", function () {
        var stepEl = row.parentNode;
        var n = stepEl ? stepEl.getAttribute("data-ts") : "";
        if (!n) return;
        var name = qs("b", row) ? qs("b", row).textContent : "";
        closeDrawer();
        var btn = qs('.pt-step[data-step="' + n + '"]');
        if (btn) btn.click();
        window.ptToast("已定位到第 " + n + " 步 · " + name);
      });
    });

    /* 步骤 1 的子步骤：点选高亮，并给出状态 / 耗时 */
    qsa("[data-sub]", drawer).forEach(function (row) {
      row.addEventListener("click", function () {
        qsa("[data-sub]", drawer).forEach(function (x) { x.classList.remove("on"); });
        row.classList.add("on");
        var name = qs("span", row) ? qs("span", row).textContent : "子步骤";
        var mini = qs(".td-mini", row);
        var st = mini ? (TASK_STATUS[mini.classList[1]] || ["", ""])[0] : "";
        var time = qs("em", row) ? qs("em", row).textContent : "";
        window.ptToast(name + " · " + st + " · " + time);
      });
    });

    /* 点胶囊空白处也可打开抽屉；按钮区域保持原动作 */
    var capEl = qs("[data-task-cap]");
    if (capEl) {
      capEl.addEventListener("click", function (e) {
        if (e.target.closest("button")) return;
        openDrawer();
      });
    }

    qsa("[data-task-recent]").forEach(function (b) {
      b.addEventListener("click", function () {
        qsa("[data-task-recent]", drawer).forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        var t = qs("span", b);
        window.ptToast("查看运行记录：" + (t ? t.textContent : ""));
      });
    });

    qsa("[data-ts-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var subs = qs("[data-ts-subs]", drawer);
        if (!subs) return;
        var off = subs.classList.toggle("off");
        b.setAttribute("aria-expanded", String(!off));
        var caret = qs(".td-caret", b);
        if (caret) caret.style.transform = off ? "rotate(-90deg)" : "";
      });
    });

    qsa(".pt-step, .ind").forEach(function (b) {
      b.addEventListener("click", function () {
        /* 页内 setStep 会覆写胶囊里的 data-bar-*，这里按当前相位重新投影 */
        setTimeout(function () { setPhase(current); }, 0);
      });
    });

    var order = ["running", "failed", "needs-rerun", "completed", "paused", "idle"];
    var cyc = qs("[data-task-cycle]");
    if (cyc) {
      cyc.addEventListener("click", function () {
        var i = order.indexOf(current);
        setPhase(order[(i + 1) % order.length]);
      });
    }

    var initial = new URLSearchParams(location.search).get("task") || "running";
    setPhase(initial);
    if (initial === "failed") setTimeout(openDrawer, 700);
  }

  function initPtFlows() {
    /* 通用确认 */
    qsa("[data-confirm]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        ptConfirm({
          title: el.getAttribute("data-confirm-title") || "确认操作",
          message: el.getAttribute("data-confirm") || "确定执行该操作吗？",
          okText: el.getAttribute("data-confirm-ok") || "确定",
          danger: el.hasAttribute("data-confirm-danger"),
          toast: el.getAttribute("data-confirm-toast") || "",
          onOk: function () {
            var sel = el.getAttribute("data-confirm-remove");
            if (sel) {
              var card = el.closest(sel);
              if (card && card.parentNode) card.parentNode.removeChild(card);
              syncListEmpty();
            }
            if (el.hasAttribute("data-confirm-close")) {
              var dlg = el.closest(".dlg-mask");
              if (dlg) dlg.classList.remove("on");
            }
          }
        });
      });
    });

    /* 目录选择 */
    qsa("[data-browse]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var row = b.closest(".set-row") || b.parentNode;
        var input = qs(".set-input", row);
        var cur = input ? input.value : "";
        var items = [];
        if (cur) items.push({ label: cur, meta: "当前目录", value: cur });
        items.push(
          { label: "F:\\Zentect\\data\\projects", meta: "默认项目目录" },
          { label: "F:\\Zentect\\data\\exports", meta: "默认导出目录" },
          { label: "D:\\Zentect\\data", meta: "自定义目录" }
        );
        ptChoose({
          title: "选择文件夹",
          okText: "选择此文件夹",
          items: items,
          onPick: function (v, label) {
            if (input) input.value = label;
            window.ptToast("已选择目录：" + label);
          }
        });
      });
    });

    /* 模型文件导入 */
    qsa("[data-import]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptChoose({
          title: "导入模型文件",
          okText: "导入",
          items: [
            { label: "UVR-MDX-NET-Inst_HQ_3.onnx", meta: "ONNX 模型 · 78.2 MB" },
            { label: "htdemucs_ft.safetensors", meta: "Safetensors · 80.4 MB" },
            { label: "kokoro-v1.0.onnx", meta: "ONNX 模型 · 310 MB" }
          ],
          onPick: function (v, label) {
            ptProgress({
              title: "导入模型文件",
              label: "正在校验文件：" + label,
              doneLabel: "校验完成，正在写入模型目录…",
              toast: "已导入 " + label
            });
          }
        });
      });
    });

    /* 模型安装 */
    qsa("[data-install]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var mod = b.closest(".set-mod");
        var name = mod ? ptModuleName(mod) : "模型";
        ptProgress({
          title: "下载模型",
          label: "正在下载「" + name + "」…",
          doneLabel: "下载完成，正在校验模型文件…",
          toast: name + " 安装完成（1 个文件）",
          onDone: function () {
            if (!mod) return;
            mod.classList.add("ready");
            var st = qs(".set-mod-status", mod);
            if (st) { st.textContent = "✓ 已就绪"; st.className = "set-mod-status ok"; }
            b.style.display = "none";
          }
        });
      });
    });

    /* 模型卸载（对齐源码确认文案） */
    qsa("[data-uninstall]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var mod = b.closest(".set-mod");
        var name = mod ? ptModuleName(mod) : "模型";
        var files = mod ? mod.querySelectorAll(".set-file").length : 0;
        ptConfirm({
          title: "卸载模型",
          message: "确认卸载「" + name + "」？\n将删除 " + files + " 个模型文件。",
          okText: "卸载",
          danger: true,
          toast: "已卸载「" + name + "」（删除 " + files + " 个模型文件）",
          onOk: function () {
            if (!mod) return;
            mod.classList.remove("ready");
            var st = qs(".set-mod-status", mod);
            if (st) { st.textContent = "✕ 未安装"; st.className = "set-mod-status none"; }
            var install = qs("[data-install]", mod);
            if (install) install.style.display = "";
          }
        });
      });
    });

    /* TTS 试听 */
    qsa("[data-trial]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptProgress({
          title: "试听音色",
          label: "正在合成试听音频…",
          doneLabel: "试听完成",
          toast: "试听完成 · 微软 Edge TTS"
        });
      });
    });

    /* 重新扫描本地模型目录 */
    qsa("[data-rescan]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptProgress({
          title: "重新扫描模型",
          label: "正在扫描本地模型目录…",
          doneLabel: "扫描完成 · 共 6 个模块",
          toast: "扫描完成 · 6 个模块"
        });
      });
    });

    /* 模型分类筛选：分类 chips 真正过滤模块；无结果显示空态（对齐源码 ModelTab）
       ?modEmpty=audio 可强制预览某分类的空态 */
    var modChips = qsa(".set-chips .set-chip");
    var modList = qsa(".set-mods .set-mod");
    var modEmpty = qs("#modEmpty");
    var forcedEmpty = (function () {
      var m = /[?&]modEmpty=([^&]+)/.exec(location.search);
      return m ? m[1] : "";
    })();
    function applyModCat(cat) {
      var shown = 0;
      modList.forEach(function (mod) {
        var own = mod.getAttribute("data-cat");
        var hit = (cat === "all" || own === cat) && own !== forcedEmpty;
        mod.hidden = !hit;
        if (hit) shown++;
      });
      var wrap = qs(".set-mods");
      if (wrap) wrap.hidden = shown === 0;
      if (modEmpty) modEmpty.classList.toggle("on", shown === 0);
    }
    modChips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        modChips.forEach(function (c) { c.classList.remove("on"); });
        chip.classList.add("on");
        applyModCat(chip.getAttribute("data-cat") || "all");
      });
    });
    if (forcedEmpty) {
      modChips.forEach(function (c) {
        if (c.getAttribute("data-cat") !== forcedEmpty) return;
        modChips.forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        var badge = qs("i", c);
        if (badge) badge.textContent = "0";
        applyModCat(forcedEmpty);
      });
    }

    /* 编辑器：关键帧排序 */
    qsa("[data-sort]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        window.ptToast("已按时间排序 · 12 帧");
      });
    });

    /* 编辑器：脚本总览 / 复制全部 */
    qsa("[data-overview]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var on = b.classList.toggle("on");
        b.textContent = on ? "收起总览" : "总览";
        window.ptToast(on ? "已切换到总览视图" : "已回到逐段编辑");
      });
    });
    qsa("[data-copyall]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var text = qsa(".st-textarea").map(function (t) { return t.value || t.placeholder; }).join("\n");
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
        window.ptToast("已复制全部文案 · 386 字");
      });
    });

    /* 编辑器：重新生成脚本 */
    qsa("[data-regen]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptConfirm({
          title: "重新生成脚本",
          message: "将应用当前参数重新生成脚本，覆盖当前 386 字解说文案。\n确定继续吗？",
          okText: "重新生成",
          onOk: function () {
            ptProgress({
              title: "重新生成脚本",
              label: "正在应用当前参数重新生成…",
              doneLabel: "生成完成 · 386 字",
              toast: "脚本已按当前参数重新生成"
            });
          }
        });
      });
    });

    /* 编辑器：全部播放 */
    qsa("[data-playall]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var on = b.classList.toggle("on");
        b.textContent = on ? "暂停播放" : "全部播放";
        window.ptToast(on ? "顺序播放中 · 第 1/8 段" : "已暂停播放");
      });
    });

    /* 编辑器：单段配音 */
    qsa("[data-synth]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        if (b.disabled) return;
        var row = b.closest(".st-tts-row");
        var label = row ? ptRowLabel(row) : "本段";
        var badge = row ? qs(".badge", row) : null;
        b.disabled = true;
        if (badge) { badge.textContent = "合成中"; badge.className = "badge accent"; }
        window.ptToast("正在合成 " + label + "…");
        setTimeout(function () {
          b.disabled = false;
          if (badge) { badge.textContent = "已完成"; badge.className = "badge green"; }
          window.ptToast(label + " 配音完成");
        }, 1100);
      });
    });

    /* 编辑器：试听 / 原声（选中态 + 结束反馈） */
    qsa("[data-audition]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var was = b.classList.contains("on");
        b.classList.toggle("on", !was);
        var row = b.closest(".st-tts-row");
        var label = row ? ptRowLabel(row) : "本段";
        var what = b.title || "试听";
        window.ptToast(was ? "已停止试听" : what + " · " + label);
        if (!was) {
          setTimeout(function () {
            if (!b.classList.contains("on")) return;
            b.classList.remove("on");
            window.ptToast("试听结束");
          }, 1600);
        }
      });
    });

    /* 编辑器：片段预览 */
    function bindSegPreview(btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var row = btn.closest(".st-match");
        var tc = row ? row.getAttribute("data-tc") : "";
        var chip = row ? qsAllText(row, ".st-chip") : "";
        ptPreview({
          title: "片段预览",
          tc: tc || "00:00.000",
          duration: chip || "—",
          desc: row && qs(".st-match-idx", row) ? "镜头 " + qs(".st-match-idx", row).textContent.trim() : "镜头片段"
        });
      });
    }
    function qsAllText(root, sel) {
      return qsa(sel, root).map(function (x) { return x.textContent.trim(); }).join(" · ");
    }
    qsa("[data-seg-preview]").forEach(bindSegPreview);

    /* 编辑器：确认匹配 */
    qsa("[data-match-confirm]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var row = b.closest(".st-match");
        if (!row) return;
        row.classList.remove("warn", "danger");
        qsa(".badge.warn", row).forEach(function (x) {
          if (x.textContent.trim() === "待确认") { x.textContent = "已确认"; x.className = "badge green"; }
        });
        var acts = qs(".st-match-actions", row);
        if (acts) {
          acts.innerHTML = '<button class="st-act" data-seg-preview>▷ 预览</button>' +
            '<span style="font-size:11.5px;color:var(--accent-green);display:inline-flex;align-items:center;gap:3px;">✓ 已确认</span>';
          var nb = qs("[data-seg-preview]", acts);
          if (nb) bindSegPreview(nb);
        }
        var sub = qsa(".st-center-head .st-sub").filter(function (x) {
          return /已确认/.test(x.textContent);
        })[0] || null;
        if (sub && /已确认/.test(sub.textContent)) {
          sub.innerHTML = sub.innerHTML.replace(/已确认\s*3\/12/, "已确认 4/12");
        }
        window.ptToast("已确认镜头 " + (qs(".st-match-idx", row) ? qs(".st-match-idx", row).textContent.trim() : ""));
      });
    });

    /* 编辑器：替换片段 */
    qsa("[data-replace]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var row = b.closest(".st-match");
        ptChoose({
          title: "替换片段",
          okText: "替换",
          items: [
            { label: "片段 04 · 00:09.600", meta: "6.1s · 相似度 88%" },
            { label: "片段 07 · 00:18.440", meta: "5.4s · 相似度 85%" },
            { label: "片段 11 · 00:29.200", meta: "7.2s · 相似度 81%" }
          ],
          onPick: function (v, label) {
            if (row) {
              var lab = qs(".st-match-thumb .lab", row);
              if (lab) lab.textContent = label.slice(2, 4);
            }
            window.ptToast("已替换为「" + label + "」");
          }
        });
      });
    });

    /* 编辑器：清空切片缓存（对齐源码：二次确认 + 3s 自动复位） */
    qsa("[data-clear-cache]").forEach(function (b) {
      var armed = false;
      var timer = null;
      function reset() {
        armed = false;
        b.classList.remove("armed");
        b.textContent = "清空切片缓存";
        clearTimeout(timer);
      }
      b.addEventListener("click", function (e) {
        e.preventDefault();
        if (!armed) {
          armed = true;
          b.classList.add("armed");
          b.textContent = "再次点击确认清空";
          window.ptToast("将清空切片缓存并重新切片（约 80 秒）");
          timer = setTimeout(reset, 3000);
          return;
        }
        reset();
        ptProgress({
          title: "清空切片缓存",
          label: "正在清空当前视频切片缓存…",
          doneLabel: "已清空，正在重新检测切片",
          toast: "切片缓存已清空，已开始重新匹配"
        });
      });
    });

    /* 编辑器：重新匹配 */
    qsa("[data-rematch]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptProgress({
          title: "重新匹配",
          label: "正在重新匹配 12 个镜头…",
          doneLabel: "匹配完成 · 12 个镜头",
          toast: "重新匹配完成 · 12 个镜头"
        });
      });
    });

    /* 编辑器：定位到第 N 段 */
    qsa("[data-locate]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var box = b.parentNode;
        var input = qs(".st-input", box);
        var n = parseInt(input && input.value, 10);
        var rows = qsa(".st-match");
        if (!n || n < 1 || n > rows.length) { window.ptToast("请输入 1 ~ " + rows.length + " 的段号"); return; }
        var row = rows[n - 1];
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.remove("flash");
        void row.offsetWidth;
        row.classList.add("flash");
        window.ptToast("已定位到第 " + n + " 段");
      });
    });

    /* 编辑器：导入本地视频 */
    qsa("[data-import-video]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptChoose({
          title: "选择本地视频",
          okText: "导入",
          items: [
            { label: "DJI_0043.MP4", meta: "1920×1080 · 186s" },
            { label: "interview_take2.mov", meta: "3840×2160 · 94s" },
            { label: "broll_city.mp4", meta: "1920×1080 · 42s" }
          ],
          onPick: function (v, label) {
            var list = qs("[data-media-list]");
            if (list) {
              var tile = document.createElement("div");
              tile.className = "media-tile";
              tile.setAttribute("data-media", label);
              tile.innerHTML = '<span class="media-tile-thumb"></span>' +
                '<span class="media-tile-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M7 4.5v15M17 4.5v15M2.5 9.5h4.5M2.5 14.5h4.5M17 9.5h4.5M17 14.5h4.5"/></svg></span>' +
                '<span class="media-tile-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
                '<button class="media-tile-x" title="移除"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
                '<span class="media-tile-foot"><b></b><em></em></span>';
              qs("b", tile).textContent = label;
              qs("em", tile).textContent = "新增素材";
              qs(".media-tile-x", tile).addEventListener("click", function (ev) {
                ev.stopPropagation();
                list.removeChild(tile);
                var cnt = qs("[data-media-count]");
                if (cnt) cnt.textContent = list.querySelectorAll("[data-media]").length + " 个";
              });
              list.appendChild(tile);
            }
            var cnt = qs("[data-media-count]");
            if (cnt) cnt.textContent = qsa("[data-media]").length + " 个";
            window.ptToast("已导入 " + label);
          }
        });
      });
    });

    /* 编辑器：音色选择 */
    qsa("[data-voice]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptChoose({
          title: "选择配音音色",
          okText: "使用此音色",
          items: [
            { label: "小美 · 温柔女声", meta: "当前音色" },
            { label: "晓晓 · 中文·女", meta: "Edge TTS" },
            { label: "晓伊 · 中文·女", meta: "Edge TTS" },
            { label: "云希 · 中文·男", meta: "Edge TTS" },
            { label: "云扬 · 中文·男", meta: "Edge TTS" },
            { label: "小北 · 中文·女", meta: "Kokoro 本地" },
            { label: "小妮 · 中文·女", meta: "Kokoro 本地" }
          ],
          onPick: function (v, label) {
            b.innerHTML = label + "<span>⌄</span>";
            var sum = qs(".sum-line span");
            if (sum) sum.textContent = label + " · 自动字幕";
            var chk = qsa(".wiz-check-main em")[3];
            if (chk) chk.textContent = label;
            window.ptToast("已选择音色：" + label);
          }
        });
      });
    });

    /* 编辑器：更改导出路径 */
    qsa("[data-change-path]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var input = qs("input", b.parentNode);
        ptChoose({
          title: "选择视频保存位置",
          okText: "选择此文件夹",
          items: [
            { label: "D:\\Zentect\\exports", meta: "当前目录" },
            { label: "F:\\Zentect\\data\\exports", meta: "默认导出目录" },
            { label: "E:\\成片输出", meta: "自定义目录" }
          ],
          onPick: function (v, label) {
            if (input) input.value = label;
            window.ptToast("导出位置已更改：" + label);
          }
        });
      });
    });

    /* 个人设置：更换头像 */
    qsa("[data-avatar]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        ptChoose({
          title: "更换头像",
          okText: "使用此图片",
          items: [
            { label: "avatar-01.png", meta: "512×512 · 48 KB" },
            { label: "avatar-02.jpg", meta: "512×512 · 96 KB" },
            { label: "portrait.webp", meta: "1024×1024 · 210 KB" }
          ],
          onPick: function (v, label) {
            var ava = qs(".us-ava");
            if (ava) {
              ava.style.borderColor = "var(--accent)";
              ava.style.boxShadow = "0 0 0 3px rgba(237,237,237,.12)";
            }
            window.ptToast("头像已更新：" + label);
          }
        });
      });
    });

    /* 个人设置：保存修改（修改密码） */
    qsa("[data-save-password]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var panel = b.closest("[data-tabpanel]") || b.closest(".set-page") || document;
        var inputs = qsa(".inp", panel);
        var oldPw = inputs[0] ? inputs[0].value : "";
        var newPw = inputs[1] ? inputs[1].value : "";
        var confirmPw = inputs[2] ? inputs[2].value : "";
        if (!oldPw) { window.ptToast("请输入当前密码"); return; }
        if (!newPw || newPw.length < 6) { window.ptToast("新密码至少 6 位"); return; }
        if (newPw !== confirmPw) { window.ptToast("两次输入的新密码不一致"); return; }
        ptConfirm({
          title: "修改密码",
          message: "修改后需使用新密码重新登录。\n确定修改密码吗？",
          okText: "修改",
          onOk: function () {
            ptProgress({
              title: "修改密码",
              label: "正在保存新密码…",
              doneLabel: "密码已更新",
              toast: "密码修改成功",
              onDone: function () {
                if (inputs[0]) inputs[0].value = "";
                if (inputs[1]) inputs[1].value = "";
                if (inputs[2]) inputs[2].value = "";
              }
            });
          }
        });
      });
    });
    /* 个人设置：密码可见性切换 */
    qsa(".us-eye").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault();
        var inp = b.parentElement ? b.parentElement.querySelector(".inp") : null;
        if (!inp) return;
        var show = inp.type === "password";
        inp.type = show ? "text" : "password";
        b.classList.toggle("on", show);
        b.title = show ? "隐藏密码" : "显示密码";
      });
    });
  }

  /* ---------- 登录 / 注册弹窗（对齐 auth-modal.tsx） ---------- */
  var AUTH_ICON = {
    x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    eye: '<svg class="eye-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg class="eye-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 4.3A10.9 10.9 0 0 1 12 4c6.4 0 10 8 10 8a18.4 18.4 0 0 1-2.4 3.3M6.4 6.4A17.5 17.5 0 0 0 2 12s3.6 8 10 8c1.9 0 3.6-.6 5.1-1.5"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/></svg>',
    login: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/></svg>',
    register: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>',
    loading: '<svg class="auth-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 7 4.5 4.5L12 4l4.5 7.5L21 7l-2 12H5L3 7Z"/></svg>',
    logout: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>',
    mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 7H17.6L6.4 17" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.4 17H17.6" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity=".6"/></svg>'
  };
  var AUTH_COPY = {
    login: { title: "欢迎回来", sub: "登录以同步你的创作数据", submit: "登录" },
    register: { title: "创建账号", sub: "注册即可开始 AI 创作之旅", submit: "注册" }
  };
  var authMask = null;

  /* ---------- 登录态（侧栏用户卡，对齐 AppSidebar 的 isLoggedIn 分支） ---------- */
  var AUTH_USER_KEY = "ptAuthUser";
  function getAuthUser() {
    try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null"); } catch (e) { return null; }
  }
  function setAuthUser(u) {
    try {
      if (u) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u));
      else localStorage.removeItem(AUTH_USER_KEY);
    } catch (e) {}
    applyAuthState();
  }
  function goAccount() { location.href = "./settings.html?tab=account"; }

  function applyAuthState() {
    var u = getAuthUser();
    qsa(".user-card").forEach(function (card) {
      var row = qs(".user-row", card);
      var meta = qs(".user-meta", card);
      var loginBtn = qs(".btn-login", card);
      var acts = qs(".user-acts", card);
      if (!meta) return;
      if (u) {
        if (!acts) {
          acts = document.createElement("div");
          acts.className = "user-acts";
          acts.innerHTML =
            '<button type="button" class="vip-chip" data-auth-vip title="管理专业版">' + AUTH_ICON.crown + "<span>" + u.vip + "</span></button>" +
            '<button type="button" class="btn-logout" data-auth-logout title="退出登录">' + AUTH_ICON.logout + "</button>";
          card.appendChild(acts);
          qs("[data-auth-vip]", acts).addEventListener("click", function (e) {
            e.stopPropagation();
            location.href = "./settings.html";
          });
          qs("[data-auth-logout]", acts).addEventListener("click", function (e) {
            e.stopPropagation();
            setAuthUser(null);
            window.ptToast("已退出登录");
          });
        }
        acts.style.display = "";
        meta.innerHTML = "<b>" + u.username + "</b><span>" + u.vip + "</span>";
        if (loginBtn) loginBtn.style.display = "none";
      } else {
        if (acts) acts.style.display = "none";
        meta.innerHTML = "<b>未登录</b><span>点击登录账号</span>";
        if (loginBtn) {
          loginBtn.style.display = "";
          if (!qs("svg", loginBtn)) loginBtn.innerHTML = AUTH_ICON.login + "<span>登录</span>";
        }
      }
      if (row) row.title = u ? "账户设置" : "登录 / 注册";
    });
  }

  function closeAuth() {
    if (!authMask) return;
    var el = authMask;
    authMask = null;
    el.classList.add("closing");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
    document.removeEventListener("keydown", onAuthKey);
  }
  function onAuthKey(e) { if (e.key === "Escape") closeAuth(); }

  function ptAuth(initialTab) {
    closeAuth();
    var mask = document.createElement("div");
    mask.className = "auth-mask";
    mask.innerHTML =
      '<div class="auth-box" role="dialog" aria-modal="true">' +
        '<button type="button" class="auth-x" data-auth-close title="关闭">' + AUTH_ICON.x + "</button>" +
        '<div class="auth-head">' +
          '<div class="auth-logo">' + AUTH_ICON.mark + '</div>' +
          '<h2 class="auth-title"></h2>' +
          '<p class="auth-sub"></p>' +
        "</div>" +
        '<div class="auth-tabs">' +
          '<button type="button" class="auth-tab" data-auth-tab="login">登录</button>' +
          '<button type="button" class="auth-tab" data-auth-tab="register">注册</button>' +
        "</div>" +
        '<form class="auth-form" novalidate>' +
          '<div class="auth-fld"><label>用户名</label>' +
            '<input class="auth-input" type="text" data-auth-user placeholder="请输入用户名" autocomplete="username" /></div>' +
          '<div class="auth-fld"><label>密码</label><div class="auth-pw">' +
            '<input class="auth-input" type="password" data-auth-pass placeholder="请输入密码" autocomplete="current-password" />' +
            '<button type="button" class="auth-eye" data-auth-eye title="显示密码">' + AUTH_ICON.eye + AUTH_ICON.eyeOff + "</button>" +
          "</div></div>" +
          '<div class="auth-fld" data-auth-confirm-wrap><label>确认密码</label>' +
            '<input class="auth-input" type="password" data-auth-confirm placeholder="再次输入密码" autocomplete="new-password" /></div>' +
          '<div class="auth-err" data-auth-err hidden></div>' +
          '<button type="submit" class="auth-submit" data-auth-submit disabled>' +
            '<span data-auth-icon>' + AUTH_ICON.login + "</span>" +
            '<span data-auth-label>登录</span>' +
          "</button>" +
        "</form>" +
      "</div>";
    document.body.appendChild(mask);
    authMask = mask;

    var tab = initialTab === "register" ? "register" : "login";
    var user = qs("[data-auth-user]", mask);
    var pass = qs("[data-auth-pass]", mask);
    var confirm = qs("[data-auth-confirm]", mask);
    var confirmWrap = qs("[data-auth-confirm-wrap]", mask);
    var errEl = qs("[data-auth-err]", mask);
    var submit = qs("[data-auth-submit]", mask);
    var submitIcon = qs("[data-auth-icon]", mask);
    var submitLabel = qs("[data-auth-label]", mask);
    var eye = qs("[data-auth-eye]", mask);

    function showErr(text) { errEl.textContent = text; errEl.hidden = !text; }
    function syncSubmit() {
      submit.disabled = !user.value.trim() || !pass.value.trim();
    }
    function resetEye() {
      pass.type = "password";
      eye.classList.remove("on");
      eye.title = "显示密码";
    }
    function render() {
      var c = AUTH_COPY[tab];
      qs(".auth-title", mask).textContent = c.title;
      qs(".auth-sub", mask).textContent = c.sub;
      qsa("[data-auth-tab]", mask).forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-auth-tab") === tab);
      });
      confirmWrap.style.display = tab === "register" ? "" : "none";
      pass.placeholder = tab === "register" ? "至少 6 位密码" : "请输入密码";
      pass.autocomplete = tab === "login" ? "current-password" : "new-password";
      submitLabel.textContent = c.submit;
      submitIcon.innerHTML = tab === "login" ? AUTH_ICON.login : AUTH_ICON.register;
      user.value = "";
      pass.value = "";
      confirm.value = "";
      resetEye();
      showErr("");
      syncSubmit();
      user.focus();
    }

    qsa("[data-auth-tab]", mask).forEach(function (b) {
      b.addEventListener("click", function () {
        tab = b.getAttribute("data-auth-tab") === "register" ? "register" : "login";
        render();
      });
    });
    qs("[data-auth-close]", mask).addEventListener("click", closeAuth);
    mask.addEventListener("click", function (e) { if (e.target === mask) closeAuth(); });
    document.addEventListener("keydown", onAuthKey);
    user.addEventListener("input", syncSubmit);
    pass.addEventListener("input", syncSubmit);
    eye.addEventListener("click", function () {
      var show = pass.type === "password";
      pass.type = show ? "text" : "password";
      eye.classList.toggle("on", show);
      eye.title = show ? "隐藏密码" : "显示密码";
    });

    qs("form", mask).addEventListener("submit", function (e) {
      e.preventDefault();
      if (submit.disabled) return;
      if (tab === "register") {
        if (pass.value !== confirm.value) { showErr("两次输入的密码不一致"); return; }
        if (pass.value.length < 6) { showErr("密码长度至少 6 位"); return; }
      }
      showErr("");
      submit.disabled = true;
      submitIcon.innerHTML = AUTH_ICON.loading;
      setTimeout(function () {
        var done = tab;
        setAuthUser({ username: user.value.trim() || "admin", vip: "专业版" });
        closeAuth();
        window.ptToast(done === "login" ? "登录成功" : "注册成功，已自动登录");
      }, 900);
    });

    render();
    return mask;
  }
  window.ptAuth = ptAuth;

  /* ---------- 通用：可点选项组 ---------- */
  function bindChoice(root, selector) {
    qsa(selector, root).forEach(function (el) {
      el.addEventListener("click", function () {
        var parent = el.parentElement;
        qsa(selector, parent).forEach(function (x) { x.classList.remove("on"); });
        el.classList.add("on");
      });
    });
  }

  /* ---------- 编辑器状态机 ---------- */
  var STATE_STEP = {
    wizard: 0,
    running: 1,
    failed: 3,
    checkpoint: 3,
    params: 3,
    export: 5
  };

  function setIndicator(step) {
    qsa(".ind").forEach(function (ind) {
      var n = parseInt(ind.getAttribute("data-i"), 10);
      ind.classList.toggle("done", n < step);
      ind.classList.toggle("cur", n === step);
      if (n === step) ind.classList.add("cur");
    });
  }

  function closeDrawer() {
    var d = qs("#taskDrawer");
    var ov = qs("#edOverlay");
    if (d) d.classList.remove("on");
    if (ov) ov.classList.remove("on");
  }

  function openDrawer() {
    var d = qs("#taskDrawer");
    var ov = qs("#edOverlay");
    if (d) d.classList.add("on");
    if (ov) ov.classList.remove("on");
  }

  function closeModal() {
    qsa(".modal-wrap").forEach(function (m) { m.classList.remove("on"); });
  }

  function openModal() {
    var m = qs("#exportModal");
    if (m) m.classList.add("on");
  }

  /* 左侧流水线随状态变化 */
  var PIPE = {
    wizard: ["wait", "wait", "wait", "wait", "wait"],
    running: ["done", "done", "run", "wait", "wait"],
    failed: ["done", "done", "fail", "wait", "wait"],
    checkpoint: ["done", "done", "done", "wait", "wait"],
    params: ["done", "done", "done", "wait", "wait"]
  };
  var PIPE_SIDE = {
    wizard: ["待启动", "待启动", "待启动", "待启动", "待启动"],
    running: ["已完成", "已完成", "执行中 68%", "等待管线执行", "等待管线执行"],
    failed: ["已完成", "已完成", "失败", "等待管线执行", "等待管线执行"],
    checkpoint: ["已完成", "已完成", "已完成", "等待管线执行", "等待管线执行"],
    params: ["已完成", "已完成", "已完成", "等待管线执行", "等待管线执行"]
  };
  /* 勾/叉/点一律由 CSS 绘制，避免字形在不同字体下偏心 */
  var PIPE_GLYPH = { done: "", run: "", fail: "", wait: "" };

  function setPipe(view) {
    qsa(".pipe-row").forEach(function (row) {
      var i = parseInt(row.getAttribute("data-p"), 10) - 1;
      var st = (PIPE[view] || PIPE.wizard)[i] || "wait";
      row.classList.remove("is-done", "is-run", "is-fail", "is-wait");
      row.classList.add("is-" + st);
      var dot = qs(".pr-dot", row);
      if (dot) dot.textContent = PIPE_GLYPH[st];
      var side = qs(".pr-side", row);
      if (side) side.textContent = (PIPE_SIDE[view] || PIPE_SIDE.wizard)[i];
    });
  }

  function setState(name) {
    /* 导出是弹窗，底下的面板保持在检查点状态 */
    var view = name === "export" ? "checkpoint" : name;
    document.body.setAttribute("data-ed", view);
    if (view === "wizard") document.body.classList.remove("wiz-off");
    qsa(".state").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-state") === view); });
    qsa("[data-state-btn]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-state-btn") === name); });
    var step = STATE_STEP[name] || 0;
    setIndicator(step);
    setPipe(view);

    if (name === "running") openDrawer(); else closeDrawer();
    if (name === "export") openModal(); else closeModal();

    try {
      var u = new URL(location.href);
      if (name === "wizard") u.searchParams.delete("s");
      else u.searchParams.set("s", name);
      history.replaceState(null, "", u.toString());
    } catch (e) { /* ignore */ }
  }

  /* ---------- 初始化 ---------- */
  function initEditor() {
    qsa("[data-state-btn]").forEach(function (b) {
      b.addEventListener("click", function () { setState(b.getAttribute("data-state-btn")); });
    });

    var q = (new URLSearchParams(location.search)).get("s") || "wizard";
    setState(q);

    qsa("[data-drawer-open]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); openDrawer(); });
    });
    qsa("[data-drawer-close]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); closeDrawer(); });
    });
    var ov = qs("#edOverlay");
    if (ov) ov.addEventListener("click", closeDrawer);
    var dClose = qs("#drawerOverlay");
    if (dClose) dClose.addEventListener("click", closeDrawer);

    /* 向导：一屏一个决定，底部推进 */
    var WIZ = ["m", "r", "c"];
    var WIZ_NEXT = ["下一步：选择配方", "下一步：开始前检查", "开始生成"];
    var wizIdx = 0;

    function wizGo(i) {
      wizIdx = Math.max(0, Math.min(WIZ.length - 1, i));
      var key = WIZ[wizIdx];
      qsa(".wiz-step").forEach(function (s) {
        var k = s.getAttribute("data-wtab");
        s.classList.toggle("on", k === key);
        s.classList.toggle("done", WIZ.indexOf(k) < wizIdx);
      });
      qsa("[data-wpanel]").forEach(function (p) {
        p.style.display = p.getAttribute("data-wpanel") === key ? "" : "none";
      });
      var idx = qs("[data-wiz-idx]");
      if (idx) idx.textContent = String(wizIdx + 1);
      var next = qs("[data-wiz-next]");
      if (next) next.textContent = WIZ_NEXT[wizIdx];
      var back = qs("[data-wiz-back]");
      if (back) back.style.display = wizIdx === 0 ? "none" : "";
    }

    qsa(".wiz-step").forEach(function (s) {
      s.addEventListener("click", function () { wizGo(WIZ.indexOf(s.getAttribute("data-wtab"))); });
    });
    var wq = parseInt(new URLSearchParams(location.search).get("w") || "1", 10);
    wizGo(isNaN(wq) ? 0 : wq - 1);
    qsa("[data-wiz-next]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (wizIdx === 2) setState("running");
        else wizGo(wizIdx + 1);
      });
    });
    qsa("[data-wiz-back]").forEach(function (b) {
      b.addEventListener("click", function () { wizGo(wizIdx - 1); });
    });

    /* 初始化步骤：最近素材点选即加入 / 移除，计数同步 */
    var mediaList = qs("[data-media-list]");
    var mediaCount = qs("[data-media-count]");
    function refreshMediaCount() {
      if (mediaCount && mediaList) mediaCount.textContent = mediaList.querySelectorAll("[data-media]").length + " 个";
    }
    qsa("[data-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = b.getAttribute("data-key");
        var exists = mediaList && mediaList.querySelector('[data-media="' + key + '"]');
        if (exists) {
          exists.parentNode.removeChild(exists);
          b.classList.remove("on");
        } else if (mediaList) {
          var row = document.createElement("div");
          row.className = "media-tile";
          row.setAttribute("data-media", key);
          var thumb = b.querySelector(".recent-thumb");
          if (thumb) {
            var cloned = thumb.cloneNode(true);
            cloned.className = "media-tile-thumb";
            row.appendChild(cloned);
          }
          var main = b.querySelector(".recent-main");
          if (main) {
            var foot = document.createElement("span");
            foot.className = "media-tile-foot";
            foot.innerHTML = "<b></b><em></em>";
            foot.querySelector("b").textContent = (b.querySelector(".recent-name") || {}).textContent || key;
            foot.querySelector("em").textContent = (b.querySelector(".recent-meta") || {}).textContent || "";
            row.appendChild(foot);
          }
          var x = document.createElement("button");
          x.className = "media-tile-x";
          x.setAttribute("data-remove", "");
          x.title = "移除";
          x.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
          row.appendChild(x);
          mediaList.appendChild(row);
          b.classList.add("on");
        }
        refreshMediaCount();
      });
    });
    if (mediaList) {
      mediaList.addEventListener("click", function (e) {
        var x = e.target.closest("[data-remove]");
        if (!x) return;
        var row = x.closest("[data-media]");
        var pick = qs('[data-pick][data-key="' + row.getAttribute("data-media") + '"]');
        if (pick) pick.classList.remove("on");
        mediaList.removeChild(row);
        refreshMediaCount();
      });
    }
    refreshMediaCount();

    /* 浮层关闭 → 露出任务中心面板，可再次打开 */
    qsa("[data-wiz-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        document.body.classList.add("wiz-off");
        window.ptToast("已收起一键成片，可随时在左栏重新打开");
      });
    });
    qsa("[data-wiz-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        document.body.classList.remove("wiz-off");
      });
    });

    /* 参数分层 */
    qsa(".tier-head").forEach(function (head) {
      head.addEventListener("click", function () {
        var tier = head.closest(".tier");
        if (tier) tier.classList.toggle("locked");
      });
    });

    /* 开关 */
    qsa(".switch").forEach(function (sw) {
      sw.addEventListener("click", function (e) { e.stopPropagation(); sw.classList.toggle("on"); });
    });

    /* 分段控件与选项 */
    qsa(".seg").forEach(function (group) { bindChoice(group, "button"); });
    qsa("[data-choices]").forEach(function (row) { bindChoice(row, ".p-opt"); });
    qsa("[data-recipes]").forEach(function (grp) { bindChoice(grp, ".recipe"); });
    qsa("[data-fmts]").forEach(function (grp) { bindChoice(grp, ".fmt-row"); });

    /* 媒体页签 */
    qsa("[data-mtab]").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = b.getAttribute("data-mtab");
        qsa("[data-mtab]").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-mtab") === key); });
        qsa("[data-mpanel]").forEach(function (p) {
          p.style.display = p.getAttribute("data-mpanel") === key ? "" : "none";
        });
      });
    });

    /* 卡片选择态 */
    qsa("[data-thumb]").forEach(function (t) {
      t.addEventListener("click", function () {
        qsa("[data-thumb]").forEach(function (x) { x.classList.remove("on"); });
        t.classList.add("on");
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); closeModal(); }
    });
  }

  function initHome() {
    var input = qs("#projSearch");
    var grid = qs("#projGrid");
    var empty = qs("#projEmpty");
    var emptyTitle = qs("#projEmptyTitle");
    var emptyDesc = qs("#projEmptyDesc");
    var count = qs(".sec-count");
    var renameDlg = qs("#renameDlg");
    var renameInput = qs("#renameInput");
    var renameConfirm = qs("#renameConfirm");
    var deleteDlg = qs("#deleteDlg");
    var deleteName = qs("#deleteName");
    var deleteConfirm = qs("#deleteConfirm");
    var editing = null;
    var deleting = null;
    var bindDlg = qs("#bindDlg");
    var bindList = qs("#bindList");
    var bindConfirm = qs("#bindConfirm");
    var binding = null;
    var bindShow = "";

    function cards() { return grid ? qsa(".pcard", grid) : []; }

    function apply() {
      var v = input ? input.value.trim() : "";
      var shown = 0;
      cards().forEach(function (c) {
        var hit = (c.getAttribute("data-name") || "").toLowerCase().indexOf(v.toLowerCase()) >= 0;
        c.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (count) count.textContent = "(" + cards().length + ")";
      if (!empty) return;
      empty.classList.toggle("on", shown === 0);
      if (shown === 0) {
        emptyTitle.textContent = v ? "没有找到匹配的项目" : "还没有项目";
        emptyDesc.textContent = v ? "试试其他关键词" : "点击上方「开始创作」按钮创建你的第一个项目";
      }
    }

    /* 卡片右上「更多」：菜单同一时间只开一个 */
    function closeMenus() {
      qsa(".pmenu.on").forEach(function (m) {
        m.classList.remove("on");
        var btn = m.parentElement.querySelector(".pmore");
        if (btn) btn.classList.remove("on");
      });
    }

    function runAction(act, card) {
      var name = card.getAttribute("data-name") || "";
      if (act === "rename") {
        editing = card;
        renameInput.value = name;
        renameConfirm.disabled = true;
        renameDlg.classList.add("on");
        renameInput.focus();
        renameInput.select();
      } else if (act === "duplicate") {
        var copy = card.cloneNode(true);
        var newName = name + "(1)";
        copy.setAttribute("data-name", newName);
        var title = copy.querySelector(".pname");
        if (title) title.textContent = newName;
        card.parentElement.insertBefore(copy, card.nextSibling);
        apply();
      } else if (act === "delete") {
        deleting = card;
        deleteName.textContent = name;
        deleteDlg.classList.add("on");
      } else if (act === "bind") {
        binding = card;
        bindShow = "";
        bindConfirm.disabled = true;
        qsa(".bind-opt", bindList).forEach(function (o) { o.classList.remove("on"); });
        bindDlg.classList.add("on");
      }
    }

    if (grid) {
      grid.addEventListener("click", function (e) {
        var more = e.target.closest(".pmore");
        if (more) {
          e.preventDefault();
          e.stopPropagation();
          var menu = more.parentElement.querySelector(".pmenu");
          var willOpen = !menu.classList.contains("on");
          closeMenus();
          menu.classList.toggle("on", willOpen);
          more.classList.toggle("on", willOpen);
          return;
        }
        var item = e.target.closest(".pmenu-item");
        if (item) {
          e.preventDefault();
          e.stopPropagation();
          var card = item.closest(".pcard");
          closeMenus();
          runAction(item.getAttribute("data-act"), card);
        }
      });
    }

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".pmenu") && !e.target.closest(".pmore")) closeMenus();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenus();
    });

    if (renameInput) {
      renameInput.addEventListener("input", function () {
        var v = renameInput.value.trim();
        var old = editing ? (editing.getAttribute("data-name") || "") : "";
        renameConfirm.disabled = !v || v === old;
      });
      renameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !renameConfirm.disabled) renameConfirm.click();
      });
    }

    if (renameConfirm) {
      renameConfirm.addEventListener("click", function () {
        if (!editing) return;
        var v = renameInput.value.trim();
        if (!v) return;
        editing.setAttribute("data-name", v);
        var title = editing.querySelector(".pname");
        if (title) title.textContent = v;
        renameDlg.classList.remove("on");
        editing = null;
        apply();
      });
    }

    if (deleteConfirm) {
      deleteConfirm.addEventListener("click", function () {
        if (!deleting) return;
        deleting.remove();
        deleting = null;
        deleteDlg.classList.remove("on");
        apply();
      });
    }

    if (bindList) {
      bindList.addEventListener("click", function (e) {
        var opt = e.target.closest(".bind-opt");
        if (!opt) return;
        qsa(".bind-opt", bindList).forEach(function (o) { o.classList.toggle("on", o === opt); });
        bindShow = opt.getAttribute("data-show") || "";
        bindConfirm.disabled = !bindShow;
      });
    }

    if (bindConfirm) {
      bindConfirm.addEventListener("click", function () {
        if (!binding || !bindShow) return;
        var meta = binding.querySelector(".pmeta");
        if (meta) {
          var tag = meta.querySelector(".pshow");
          if (!tag) {
            var dot = document.createElement("i");
            dot.textContent = "●";
            tag = document.createElement("span");
            tag.className = "pshow";
            meta.appendChild(dot);
            meta.appendChild(tag);
          }
          tag.textContent = "《" + bindShow + "》";
        }
        bindDlg.classList.remove("on");
        ptToast("已关联到《" + bindShow + "》");
        binding = null;
        bindShow = "";
      });
    }

    if (input) input.addEventListener("input", apply);

    var viewBtns = qsa(".seg-view button");
    viewBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        var list = b.getAttribute("data-view") === "list";
        viewBtns.forEach(function (x) { x.classList.toggle("on", x === b); });
        closeMenus();
        if (grid) grid.classList.toggle("list", list);
      });
    });

    /* ?empty=1：直接预览「还没有项目」空态 */
    if (/[?&]empty=1/.test(location.search)) cards().forEach(function (c) { c.remove(); });

    apply();
  }

  /* ---------- 顶栏通知浮层 ---------- */
  function initNotif() {
    var main = qs(".main");
    var bell = qs("#ntBell");
    var panel = qs("#ntPanel");
    var mask = qs("#ntMask");
    var body = qs("#ntBody");
    var badge = qs("#ntBadge");
    var unreadLabel = qs("#ntUnread");
    var readAll = qs("#ntReadAll");
    var clearAll = qs("#ntClear");
    var closeBtn = qs("#ntClose");
    var emptyEl = qs("#ntEmpty");
    if (!bell || !panel || !body) return;

    function items() { return qsa(".nt-item", body); }
    function unread() { return items().filter(function (i) { return i.classList.contains("unread"); }); }

    function sync() {
      var n = unread().length;
      var total = items().length;
      if (badge) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.hidden = n === 0;
      }
      if (unreadLabel) {
        unreadLabel.textContent = n + " 条未读";
        unreadLabel.hidden = n === 0;
      }
      if (readAll) readAll.hidden = n === 0;
      if (clearAll) clearAll.hidden = total === 0;
      if (emptyEl) emptyEl.hidden = total > 0;
    }

    /* 面板挂在 .main 内，用铃铛位置反算，缩放窗口也贴齐 */
    function place() {
      if (!main) return;
      var mr = main.getBoundingClientRect();
      var br = bell.getBoundingClientRect();
      panel.style.right = Math.max(8, Math.round(mr.right - br.right)) + "px";
      panel.style.top = Math.round(br.bottom - mr.top + 6) + "px";
    }

    function open() {
      panel.classList.add("on");
      mask.classList.add("on");
      bell.classList.add("on");
      place();
    }

    function close() {
      panel.classList.remove("on");
      mask.classList.remove("on");
      bell.classList.remove("on");
    }

    bell.addEventListener("click", function () {
      if (panel.classList.contains("on")) close(); else open();
    });
    if (mask) mask.addEventListener("click", close);
    if (closeBtn) closeBtn.addEventListener("click", close);

    if (readAll) {
      readAll.addEventListener("click", function () {
        items().forEach(function (i) { i.classList.remove("unread"); i.classList.add("read"); });
        sync();
      });
    }

    if (clearAll) {
      clearAll.addEventListener("click", function () {
        items().forEach(function (i) { i.remove(); });
        sync();
      });
    }

    body.addEventListener("click", function (e) {
      var del = e.target.closest(".nt-x");
      if (del) {
        e.stopPropagation();
        var row = del.closest(".nt-item");
        if (row) row.remove();
        sync();
        return;
      }
      if (e.target.closest(".nt-act")) return;
      var item = e.target.closest(".nt-item");
      if (item && item.classList.contains("unread")) {
        item.classList.remove("unread");
        item.classList.add("read");
        sync();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    window.addEventListener("resize", function () {
      if (panel.classList.contains("on")) place();
    });

    if (/[?&]state=empty/.test(location.search)) {
      items().forEach(function (i) { i.remove(); });
    }
    sync();
    if (/[?&]state=closed/.test(location.search)) close(); else open();
  }

  /* ---------- 子页面：对话框 / 页签 ---------- */
  function initSubpage() {
    qsa("[data-open]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        /* 卡片级触发：点中悬浮操作按钮时让按钮自己处理 */
        if (!el.closest(".show-ops") && e.target.closest(".show-ops")) return;
        var t = qs("#" + el.getAttribute("data-open"));
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        var mode = el.getAttribute("data-mode");
        if (mode) {
          var title = t.querySelector("[data-dlg-title]");
          if (title) title.textContent = mode === "edit" ? "编辑剧集" : "新建剧集";
          var save = t.querySelector("[data-dlg-save]");
          if (save) save.textContent = mode === "edit" ? "保存" : "创建";
          var name = t.querySelector("#showEditName");
          if (name) name.value = mode === "edit" ? (el.getAttribute("data-name") || "") : "";
        }
        t.classList.add("on");
      });
    });

    qsa("[data-close]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var m = el.closest(".dlg-mask");
        if (m) m.classList.remove("on");
      });
    });

    qsa(".dlg-mask").forEach(function (m) {
      m.addEventListener("click", function (e) {
        if (e.target === m) m.classList.remove("on");
      });
    });

    qsa("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = b.getAttribute("data-tab");
        qsa("[data-tab]").forEach(function (x) { x.classList.toggle("on", x === b); });
        qsa("[data-tabpanel]").forEach(function (p) {
          p.style.display = p.getAttribute("data-tabpanel") === key ? "" : "none";
        });
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      qsa(".dlg-mask").forEach(function (m) { m.classList.remove("on"); });
    });

    /* 便于逐页验收：?open=<对话框 id> / ?tab=<页签 key> 直接展开目标状态 */
    var m = /[?&]open=([\w-]+)/.exec(location.search);
    if (m) {
      var d = qs("#" + m[1]);
      if (d) d.classList.add("on");
    }
    var t = /[?&]tab=([\w-]+)/.exec(location.search);
    if (t) {
      var btn = qs('[data-tab="' + t[1] + '"]');
      if (btn) btn.click();
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    /* 原型内的占位点击统一给轻提示 */
    qsa("[data-toast]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
        window.ptToast(el.getAttribute("data-toast"));
      });
    });

    /* 登录 / 注册弹窗：侧栏未登录用户区、登录按钮就地打开；已登录则进账户设置 */
    qsa("[data-auth]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        if (getAuthUser()) { goAccount(); return; }
        ptAuth(el.getAttribute("data-auth"));
      });
    });
    qsa(".user-card").forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (!getAuthUser()) return;
        if (e.target.closest(".vip-chip") || e.target.closest(".btn-logout")) return;
        goAccount();
      });
    });
    applyAuthState();
    /* 深链：?auth=login / ?auth=register */
    var authMatch = /[?&]auth=(login|register)/.exec(location.search);
    if (authMatch) ptAuth(authMatch[1]);

    initPtFlows();
    initModelConfig();
    initHealthDetail();
    initTaskCenter();

    if (document.body.hasAttribute("data-editor")) initEditor();
    if (document.body.hasAttribute("data-home")) initHome();
    if (document.body.hasAttribute("data-notif")) initNotif();
    if (document.body.hasAttribute("data-sub")) initSubpage();

    /* 列表空态：?empty=1 预览；删除卡片后由 syncListEmpty 兜底 */
    if (/[?&]empty=1/.test(location.search)) {
      qsa(".show-card, .chr-card").forEach(function (c) { c.remove(); });
    }
    syncListEmpty();
    initSkeleton();
  });
})();
