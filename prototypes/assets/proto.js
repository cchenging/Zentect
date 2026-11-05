/* Zentect 原型交互（无依赖，仅用于演示） */
(function () {
  "use strict";

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- 抽屉 ---------- */
  qsa("[data-drawer-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = qs(btn.getAttribute("data-drawer-open"));
      var overlay = qs(btn.getAttribute("data-overlay") || "#overlay");
      if (target) target.classList.add("show");
      if (overlay) overlay.classList.add("show");
    });
  });
  function closeDrawer(el) {
    if (el) el.classList.remove("show");
    var overlay = qs("#overlay");
    if (overlay) overlay.classList.remove("show");
  }
  qsa("[data-drawer-close]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeDrawer(qs(btn.getAttribute("data-drawer-close")) || btn.closest(".drawer"));
    });
  });
  qsa(".overlay").forEach(function (ov) {
    ov.addEventListener("click", function () {
      qsa(".drawer.show").forEach(function (d) { d.classList.remove("show"); });
      qsa(".modal.show").forEach(function (m) { m.classList.remove("show"); });
      ov.classList.remove("show");
    });
  });

  /* ---------- 弹层 ---------- */
  qsa("[data-modal-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = qs(btn.getAttribute("data-modal-open"));
      var overlay = qs(btn.getAttribute("data-overlay") || "#overlay");
      if (target) target.classList.add("show");
      if (overlay) overlay.classList.add("show");
    });
  });
  qsa("[data-modal-close]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = qs(btn.getAttribute("data-modal-close"));
      if (target) target.classList.remove("show");
      var overlay = qs("#overlay");
      if (overlay) overlay.classList.remove("show");
    });
  });

  /* ---------- 一键成片向导 ---------- */
  var wizard = qs("#wizard");
  if (wizard) {
    var screens = qsa(".wizard-screen", wizard);
    var stepEls = qsa(".stepper .step", wizard);
    var current = 0;

    function renderWizard() {
      screens.forEach(function (s, i) { s.classList.toggle("active", i === current); });
      stepEls.forEach(function (s, i) {
        s.classList.toggle("active", i === current);
        s.classList.toggle("done", i < current);
      });
      var back = qs("[data-wizard-back]", wizard);
      var next = qs("[data-wizard-next]", wizard);
      if (back) back.style.visibility = current === 0 ? "hidden" : "visible";
      if (next && current === screens.length - 1) {
        next.innerHTML = "开始生成";
      }
    }

    qsa("[data-wizard-next]", wizard).forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (current < screens.length - 1) {
          current += 1;
          renderWizard();
        } else {
          btn.disabled = true;
          btn.textContent = "已开始生成（原型演示）";
        }
      });
    });
    qsa("[data-wizard-back]", wizard).forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (current > 0) { current -= 1; renderWizard(); }
      });
    });

    // 配方选中
    qsa(".preset", wizard).forEach(function (card) {
      card.addEventListener("click", function () {
        qsa(".preset", wizard).forEach(function (c) { c.classList.remove("selected"); });
        card.classList.add("selected");
      });
    });

    // 分段控件
    qsa(".segmented", wizard).forEach(function (group) {
      qsa(".seg", group).forEach(function (seg) {
        seg.addEventListener("click", function () {
          qsa(".seg", group).forEach(function (s) { s.classList.remove("active"); });
          seg.classList.add("active");
        });
      });
    });

    renderWizard();
  }

  /* ---------- 通用分段控件 ---------- */
  qsa(".segmented").forEach(function (group) {
    if (group.closest("#wizard")) return;
    qsa(".seg", group).forEach(function (seg) {
      seg.addEventListener("click", function () {
        qsa(".seg", group).forEach(function (s) { s.classList.remove("active"); });
        seg.classList.add("active");
      });
    });
  });

  /* ---------- 开关 ---------- */
  qsa(".switch").forEach(function (sw) {
    sw.addEventListener("click", function () { sw.classList.toggle("on"); });
  });

  /* ---------- 折叠子步骤 ---------- */
  qsa(".substep-head").forEach(function (head) {
    head.addEventListener("click", function (e) {
      if (e.target.closest(".js-gear")) return;
      var row = head.closest(".substep");
      if (row) row.classList.toggle("open");
    });
  });

  /* ---------- Tab ---------- */
  qsa("[data-tab-group]").forEach(function (group) {
    var tabs = qsa("[data-tab]", group);
    var panels = qsa("[data-tab-panel]", group);
    function select(key) {
      tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === key); });
      panels.forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-tab-panel") === key); });
    }
    tabs.forEach(function (t) {
      t.addEventListener("click", function () { select(t.getAttribute("data-tab")); });
    });
  });

  /* ---------- 演示提示 ---------- */
  var toastTimer = null;
  window.protoToast = function (text) {
    var toast = qs("#proto-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "proto-toast";
      toast.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;padding:10px 16px;border-radius:10px;background:rgba(20,20,40,.95);border:1px solid rgba(99,102,241,.4);box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12px;color:#e8e8f0;opacity:0;transition:opacity .2s ease;pointer-events:none;";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.style.opacity = "0"; }, 2200);
  };

  qsa("[data-toast]").forEach(function (el) {
    el.addEventListener("click", function () { window.protoToast(el.getAttribute("data-toast")); });
  });

  /* ---------- 波形（纯 CSS 柱，按固定序列生成，避免随机） ---------- */
  qsa("[data-wave]").forEach(function (wave) {
    var count = parseInt(wave.getAttribute("data-wave"), 10) || 26;
    var seq = [6, 11, 16, 21, 13, 8, 18, 23, 9, 14, 20, 7, 12, 17, 22, 10, 15, 19];
    for (var i = 0; i < count; i++) {
      var bar = document.createElement("i");
      bar.style.height = seq[i % seq.length] + "px";
      if (i % 6 === 0) bar.className = "hi";
      wave.appendChild(bar);
    }
  });
})();
