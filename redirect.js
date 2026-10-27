(function () {
  "use strict";

  // 自動で遷移してよい遷移先（記事リンクの実分布に基づく許可リスト）。
  // これ以外のURLは自動遷移せず、確認画面でクリックを求める（オープンリダイレクト悪用対策）。
  var ALLOWED_HOSTS    = ["news.google.com", "jiji.com", "nhk.or.jp"];
  var ALLOWED_SUFFIXES = [".go.jp", ".lg.jp"];   // 政府・自治体（取得者が公的機関に限られるドメイン）

  function isAllowedHost(host) {
    host = host.toLowerCase();
    for (var i = 0; i < ALLOWED_HOSTS.length; i++) {
      var h = ALLOWED_HOSTS[i];
      if (host === h || host.endsWith("." + h)) return true;
    }
    for (var j = 0; j < ALLOWED_SUFFIXES.length; j++) {
      if (host.endsWith(ALLOWED_SUFFIXES[j])) return true;
    }
    return false;
  }

  var titleEl = document.getElementById("title");
  var msgEl   = document.getElementById("msg");
  var btn     = document.getElementById("btn");
  var urlText = document.getElementById("urlText");
  var copyBtn = document.getElementById("copyBtn");

  // 文字列の前方一致ではなく URL として解析する（userinfo 偽装 https://good@evil 等を防ぐ）
  var raw = new URLSearchParams(location.search).get("url") || "";
  var target = null;
  try {
    var u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:") target = u;
  } catch (e) {
    target = null;
  }

  if (!target) {
    titleEl.textContent = "リンク先が正しくありません";
    msgEl.textContent   = "このリンクは開けません。";
    urlText.textContent = "（無効なURL）";
    btn.hidden = true;
    copyBtn.hidden = true;
    return;
  }

  var href = target.href;
  btn.href = href;
  urlText.textContent = href;

  if (target.protocol === "https:" && isAllowedHost(target.hostname)) {
    location.replace(href);   // 既知の記事配信元のみ自動遷移
  } else {
    titleEl.textContent = "⚠ 外部サイトへ移動します";
    msgEl.textContent   = "移動先「" + target.hostname + "」は自動では開きません。リンク先を確認のうえボタンを押してください。";
  }

  copyBtn.addEventListener("click", function () {
    navigator.clipboard.writeText(href).then(function () {
      copyBtn.textContent = "コピー完了!";
      setTimeout(function () { copyBtn.textContent = "コピー"; }, 1500);
    });
  });
})();
