/* ============================================================
   Zentect 原型 · 统一导航层（nav.js）
   目的：页面之间的跳转只在一处登记，不再散落在各页 href 里

   用法
   1) 页面内纯跳转：<a class="sb-item" data-go="characters">…</a>
   2) 带状态：<a data-go="editor:wizard">…</a> / data-go="settings:ai"
   3) 脚本内跳转：PT_NAV.go("editor:export")

   新增页面时只改下面的 ROUTES；scripts/check-prototypes.mjs 会校验
   所有 data-go 都能解析，避免出现点不动的按钮。

   注意：原型控制条 .pt-bar 的快捷跳转刻意保留原 href，
   它是脱离本文件的应急入口（nav.js 失效时仍可用）。
   ============================================================ */
(function () {
  "use strict";

  var ROUTES = {
    home: "./home.html",
    characters: "./characters.html",
    shows: "./shows.html",
    notifications: "./notifications.html",
    settings: "./settings.html",
    "settings:general": "./settings.html?tab=general",
    "settings:ai": "./settings.html?tab=ai",
    "settings:model": "./settings.html?tab=model",
    "settings:health": "./settings.html?tab=health",
    "settings:account": "./settings.html?tab=account",
    auth: "./home.html?auth=login",
    "auth:register": "./home.html?auth=register",

    editor: "./editor.html?step=1",
    "editor:step1": "./editor.html?step=1",
    "editor:step2": "./editor.html?step=2",
    "editor:step3": "./editor.html?step=3",
    "editor:step3script": "./editor.html?step=3&view=script",
    "editor:step4": "./editor.html?step=4",
    "editor:step5": "./editor.html?step=5",
    "editor:wizard": "./editor.html?s=wizard",
    "editor:export": "./editor.html?s=export"
  };

  function url(key) {
    return Object.prototype.hasOwnProperty.call(ROUTES, key) ? ROUTES[key] : null;
  }

  function go(key) {
    var u = url(key);
    if (!u) {
      console.warn("[nav] 未登记的路由：" + key);
      return;
    }
    location.href = u;
  }

  window.PT_NAV = { routes: ROUTES, url: url, go: go };

  function enhance() {
    var nodes = document.querySelectorAll("[data-go]");
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute("data-go");
      var u = url(key);
      if (!u) {
        console.warn("[nav] 未登记的路由：" + key);
        return;
      }
      // 锚点运行时补 href：保留悬停显示的地址与「新窗口打开」能力
      if (el.tagName === "A" && !el.getAttribute("href")) el.setAttribute("href", u);
    });

    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-go]") : null;
      if (!el || el.tagName === "A") return; // 锚点交给浏览器默认行为
      e.preventDefault();
      go(el.getAttribute("data-go"));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhance);
  } else {
    enhance();
  }
})();
