(function () {
  const PAGE_SIZE     = 20;   // 1ページに表示するグループ数
  const COOLDOWN_SECS = 10;   // 更新ボタン連打防止（秒）

  // ─── Theme ───────────────────────────────────────────────────────────────
  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const themeBtn = document.getElementById("themeBtn");
  themeBtn.textContent = savedTheme === "dark" ? "☀️" : "🌙";
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    themeBtn.textContent = next === "dark" ? "☀️" : "🌙";
  });

  // ─── カテゴリタブ定義 ─────────────────────────────────────────────────────
  const TABS = [
    { id: "all",    emoji: "📰", label: "すべて"   },
    { id: "トラブル", emoji: "⚠️", label: "トラブル" },
    { id: "制度変更", emoji: "🔴", label: "制度変更" },
    { id: "統計",   emoji: "📊", label: "統計"     },
    { id: "政治",   emoji: "🏛️", label: "政治"     },
    { id: "使い方", emoji: "📖", label: "使い方"   },
    { id: "一般",   emoji: "📄", label: "その他"   },
  ];
  const CAT_EMOJI = Object.fromEntries(TABS.map(t => [t.id, t.emoji]));

  let activeTab = "all";

  // ─── トピック分類（マイナ保険証関連 / マイナンバー全般） ───────────────────
  // PJTの関心はマイナ保険証関連が高いため、初期表示は insurance に絞る
  const INSURANCE_KW = [
    "保険証", "資格確認書", "オンライン資格確認", "オン資", "被保険者証",
    "電子処方箋", "レセプト", "医療機関", "受診", "診療", "窓口負担",
    "健康保険", "医療DX", "マイナ保険証", "医療費", "薬剤情報",
  ];
  function classifyTopic(a) {
    if (a.topic) return a.topic;            // サーバ側で分類済みならそれを優先
    const text = (a.title || "") + " " + (a.description || "");
    return INSURANCE_KW.some(kw => text.includes(kw)) ? "insurance" : "mynumber";
  }
  let activeTopic = "insurance";            // 初期表示：マイナ保険証関連
  function topicArticles() {
    if (activeTopic === "all") return allArticles;
    return allArticles.filter(a => classifyTopic(a) === activeTopic);
  }

  function renderTabs() {
    const wrap = document.getElementById("tabsContainer");
    if (!wrap) return;
    // カテゴリ別件数（現在のトピックフィルタ内で集計）
    const base = topicArticles();
    const counts = { all: base.length };
    base.forEach(a => {
      const c = a.category || "一般";
      counts[c] = (counts[c] || 0) + 1;
    });
    wrap.innerHTML = TABS
      .filter(t => t.id === "all" || (counts[t.id] || 0) > 0)
      .map(t => `
        <button class="tab-btn${activeTab === t.id ? " active" : ""}" data-tab="${t.id}">
          ${t.emoji} ${t.label}
          <span class="tab-count">${counts[t.id] || 0}</span>
        </button>`).join("");
    wrap.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        currentPage = 1;
        renderTabs();
        applyFilters();
      });
    });
  }

  // ─── State ───────────────────────────────────────────────────────────────
  let allArticles      = [];   // 全件
  let filteredGroups   = [];   // フィルタ後のグループ配列
  let currentPage      = 1;    // 現在のページ（1始まり）

  // ─── 既読管理 ─────────────────────────────────────────────────────────────
  const READ_KEY = "myna_read_urls";
  let readSet = new Set();

  function loadReadSet() {
    try { readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]")); }
    catch { readSet = new Set(); }
    document.getElementById("readClearBtn").style.display =
      readSet.size > 0 ? "inline-block" : "none";
  }

  function markRead(url) {
    readSet.add(url);
    const arr = [...readSet].slice(-1000); // 最大1000件保持
    try { localStorage.setItem(READ_KEY, JSON.stringify(arr)); } catch {}
    document.getElementById("readClearBtn").style.display = "inline-block";
  }

  document.getElementById("readClearBtn").addEventListener("click", () => {
    readSet.clear();
    try { localStorage.removeItem(READ_KEY); } catch {}
    document.getElementById("readClearBtn").style.display = "none";
    renderCurrentPage();
  });

  // ─── データ取得 ──────────────────────────────────────────────────────────
  async function loadData(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function init() {
    document.body.dataset.view = "news";  // 初期背景色
    loadReadSet();

    // Step 1: 最新50件（news_latest.json）を先に表示して体感速度を上げる
    const latest = await loadData("news_latest.json");
    if (latest && latest.articles && latest.articles.length > 0) {
      applyData(latest);
    } else {
      // fallback: 直接フル読込
      const data = await loadData("news_data.json");
      if (!data || !data.articles || data.articles.length === 0) {
        showEmpty();
        return;
      }
      applyData(data);
      return;
    }

    // Step 2: バックグラウンドでフルデータを読み込んで差し替え
    setTimeout(async () => {
      const data = await loadData("news_data.json");
      if (data && data.articles && data.articles.length > (latest.articles.length)) {
        applyData(data);
      }
    }, 0);
  }

  function applyData(data) {
    // pub_date 降順（最新が先頭）で並び替え
    allArticles = (data.articles || []).slice().sort((a, b) => {
      const da = a.pub_date ? new Date(a.pub_date).getTime() : 0;
      const db = b.pub_date ? new Date(b.pub_date).getTime() : 0;
      return db - da;
    });

    if (data.updated) {
      document.getElementById("updatedText").textContent =
        "最終更新: " + formatDateJP(new Date(data.updated));
    }

    // 媒体フィルターを再構築
    const srcSel = document.getElementById("sourceFilter");
    const prevVal = srcSel.value;
    while (srcSel.options.length > 1) srcSel.remove(1);
    const sources = [...new Set(allArticles.map(a => a.source).filter(Boolean))].sort();
    sources.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      srcSel.appendChild(opt);
    });
    if ([...srcSel.options].some(o => o.value === prevVal)) srcSel.value = prevVal;

    // ニュースタブのバッジ件数を更新
    const newsBadge = document.getElementById("viewBadgeNews");
    if (newsBadge) newsBadge.textContent = allArticles.length;

    renderTabs();
    applyFilters();
  }

  // ─── グルーピング ─────────────────────────────────────────────────────────
  // 同一内容の記事を束ねる。タイトル先頭30文字（正規化）をキーとして使用。
  function groupArticles(articles) {
    const map = new Map();
    articles.forEach(a => {
      // タイトル先頭30文字で正規化キーを生成
      const key = a.title.slice(0, 30).toLowerCase().replace(/[\s\u3000\u00a0]/g, "");
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(a);
    });
    return Array.from(map.values());
  }

  // ─── フィルタ ─────────────────────────────────────────────────────────────
  function applyFilters() {
    const query  = document.getElementById("searchInput").value.trim().toLowerCase();
    const period = document.getElementById("periodFilter").value;
    const source = document.getElementById("sourceFilter").value;

    const now = new Date();
    const cutoffs = {
      today:   new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      "3days": new Date(now - 3 * 86400000),
      week:    new Date(now - 7 * 86400000),
      month:   new Date(now - 30 * 86400000),
    };
    const cutoff = cutoffs[period] || null;

    const filtered = topicArticles().filter(a => {
      // カテゴリタブフィルタ
      if (activeTab !== "all") {
        const cat = a.category || "一般";
        if (cat !== activeTab) return false;
      }
      if (source !== "all" && a.source !== source) return false;
      if (cutoff) {
        const d = new Date(a.pub_date);
        if (isNaN(d) || d < cutoff) return false;
      }
      if (query) {
        const hay = (a.title + " " + a.description + " " + a.source).toLowerCase();
        return query.split(/\s+/).every(w => hay.includes(w));
      }
      return true;
    });

    filteredGroups = groupArticles(filtered);
    currentPage = 1;
    renderCurrentPage();
  }

  // ─── ページ描画 ────────────────────────────────────────────────────────────
  function renderCurrentPage(scrollToTop = false) {
    const list        = document.getElementById("articleList");
    const period      = document.getElementById("periodFilter").value;
    const topWrap     = document.getElementById("paginationTop");
    const bottomWrap  = document.getElementById("paginationBottom");
    const totalGroups = filteredGroups.length;
    const totalPages  = Math.ceil(totalGroups / PAGE_SIZE);

    if (totalGroups === 0) {
      list.innerHTML = `<div class="empty-state">
        <h2>該当する記事が見つかりません</h2>
        <p>「直近1週間」に切り替えるか、<code>python fetch_news.py</code> を実行して最新記事を取得してください。</p>
      </div>`;
      topWrap.style.display    = "none";
      bottomWrap.style.display = "none";
      updateStats(0, 0);
      return;
    }


    // ── ページスライス ──
    const start = (currentPage - 1) * PAGE_SIZE;
    const end   = Math.min(start + PAGE_SIZE, totalGroups);
    const slice = filteredGroups.slice(start, end);

    // ── 記事リスト描画 ──
    const now          = new Date();
    const newThreshold = new Date(now - 24 * 3600000);
    list.innerHTML     = "";

    slice.forEach((group, groupIdx) => {
      const main     = group[0];
      const dups     = group.slice(1);
      const pubDate  = new Date(main.pub_date);
      const isNew    = !isNaN(pubDate) && pubDate > newThreshold;
      const dateStr  = isNaN(pubDate) ? "" : formatDateJP(pubDate);
      const uid      = `acc-${start + groupIdx}`;
      const isRead   = readSet.has(main.link);

      const card = document.createElement("div");
      card.className = "card" + (isRead ? " card--read" : "");

      const articleHref = "redirect.html?url=" + encodeURIComponent(main.link);

      // アコーディオン部分（同内容記事がある場合のみ）
      let dupHtml = "";
      if (dups.length > 0) {
        const dupItems = dups.map(d => {
          const dDate   = new Date(d.pub_date);
          const dDateStr = isNaN(dDate) ? "" : formatDateJP(dDate);
          const dHref   = "redirect.html?url=" + encodeURIComponent(d.link);
          return `
            <div class="accordion-item">
              <a href="${escHtml(dHref)}" target="_blank" rel="noopener noreferrer">${escHtml(d.title)}</a>
              <div class="accordion-item-meta">
                ${d.source ? `<span>${escHtml(d.source)}</span>` : ""}
                ${dDateStr  ? `<span>${dDateStr}</span>` : ""}
              </div>
            </div>`;
        }).join("");

        dupHtml = `
          <div class="accordion-body" id="${uid}">
            <div class="accordion-label">同内容の他記事</div>
            ${dupItems}
          </div>`;
      }

      card.innerHTML = `
        <div class="card-body">
          <div class="card-title">
            <a href="${escHtml(articleHref)}" target="_blank" rel="noopener noreferrer">
              ${escHtml(main.title)}
            </a>
          </div>
          ${main.description ? `<div class="card-desc">${escHtml(main.description)}</div>` : ""}
          <div class="card-footer">
            ${main.source ? `<span class="source-tag">${escHtml(main.source)}</span>` : ""}
            ${dateStr      ? `<span class="date-text">${dateStr}</span>` : ""}
            ${isNew        ? `<span class="new-badge">NEW</span>` : ""}
            ${(main.category && main.category !== "一般")
              ? `<span class="cat-tag cat-${escHtml(main.category)}">${CAT_EMOJI[main.category] || ""}${escHtml(main.category)}</span>`
              : ""}
            ${classifyTopic(main) === "insurance"
              ? `<span class="topic-tag topic-insurance">🩺 保険証</span>`
              : `<span class="topic-tag topic-mynumber">💳 マイナンバー</span>`}
            ${dups.length > 0
              ? `<button class="dup-badge" data-action="toggle-accordion" data-target="${escHtml(uid)}" aria-expanded="false">
                   同内容 ${dups.length + 1}件
                   <i class="dup-arrow">▼</i>
                 </button>`
              : ""}
            <button class="share-btn" title="記事URLと要約をコピー">📤 シェア</button>
          </div>
          ${dupHtml}
        </div>
        ${isHttpUrl(main.thumbnail) ? `<img class="card-thumb" src="${escHtml(main.thumbnail)}" alt="" loading="lazy">` : ""}`;

      // サムネイル読み込み失敗時は非表示
      const thumbEl = card.querySelector(".card-thumb");
      if (thumbEl) thumbEl.addEventListener("error", () => { thumbEl.style.display = "none"; });

      // タイトルリンクをクリックしたら既読マーク
      const titleLink = card.querySelector(".card-title a");
      if (titleLink) {
        titleLink.addEventListener("click", () => {
          markRead(main.link);
          card.classList.add("card--read");
        });
      }

      // アコーディオン内リンクも既読マーク
      card.querySelectorAll(".accordion-item a").forEach(a => {
        a.addEventListener("click", () => {
          const href = new URLSearchParams(new URL(a.href).search).get("url") || a.href;
          markRead(href);
        });
      });

      // シェアボタンにイベントを設定（クロージャでデータをキャプチャ）
      const shareBtn = card.querySelector(".share-btn");
      if (shareBtn) {
        // summary があれば優先、なければ description にフォールバック
        const summaryText = (main.summary || main.description || "").trim();
        shareBtn.addEventListener("click", () => {
          shareArticle(main.title, main.source, dateStr, main.link, summaryText);
        });
      }

      list.appendChild(card);
    });

    // ── ページネーション描画 ──
    const totalArticles = filteredGroups.reduce((s, g) => s + g.length, 0);
    topWrap.style.display    = totalPages > 1 ? "flex" : "none";
    bottomWrap.style.display = totalPages > 1 ? "flex" : "none";
    renderPagination(currentPage, totalPages, totalGroups, start + 1, end, "paginationTop");
    renderPagination(currentPage, totalPages, totalGroups, start + 1, end, "paginationBottom");

    updateStats(totalGroups, totalArticles);

    // ページ送り時のみリスト上部へスクロール（初回ロード・タブ切替・フィルタ時はしない）
    if (scrollToTop) {
      document.getElementById("paginationTop").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ─── ページネーションHTML生成 ─────────────────────────────────────────────
  function renderPagination(current, total, totalGroups, rangeFrom, rangeTo, containerId) {
    const wrap = document.getElementById(containerId);
    wrap.innerHTML = "";

    // 件数情報
    const info = document.createElement("div");
    info.className = "pagination-info";
    info.textContent = `${rangeFrom}〜${rangeTo}グループ / 全 ${totalGroups} グループ`;
    wrap.appendChild(info);

    if (total <= 1) return;

    // ボタン群
    const btns = document.createElement("div");
    btns.className = "pagination-btns";

    // 前へ
    btns.appendChild(makePageBtn("‹ 前へ", current - 1, current <= 1));

    // ページ番号（エリプシス付き）
    const pages = calcPageRange(current, total);
    pages.forEach(p => {
      if (p === "…") {
        const el = document.createElement("span");
        el.className = "page-ellipsis";
        el.textContent = "…";
        btns.appendChild(el);
      } else {
        const btn = makePageBtn(String(p), p, false);
        if (p === current) btn.classList.add("active");
        btns.appendChild(btn);
      }
    });

    // 次へ
    btns.appendChild(makePageBtn("次へ ›", current + 1, current >= total));

    wrap.appendChild(btns);
  }

  // 表示するページ番号リストを計算（エリプシスあり）
  function calcPageRange(current, total) {
    if (total <= 9) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [];
    const delta = 2; // 現在ページ前後に表示する数

    const left  = Math.max(2, current - delta);
    const right = Math.min(total - 1, current + delta);

    pages.push(1);
    if (left > 2)      pages.push("…");
    for (let p = left; p <= right; p++) pages.push(p);
    if (right < total - 1) pages.push("…");
    pages.push(total);

    return pages;
  }

  function makePageBtn(label, targetPage, disabled, isDiet) {
    const btn = document.createElement("button");
    btn.className = "page-btn";
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled) {
      btn.addEventListener("click", () => {
        if (isDiet) { dietPage = targetPage; renderDietPage(); }
        else        { goToPage(targetPage); }
      });
    }
    return btn;
  }

  function goToPage(page) {
    const total = Math.ceil(filteredGroups.length / PAGE_SIZE);
    currentPage = Math.max(1, Math.min(page, total));
    renderCurrentPage(true);   // ページ送り時のみ上部へスクロール
  }

  // ─── シェア機能 ──────────────────────────────────────────────────────────
  function shareArticle(title, source, dateStr, link, description) {
    const lines = [];
    lines.push(`📰 ${title}`);
    const meta = [source, dateStr].filter(Boolean).join("  |  ");
    if (meta) lines.push(`📌 ${meta}`);
    lines.push(`🔗 ${link}`);
    const desc = (description || "").trim();
    if (desc) {
      // 文の区切り（。！？）を優先して150文字以内に収める
      const MAX = 150;
      let truncated = desc;
      if (desc.length > MAX) {
        // MAX文字以内で最後の文末句読点を探す
        const cut = desc.slice(0, MAX);
        const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
        truncated = lastPunct > MAX * 0.5
          ? desc.slice(0, lastPunct + 1)   // 句読点で綺麗に切る
          : cut.trimEnd() + "…";           // 句読点がなければ…で締める
      }
      lines.push("");
      lines.push(`📝 要約：${truncated}`);
    }
    const text = lines.join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast("📋 クリップボードにコピーしました！"))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast("📋 コピーしました！");
    } catch {
      showToast("⚠️ コピーに失敗しました");
    }
    document.body.removeChild(ta);
  }

  function showToast(msg) {
    let toast = document.getElementById("shareToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "shareToast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    // リセットしてから表示（連続クリック対応）
    toast.classList.remove("show");
    requestAnimationFrame(() => {
      toast.classList.add("show");
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => toast.classList.remove("show"), 2200);
    });
  }

  // ─── アコーディオン ───────────────────────────────────────────────────────
  function toggleAccordion(uid, btn) {
    const body = document.getElementById(uid);
    if (!body) return;
    const isOpen = body.classList.toggle("open");
    btn.classList.toggle("open", isOpen);
    btn.setAttribute("aria-expanded", String(isOpen));
  };

  // ─── Stats ──────────────────────────────────────────────────────────────
  function updateStats(groupCount, articleCount) {
    const total = allArticles.length;
    if (groupCount === 0) {
      document.getElementById("statsText").textContent =
        `該当なし（全 ${total} 件）`;
    } else if (groupCount === articleCount) {
      document.getElementById("statsText").textContent =
        `${groupCount} 件（全 ${total} 件）`;
    } else {
      document.getElementById("statsText").textContent =
        `${groupCount} グループ・${articleCount} 件（全 ${total} 件）`;
    }
  }

  // ─── 更新ボタン（クールダウン付き） ─────────────────────────────────────
  const refreshBtn = document.getElementById("refreshBtn");
  let cdTimer = null;

  function startCooldown() {
    let remaining = COOLDOWN_SECS;
    refreshBtn.disabled = true;

    let bar = refreshBtn.querySelector(".cd-bar");
    if (!bar) {
      bar = document.createElement("span");
      bar.className = "cd-bar";
      refreshBtn.appendChild(bar);
    }
    bar.style.width = "100%";

    cdTimer = setInterval(() => {
      remaining--;
      bar.style.width = `${(remaining / COOLDOWN_SECS) * 100}%`;
      if (remaining <= 0) {
        clearInterval(cdTimer);
        cdTimer = null;
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = "↻ データ再読込";
      } else {
        refreshBtn.innerHTML =
          `<span class="cd-bar" style="width:${(remaining / COOLDOWN_SECS) * 100}%"></span>` +
          `↻ 更新 (${remaining}秒)`;
      }
    }, 1000);
  }

  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.innerHTML = `<span class="btn-spinner"></span>読込中`;
    refreshBtn.disabled = true;
    const data = await loadData("news_data.json");
    if (data && data.articles) {
      applyData(data);
    }
    startCooldown();
  });

  // ─── イベント（ニュース） ─────────────────────────────────────────────────
  document.getElementById("searchInput").addEventListener("input",  applyFilters);
  document.getElementById("periodFilter").addEventListener("change", applyFilters);
  document.getElementById("sourceFilter").addEventListener("change", applyFilters);

  // トピックフィルタ（マイナ保険証関連 / マイナンバー全般 / すべて）
  document.querySelectorAll("#topicFilter .topic-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#topicFilter .topic-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeTopic = btn.dataset.topic;
      activeTab   = "all";   // トピック切替時はカテゴリをリセット
      currentPage = 1;
      renderTabs();
      applyFilters();
    });
  });

  // ─── イベント（国会質疑） ─────────────────────────────────────────────────
  document.getElementById("dietSearchInput").addEventListener("input",  applyDietFilters);
  document.getElementById("dietHouseFilter").addEventListener("change", applyDietFilters);
  document.getElementById("dietMeetingFilter").addEventListener("change", applyDietFilters);
  document.getElementById("dietTypeFilter").addEventListener("change",   applyDietFilters);

  // ─── ユーティリティ ───────────────────────────────────────────────────────
  function showEmpty() {
    document.getElementById("articleList").innerHTML = `
      <div class="empty-state">
        <h2>📰 ニュースデータがまだありません</h2>
        <p>
          以下のコマンドを実行してニュースを取得してください：<br><br>
          <code>python fetch_news.py</code><br><br>
          または <code>run_daily.bat</code> をダブルクリックしてください。<br>
          取得後、このページを再読み込みすると記事が表示されます。
        </p>
      </div>`;
    document.getElementById("statsText").textContent = "データなし";
  }

  function formatDateJP(d) {
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dy = String(d.getDate()).padStart(2, "0");
    const h  = String(d.getHours()).padStart(2, "0");
    const m  = String(d.getMinutes()).padStart(2, "0");
    return `${y}/${mo}/${dy} ${h}:${m}`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // href / src に入れる外部URLは http(s) のみ許可（javascript: などのスキームを無害化）。
  // ※escHtml は属性の脱出は防げるが URL スキームは検証しないため併用する。
  function isHttpUrl(u) {
    return /^https?:\/\//i.test(String(u || "").trim());
  }
  function safeUrl(u) {
    return isHttpUrl(u) ? String(u).trim() : "#";
  }

  // ─── トップへ戻るボタン ───────────────────────────────────────────────────
  const backTopBtn = document.getElementById("backTopBtn");
  window.addEventListener("scroll", () => {
    backTopBtn.classList.toggle("show", window.scrollY > 300);
  }, { passive: true });
  backTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ─── ビュー切替 ───────────────────────────────────────────────────────────
  let activeView  = "news";
  let dietLoaded  = false;
  let statsLoaded  = false;
  let trendsLoaded = false;

  function switchView(view) {
    activeView = view;
    document.body.dataset.view = view;
    document.querySelectorAll(".view-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    document.getElementById("newsSection").style.display   = view === "news"   ? "" : "none";
    document.getElementById("dietSection").style.display   = view === "diet"   ? "" : "none";
    document.getElementById("statsSection").style.display  = view === "stats"  ? "" : "none";
    document.getElementById("trendsSection").style.display = view === "trends" ? "" : "none";
    if (view === "diet" && !dietLoaded) {
      dietLoaded = true;
      loadDiet();
    }
    if (view === "stats" && !statsLoaded) {
      statsLoaded = true;
      loadStats();
    }
    if (view === "trends" && !trendsLoaded) {
      trendsLoaded = true;
      loadTrends();
    }
  }

  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // ─── 国会質疑 ─────────────────────────────────────────────────────────────
  const DIET_PAGE_SIZE = 20;
  let dietExchanges  = [];   // 全件
  let dietFiltered   = [];   // フィルタ後
  let dietPage       = 1;
  // speechID → full_text のキャッシュ
  const dietFullTextCache = {};

  async function loadDiet() {
    try {
      const res = await fetch("diet_data.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      dietExchanges = data.exchanges || [];
      renderDiet(data);
    } catch (e) {
      document.getElementById("dietList").innerHTML = `
        <div class="empty-state">
          <h2>🏛️ 国会質疑データがありません</h2>
          <p><code>python fetch_diet.py</code> を実行してデータを取得してください。</p>
        </div>`;
      document.getElementById("dietStatsText").textContent = "データなし";
    }
  }

  function renderDiet(data) {
    const statsEl   = document.getElementById("dietStatsText");
    const updatedEl = document.getElementById("dietUpdatedText");
    const badgeEl   = document.getElementById("viewBadgeDiet");
    const meetingSel = document.getElementById("dietMeetingFilter");

    if (data.updated) {
      updatedEl.textContent = "最終更新: " + formatDateJP(new Date(data.updated));
    }

    if (!dietExchanges.length) {
      statsEl.textContent = "該当する質疑がありません";
      document.getElementById("dietList").innerHTML =
        `<div class="empty-state"><h2>該当する国会質疑が見つかりません</h2></div>`;
      return;
    }

    // 委員会フィルタを動的構築
    const meetings = [...new Set(
      dietExchanges.map(e => e.nameOfMeeting).filter(Boolean)
    )].sort();
    while (meetingSel.options.length > 1) meetingSel.remove(1);
    meetings.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      meetingSel.appendChild(opt);
    });

    const totalEx = data.total_exchanges || dietExchanges.length;
    if (badgeEl) badgeEl.textContent = totalEx;

    applyDietFilters();
  }

  function applyDietFilters() {
    const query   = document.getElementById("dietSearchInput").value.trim().toLowerCase();
    const house   = document.getElementById("dietHouseFilter").value;
    const meeting = document.getElementById("dietMeetingFilter").value;
    const type    = document.getElementById("dietTypeFilter").value;

    dietFiltered = dietExchanges.filter(ex => {
      if (house   !== "all" && ex.nameOfHouse   !== house)   return false;
      if (meeting !== "all" && ex.nameOfMeeting !== meeting) return false;
      if (type === "has_answer" && (!ex.answers || ex.answers.length === 0)) return false;
      if (type === "no_answer"  && ex.answers && ex.answers.length > 0)      return false;
      if (query) {
        const q = ex.question;
        const hay = [
          ex.ai_title || "",
          q?.excerpt || "",
          q?.speaker || "",
          q?.speakerGroup || "",
          ...(ex.answers || []).map(a => a.excerpt + " " + a.speaker),
          ex.nameOfMeeting || "",
        ].join(" ").toLowerCase();
        return query.split(/\s+/).every(w => hay.includes(w));
      }
      return true;
    });

    dietPage = 1;
    renderDietPage();
  }

  function renderDietPage() {
    const list       = document.getElementById("dietList");
    const statsEl    = document.getElementById("dietStatsText");
    const topWrap    = document.getElementById("dietPaginationTop");
    const bottomWrap = document.getElementById("dietPaginationBottom");
    const total      = dietFiltered.length;
    const totalPages = Math.ceil(total / DIET_PAGE_SIZE);

    if (total === 0) {
      list.innerHTML = `<div class="empty-state">
        <h2>該当する国会質疑がありません</h2>
        <p>条件を変えてお試しください。</p>
      </div>`;
      topWrap.style.display    = "none";
      bottomWrap.style.display = "none";
      statsEl.textContent = `0 件（全 ${dietExchanges.length} 件中）`;
      return;
    }

    const start = (dietPage - 1) * DIET_PAGE_SIZE;
    const end   = Math.min(start + DIET_PAGE_SIZE, total);
    const slice = dietFiltered.slice(start, end);

    statsEl.textContent = total === dietExchanges.length
      ? `${total} 件の質疑`
      : `${total} 件（全 ${dietExchanges.length} 件中）`;

    // ── カード描画 ──
    list.innerHTML = slice.map((ex, i) => buildDietCard(ex, start + i)).join("");

    // ── ページネーション ──
    topWrap.style.display    = totalPages > 1 ? "flex" : "none";
    bottomWrap.style.display = totalPages > 1 ? "flex" : "none";
    renderDietPagination(dietPage, totalPages, total, start + 1, end, "dietPaginationTop");
    renderDietPagination(dietPage, totalPages, total, start + 1, end, "dietPaginationBottom");

    if (dietPage > 1) {
      document.getElementById("dietPaginationTop")
        .scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderDietPagination(current, total, totalItems, from, to, cid) {
    const wrap = document.getElementById(cid);
    wrap.innerHTML = "";
    const info = document.createElement("div");
    info.className = "pagination-info";
    info.textContent = `${from}〜${to} 件 / 全 ${totalItems} 件`;
    wrap.appendChild(info);
    if (total <= 1) return;
    const btns = document.createElement("div");
    btns.className = "pagination-btns";
    btns.appendChild(makePageBtn("‹ 前へ", current - 1, current <= 1, true));
    calcPageRange(current, total).forEach(p => {
      if (p === "…") {
        const el = document.createElement("span");
        el.className = "page-ellipsis"; el.textContent = "…";
        btns.appendChild(el);
      } else {
        const btn = makePageBtn(String(p), p, false, true);
        if (p === current) btn.classList.add("active");
        btns.appendChild(btn);
      }
    });
    btns.appendChild(makePageBtn("次へ ›", current + 1, current >= total, true));
    wrap.appendChild(btns);
  }

  // ── 国会質疑カード生成 ───────────────────────────────────────────────────
  function buildDietCard(ex, idx) {
    const q          = ex.question;
    const answers    = ex.answers || [];
    const houseLabel = [ex.nameOfHouse, ex.nameOfMeeting].filter(Boolean).join(" ");
    const sessionStr = ex.session ? `第${ex.session}回国会` : "";
    const dateStr    = ex.date ? ex.date.replace(/-/g, "/") : "";
    const uid        = `dac-${idx}`;
    const hasMin     = !q && answers.length > 0;

    // 表示タイトル: AI生成 > フォールバック
    const getTitle = (speech) =>
      ex.ai_title ||
      (speech ? (speech.excerpt || "（発言内容）") : "（発言内容）");

    // ── 質問ブロック ──
    let mainHtml = "";
    if (q) {
      const pos = q.speakerPosition || q.speakerRole || "";
      mainHtml = `
        <div class="diet-question-title">${escHtml(getTitle(q))}</div>
        <div class="diet-speaker-row">
          <span class="diet-speaker-name">🏛️ ${escHtml(q.speaker || "（不明）")}</span>
          ${q.speakerGroup ? `<span class="diet-party-tag">${escHtml(q.speakerGroup)}</span>` : ""}
          ${pos            ? `<span class="diet-position-text">（${escHtml(pos)}）</span>` : ""}
        </div>
        ${q.excerpt ? `<div class="diet-excerpt">${escHtml(q.excerpt)}</div>` : ""}
        <div class="diet-speech-footer">
          <button class="diet-fulltext-toggle" data-action="toggle-diet-full" data-target="${escHtml(uid)}-q" data-speech-id="${escHtml(q.speechID)}"
                  data-url="${escHtml(safeUrl(q.speechURL))}">
            <i class="ft-arrow">▼</i> 全文を見る
          </button>
          <a class="diet-link-btn-sm" href="${escHtml(safeUrl(q.speechURL))}"
             target="_blank" rel="noopener noreferrer">📜 議事録を開く</a>
        </div>
        <div class="diet-fulltext-wrap" id="${uid}-q">
          <div class="diet-fulltext-body"></div>
        </div>`;
    } else if (answers.length) {
      const a0  = answers[0];
      const pos = a0.speakerPosition || a0.speakerRole || "";
      mainHtml = `
        <div class="diet-question-title diet-answer-only">${escHtml(getTitle(a0))}</div>
        <div class="diet-speaker-row">
          <span class="diet-speaker-name">🏛️ ${escHtml(a0.speaker || "（不明）")}</span>
          ${a0.speakerGroup ? `<span class="diet-party-tag">${escHtml(a0.speakerGroup)}</span>` : ""}
          ${pos             ? `<span class="diet-position-text">（${escHtml(pos)}）</span>` : ""}
          <span class="diet-minister-badge">★ 答弁</span>
        </div>
        ${a0.excerpt ? `<div class="diet-excerpt">${escHtml(a0.excerpt)}</div>` : ""}
        <div class="diet-speech-footer">
          <button class="diet-fulltext-toggle" data-action="toggle-diet-full" data-target="${escHtml(uid)}-a0" data-speech-id="${escHtml(a0.speechID)}"
                  data-url="${escHtml(safeUrl(a0.speechURL))}">
            <i class="ft-arrow">▼</i> 全文を見る
          </button>
          <a class="diet-link-btn-sm" href="${escHtml(safeUrl(a0.speechURL))}"
             target="_blank" rel="noopener noreferrer">📜 議事録を開く</a>
        </div>
        <div class="diet-fulltext-wrap" id="${uid}-a0">
          <div class="diet-fulltext-body"></div>
        </div>`;
    }

    // ── 答弁アコーディオン ──
    const accAnswers = hasMin ? answers.slice(1) : answers;
    let accHtml = "";
    if (accAnswers.length > 0) {
      const ansItems = accAnswers.map((a, ai) => {
        const pos = a.speakerPosition || a.speakerRole || "";
        const aid = `${uid}-ans${ai}`;
        return `
          <div class="diet-answer-item">
            <div class="diet-speaker-row">
              <span class="diet-speaker-name diet-answer-name">
                🏛️ ${escHtml(a.speaker || "（不明）")}
              </span>
              ${a.speakerGroup ? `<span class="diet-party-tag">${escHtml(a.speakerGroup)}</span>` : ""}
              ${pos            ? `<span class="diet-position-text">（${escHtml(pos)}）</span>` : ""}
            </div>
            ${a.excerpt ? `<div class="diet-answer-excerpt">${escHtml(a.excerpt)}</div>` : ""}
            <div class="diet-answer-footer">
              <button class="diet-fulltext-toggle"
                      data-action="toggle-diet-full" data-target="${escHtml(aid)}" data-speech-id="${escHtml(a.speechID)}"
                      data-url="${escHtml(safeUrl(a.speechURL))}">
                <i class="ft-arrow">▼</i> 全文を見る
              </button>
              <a class="diet-link-btn-sm" href="${escHtml(safeUrl(a.speechURL))}"
                 target="_blank" rel="noopener noreferrer">📜 議事録を開く</a>
            </div>
            <div class="diet-fulltext-wrap" id="${aid}">
              <div class="diet-fulltext-body"></div>
            </div>
          </div>`;
      }).join("");

      accHtml = `
        <div class="diet-acc-trigger" data-action="toggle-diet-acc" data-target="${escHtml(uid)}-acc" aria-expanded="false">
          <i class="diet-acc-arrow">▼</i>
          政府答弁を見る
          <span class="diet-acc-count">${accAnswers.length}件</span>
        </div>
        <div class="diet-acc-body" id="${uid}-acc">${ansItems}</div>`;
    } else if (q) {
      accHtml = `<div class="diet-no-answer">答弁は取得されていません</div>`;
    }

    return `
      <div class="diet-card${hasMin ? " is-minister" : ""}">
        <div class="diet-card-header">
          <span class="diet-house-badge${hasMin ? " minister" : ""}">${escHtml(houseLabel || "国会")}</span>
          ${sessionStr ? `<span class="diet-session-text">${escHtml(sessionStr)}</span>` : ""}
          <span class="diet-date-text">${dateStr}</span>
        </div>
        ${mainHtml}
        ${accHtml}
      </div>`;
  }

  // ── アコーディオン（答弁） ───────────────────────────────────────────────
  function toggleDietAcc(uid, trigger) {
    const body = document.getElementById(uid);
    if (!body) return;
    const isOpen = body.classList.toggle("open");
    trigger.classList.toggle("open", isOpen);
    trigger.setAttribute("aria-expanded", String(isOpen));
  };

  // ── 全文展開（NDL API オンデマンド取得） ──────────────────────────────────
  async function toggleDietFullText(wrapId, speechID, btn) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;

    // 開閉トグル
    const isOpen = wrap.classList.toggle("open");
    btn.classList.toggle("open", isOpen);
    if (!isOpen) return;

    const bodyEl = wrap.querySelector(".diet-fulltext-body");
    if (!bodyEl) return;

    // キャッシュにあれば即表示
    if (dietFullTextCache[speechID]) {
      bodyEl.textContent = dietFullTextCache[speechID];
      return;
    }

    // 既にコンテンツがあれば再取得しない
    if (bodyEl.textContent.trim()) return;

    // NDL API からオンデマンド取得
    bodyEl.innerHTML = `<span class="diet-fulltext-loading"><span class="spinner" style="width:14px;height:14px"></span>全文を取得中…</span>`;
    try {
      const url = `https://kokkai.ndl.go.jp/api/speech?speechID=${encodeURIComponent(speechID)}&recordPacking=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records = data.speechRecord || [];
      const text = (records[0] && records[0].speech) ? records[0].speech.trim() : null;
      if (text) {
        dietFullTextCache[speechID] = text;
        bodyEl.textContent = text;
      } else {
        throw new Error("発言テキストが取得できませんでした");
      }
    } catch (e) {
      const fallbackUrl = safeUrl(btn.dataset.url);
      bodyEl.innerHTML = `<span style="color:var(--text-muted);font-size:12px">
        全文の取得に失敗しました。
        <a href="${escHtml(fallbackUrl)}" target="_blank" rel="noopener noreferrer"
           style="color:var(--accent)">議事録サイトでご確認ください →</a>
      </span>`;
    }
  };

  // ─── 統計ダッシュボード ───────────────────────────────────────────────────
  let _chartInstances = {};

  async function loadStats() {
    const inner = document.querySelector("#statsSection .stats-section-inner");
    inner.insertAdjacentHTML("afterbegin",
      `<div id="statsLoading" style="text-align:center;padding:40px 0;color:var(--text-muted)">
         <div class="spinner" style="margin:0 auto 12px"></div>読み込んでいます…
       </div>`
    );

    let data;
    try {
      const res = await fetch("stats_data.json?_=" + Date.now());
      data = await res.json();
    } catch (e) {
      const ld = document.getElementById("statsLoading");
      if (ld) ld.textContent = "統計データの読み込みに失敗しました。";
      return;
    }
    const ld = document.getElementById("statsLoading");
    if (ld) ld.remove();
    renderStats(data);
  }

  function renderStats(data) {
    // 更新日時
    const upEl = document.getElementById("statsUpdated");
    if (data.updated) {
      upEl.textContent = "データ更新: " + data.updated.slice(0, 10);
    }

    const myna  = data.myna_card  || [];
    const kenpo = data.kenpo_reg  || [];

    // ─── ヘルパー ──────────────────────────────────────────────────────────
    // 万単位に変換
    function toMan(n) {
      if (n == null) return "―";
      const man = Math.round(n / 10000);
      return man.toLocaleString() + "万枚";
    }
    // 前月差 (±X.Xpt)
    function momDiff(arr, key) {
      if (arr.length < 2) return null;
      return Math.round((arr[arr.length - 1][key] - arr[arr.length - 2][key]) * 10) / 10;
    }
    function momText(diff, unit) {
      if (diff == null) return "";
      const sign = diff >= 0 ? "+" : "";
      return `${sign}${diff}${unit}`;
    }
    function momClass(diff) {
      return diff == null ? "" : diff >= 0 ? "up" : "down";
    }

    // ─── ① マイナカード ───────────────────────────────────────────────────
    if (myna.length > 0) {
      const latest = myna[myna.length - 1];
      const diff   = momDiff(myna, "rate");

      document.getElementById("kpiMynaRate").textContent = latest.rate + "%";
      document.getElementById("kpiMynaRateMonth").textContent = latest.month + " 時点";

      const momEl1 = document.getElementById("kpiMynaRateMom");
      momEl1.textContent = momText(diff, "pt");
      momEl1.className   = "kpi-mom " + momClass(diff);

      document.getElementById("kpiMynaCumul").textContent = toMan(latest.cumul);
      document.getElementById("kpiMynaCumulMonth").textContent = latest.month + " 時点";

      const momEl2 = document.getElementById("kpiMynaMom");
      momEl2.textContent = momText(diff, "pt");
      momEl2.className   = "kpi-value " + (diff != null && diff >= 0 ? "" : "");
      momEl2.style.color = diff == null ? "" : diff >= 0 ? "#38a169" : "#e53e3e";
    }

    // ─── ② 健保利用登録 ──────────────────────────────────────────────────
    if (kenpo.length > 0) {
      const latest = kenpo[kenpo.length - 1];
      const diff   = momDiff(kenpo, "rate");

      document.getElementById("kpiKenpoRate").textContent = latest.rate + "%";
      document.getElementById("kpiKenpoRateMonth").textContent = latest.month + " 時点";

      const momEl1 = document.getElementById("kpiKenpoRateMom");
      momEl1.textContent = momText(diff, "pt");
      momEl1.className   = "kpi-mom " + momClass(diff);

      const kenpoCumulEl = document.getElementById("kpiKenpoCumul");
      if (latest.cumul != null) {
        const man = Math.round(latest.cumul / 10000);
        kenpoCumulEl.textContent = man.toLocaleString() + "万件";
      }
      document.getElementById("kpiKenpoCumulMonth").textContent = latest.month + " 時点";

      const momEl2 = document.getElementById("kpiKenpoMom");
      momEl2.textContent = momText(diff, "pt");
      momEl2.className   = "kpi-value";
      momEl2.style.color = diff == null ? "" : diff >= 0 ? "#38a169" : "#e53e3e";
    }

    // ─── チャート共通設定 ─────────────────────────────────────────────────
    const isDark     = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor  = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
    const textColor  = isDark ? "#94a3b8" : "#718096";

    Chart.defaults.font.family =
      "'Hiragino Kaku Gothic ProN','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.color     = textColor;

    function lineOpts(unit) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw}${unit}` } },
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 },
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: textColor, callback: v => v + unit },
          },
        },
      };
    }

    // ① マイナカード保有率 折れ線
    _destroyChart("chartMynaRate");
    if (myna.length > 0) {
      const ctx = document.getElementById("chartMynaRate").getContext("2d");
      _chartInstances["chartMynaRate"] = new Chart(ctx, {
        type: "line",
        data: {
          labels: myna.map(m => m.month),
          datasets: [{
            label: "保有率",
            data:  myna.map(m => m.rate),
            borderColor: isDark ? "#60a5fa" : "#2b6cb0",
            backgroundColor: isDark ? "rgba(96,165,250,.13)" : "rgba(43,108,176,.09)",
            borderWidth: 2.5,
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: .3,
            fill: true,
          }]
        },
        options: {
          ...lineOpts("%"),
          scales: {
            ...lineOpts("%").scales,
            y: {
              ...lineOpts("%").scales.y,
              min: Math.max(0, Math.floor(Math.min(...myna.map(m => m.rate)) - 2)),
              max: Math.min(100, Math.ceil(Math.max(...myna.map(m => m.rate)) + 2)),
            },
          },
        },
      });
    }

    // ② 健保利用登録率 折れ線
    _destroyChart("chartKenpoRate");
    if (kenpo.length > 0) {
      const ctx = document.getElementById("chartKenpoRate").getContext("2d");
      _chartInstances["chartKenpoRate"] = new Chart(ctx, {
        type: "line",
        data: {
          labels: kenpo.map(m => m.month),
          datasets: [{
            label: "登録率",
            data:  kenpo.map(m => m.rate),
            borderColor: isDark ? "#34d399" : "#38a169",
            backgroundColor: isDark ? "rgba(52,211,153,.13)" : "rgba(56,161,105,.09)",
            borderWidth: 2.5,
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: .3,
            fill: true,
          }]
        },
        options: {
          ...lineOpts("%"),
          scales: {
            ...lineOpts("%").scales,
            y: {
              ...lineOpts("%").scales.y,
              min: Math.max(0, Math.floor(Math.min(...kenpo.map(m => m.rate)) - 2)),
              max: Math.min(100, Math.ceil(Math.max(...kenpo.map(m => m.rate)) + 2)),
            },
          },
        },
      });
    }
  }

  function _destroyChart(id) {
    if (_chartInstances[id]) {
      _chartInstances[id].destroy();
      delete _chartInstances[id];
    }
  }

  // ─── Googleトレンドダッシュボード ─────────────────────────────────────────
  let _chartTrends    = null;
  let _trendsCooldown = false;
  let _trendsData     = null;
  let _trendsPeriod   = 7;
  let _trendsDateRange = null;

  async function loadTrends(force = false) {
    if (_trendsCooldown && !force) return;
    _trendsCooldown = true;
    setTimeout(() => { _trendsCooldown = false; }, 10000);

    const btn = document.getElementById("trendsRefreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⟳ 更新中…"; }

    let data;
    try {
      const res = await fetch("trends_data.json?_=" + Date.now());
      if (!res.ok) throw new Error("trends_data.json not found");
      data = await res.json();
    } catch(e) {
      document.getElementById("trendsGrid").innerHTML =
        `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted)">
           トレンドデータを読み込めませんでした。<br>
           <small>GitHub Actionsによる初回データ生成をお待ちください。</small>
         </div>`;
      if (btn) { btn.disabled = false; btn.textContent = "⟳ 更新"; }
      return;
    }

    // 更新時刻
    const updEl = document.getElementById("trendsUpdated");
    if (updEl && data.updated) {
      const d = new Date(data.updated);
      updEl.textContent = d.toLocaleString("ja-JP");
    }

    // アラートバナー
    const alertEl = document.getElementById("trendsAlertInner");
    const alertCount = (data.keywords || []).filter(k => k.alert).length;
    const levelMap = { green: ["🟢", "平常範囲内"], yellow: ["🟡", "要注意：一部キーワードが上昇中"], red: ["🔴", "アラート：複数キーワードが急上昇中"] };
    const [icon, msg] = levelMap[data.alert_level] || levelMap.green;
    alertEl.className = `trends-alert-inner ${data.alert_level || "green"}`;
    alertEl.innerHTML = `<span style="font-size:18px">${icon}</span><span>${msg}</span>`;

    // バッジ件数
    const badge = document.getElementById("viewBadgeTrends");
    if (badge) badge.textContent = alertCount > 0 ? `!${alertCount}` : "−";

    // キーワードカード
    const grid = document.getElementById("trendsGrid");
    grid.innerHTML = "";
    // 検索量の多い順（avg_7day降順）でソート
    const sortedKeywords = [...(data.keywords || [])].sort((a, b) => (b.avg_7day ?? 0) - (a.avg_7day ?? 0));
    sortedKeywords.forEach(kw => {
      const changeDay  = kw.change_day  ?? 0;
      const changeWeek = kw.change_week ?? 0;
      const dayClass   = changeDay  > 10 ? "trend-change-up" : changeDay  < -10 ? "trend-change-down" : "trend-change-flat";
      const weekClass  = changeWeek > 10 ? "trend-change-up" : changeWeek < -10 ? "trend-change-down" : "trend-change-flat";
      const dayArrow   = changeDay  > 0  ? "▲" : changeDay  < 0 ? "▼" : "─";
      const weekArrow  = changeWeek > 0  ? "▲" : changeWeek < 0 ? "▼" : "─";
      const cardId = "spark_" + kw.keyword.replace(/\s/g,"_");
      const lastDate = (kw.history || []).slice(-1)[0]?.date || "";
      const tp = kw.today_partial;
      grid.insertAdjacentHTML("beforeend", `
        <div class="trend-card${kw.alert ? " alert" : ""}">
          ${kw.alert ? '<span class="trend-alert-badge">急上昇</span>' : ""}
          <div class="trend-card-kw">${escHtml(kw.keyword)}</div>
          <div class="trend-card-val">${kw.current ?? "―"}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;line-height:1.5">
            ${lastDate ? "最新 " + lastDate.slice(5).replace("-","/") + " 時点" : ""}${tp ? ` <span style="color:var(--accent);font-weight:700">・本日速報 ${tp.value}</span><span style="display:inline-block;margin-left:3px;padding:0 4px;border:1px solid currentColor;border-radius:3px;font-size:8px;opacity:.65">暫定</span>` : ""}
          </div>
          <div class="trend-card-changes">
            <span class="${dayClass}">${dayArrow} 前日比 ${changeDay > 0 ? "+" : ""}${changeDay}%</span>
            <span class="${weekClass}">${weekArrow} 週平均比 ${changeWeek > 0 ? "+" : ""}${changeWeek}%</span>
          </div>
          <div style="position:relative;height:80px;width:100%">
            <canvas id="${cardId}"></canvas>
          </div>
        </div>`);

      // スパークラインチャート（末尾に本日速報の暫定点を付ける）
      const sparkBase = (kw.history || []).slice(-7);
      const hist = tp
        ? [...sparkBase, { date: tp.date, value: tp.value, partial: true }]
        : sparkBase;
      const sparkColor = kw.alert ? "#f59e0b" : "#60a5fa";
      if (hist.length >= 2) {
        const ctx = document.getElementById(cardId)?.getContext("2d");
        if (ctx) {
          new Chart(ctx, {
            type: "line",
            data: {
              labels: hist.map(h => h.date.slice(5)),
              datasets: [{
                data: hist.map(h => h.value),
                borderColor: sparkColor,
                borderWidth: 2,
                pointRadius: hist.map(h => h.partial ? 2.8 : 0),
                pointStyle: hist.map(h => h.partial ? "rectRot" : "circle"),
                pointBackgroundColor: "#fff",
                pointBorderColor: sparkColor,
                pointBorderWidth: 1.5,
                tension: 0.4,
                fill: true,
                backgroundColor: kw.alert ? "rgba(245,158,11,.12)" : "rgba(96,165,250,.1)",
                segment: {
                  borderDash: sc => hist[sc.p1DataIndex]?.partial ? [4, 3] : undefined,
                },
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              interaction: { mode: "index", intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  enabled: true,
                  callbacks: {
                    title: (items) => hist[items[0]?.dataIndex]?.date ?? "",
                    label: (item) => `検索スコア: ${item.raw}` + (hist[item.dataIndex]?.partial ? "（本日速報・暫定）" : ""),
                  }
                }
              },
              scales: {
                x: {
                  display: true,
                  grid: { display: false },
                  ticks: { font: { size: 9 }, color: "rgba(128,128,128,.7)", maxRotation: 0, maxTicksLimit: 7 }
                },
                y: { display: false, min: 0 }
              }
            }
          });
        }
      }
    });

    // 急上昇の考察エリアを描画
    renderTrendsAnalysis(data);

    // グローバルに保持して期間切替で再描画
    // requestAnimationFrame でDOMレイアウト確定後に描画
    _trendsData = data;
    requestAnimationFrame(() => renderTrendsChart(_trendsPeriod));

    // 期間選択ボタン（カスタムを特別扱い）
    document.querySelectorAll(".trends-period-btn").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".trends-period-btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        const picker = document.getElementById("trendsCustomPicker");
        if (b.dataset.period === "custom") {
          if (picker) picker.style.display = "";
          return; // まだ描画しない
        }
        if (picker) picker.style.display = "none";
        _trendsDateRange = null;
        _trendsPeriod = parseInt(b.dataset.period);
        renderTrendsChart(_trendsPeriod, null);
      });
    });

    // カスタムピッカー：キャンセル
    document.getElementById("trendsCustomCancel")?.addEventListener("click", () => {
      document.getElementById("trendsCustomPicker").style.display = "none";
      // アクティブを1週間以内に戻す
      document.querySelectorAll(".trends-period-btn").forEach(x => x.classList.remove("active"));
      const defaultBtn = document.querySelector('.trends-period-btn[data-period="7"]');
      if (defaultBtn) defaultBtn.classList.add("active");
      _trendsDateRange = null;
      _trendsPeriod = 7;
      renderTrendsChart(7, null);
    });

    // カスタムピッカー：適用
    document.getElementById("trendsCustomApply")?.addEventListener("click", () => {
      const start = document.getElementById("trendsStartDate")?.value;
      const end   = document.getElementById("trendsEndDate")?.value;
      if (!start || !end || start > end) {
        alert("有効な開始日と終了日を入力してください。");
        return;
      }
      _trendsDateRange = { start, end };
      document.getElementById("trendsCustomPicker").style.display = "none";
      renderTrendsChart(0, _trendsDateRange);
    });

    if (btn) { btn.disabled = false; btn.textContent = "⟳ 更新"; }
  }

  // ─── 急上昇の考察エリア描画 ────────────────────────────────────────────────
  function renderTrendsAnalysis(data) {
    const wrap = document.getElementById("trendsAnalysisWrap");
    if (!wrap) return;
    const items = (data.keywords || []).filter(k => k.alert && k.analysis && k.analysis.text);
    if (items.length === 0) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }
    wrap.style.display = "";
    wrap.innerHTML = items.map(k => {
      const an = k.analysis;
      const srcChips = (an.sources || []).map(s =>
        `<a class="analysis-src ${s.type === "web" ? "web" : "news"}"
            href="${escHtml(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"
            title="${escHtml(s.title || s.url)}">${escHtml(s.title || s.url)}</a>`
      ).join("");
      const genDate = an.generated_at ? new Date(an.generated_at).toLocaleString("ja-JP") : "";
      return `
        <div class="analysis-card">
          <div class="analysis-head">💡 急上昇の考察：<span class="kw">${escHtml(k.keyword)}</span></div>
          <div class="analysis-meta">急上昇日 ${escHtml(an.spike_date || "")} ／ 現在値 ${k.current ?? "―"}（週平均比 ${k.change_week > 0 ? "+" : ""}${k.change_week}%）${an.web_used ? " ／ 🌐Web検索あり" : ""}</div>
          <div class="analysis-body">${escHtml(an.text)}</div>
          ${srcChips ? `<div class="analysis-sources">${srcChips}</div>` : ""}
          <div class="analysis-disclaimer">※ AIによる推察です。生成: ${escHtml(genDate)}。根拠は上記ソースをご確認ください。</div>
        </div>`;
    }).join("");
  }

  function renderTrendsChart(days, dateRange = null) {
    if (!_trendsData) return;
    const COLORS = ["#3b82f6","#8b5cf6","#10b981","#ef4444","#f59e0b","#06b6d4","#ec4899"];

    // 期間に応じたhistoryスライスを返すヘルパー
    function getSlice(history) {
      if (dateRange) {
        return (history || []).filter(h => h.date >= dateRange.start && h.date <= dateRange.end);
      }
      return (history || []).slice(-days);
    }
    function getAvg(slice) {
      return slice.length ? slice.reduce((s, h) => s + h.value, 0) / slice.length : 0;
    }
    // 描画用スライス：本日速報（today_partial）を末尾に含める（平均計算には含めない）
    function getPlotSlice(kw) {
      const base = getSlice(kw.history);
      const tp = kw.today_partial;
      if (!tp) return base;
      const inRange = dateRange
        ? (tp.date >= dateRange.start && tp.date <= dateRange.end)
        : true;
      if (!inRange || base.some(h => h.date === tp.date)) return base;
      return [...base, { date: tp.date, value: tp.value, partial: true }];
    }
    const anyPartial = (_trendsData.keywords || []).some(k => k.today_partial);

    // 選択期間の平均値降順でソート（暫定値は除外して安定させる）
    const keywords = [...(_trendsData.keywords || [])].sort((a, b) =>
      getAvg(getSlice(b.history)) - getAvg(getSlice(a.history))
    );

    const allDates = [...new Set(
      keywords.flatMap(k => getPlotSlice(k).map(h => h.date))
    )].sort();

    const baseRadius = allDates.length <= 7 ? 3 : allDates.length <= 30 ? 2 : 1;
    const datasets = keywords.map((kw, i) => {
      const plot = getPlotSlice(kw);
      const col  = COLORS[i % COLORS.length];
      const at   = d => plot.find(x => x.date === d);
      return {
        label: kw.keyword,
        data: allDates.map(d => { const h = at(d); return h ? h.value : null; }),
        borderColor: col,
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius:          allDates.map(d => at(d)?.partial ? 4.5 : baseRadius),
        pointStyle:           allDates.map(d => at(d)?.partial ? "rectRot" : "circle"),
        pointBackgroundColor: allDates.map(d => at(d)?.partial ? "#fff" : col),
        pointBorderColor:     col,
        pointBorderWidth:     allDates.map(d => at(d)?.partial ? 2 : 1),
        tension: 0.4,
        spanGaps: true,
        segment: {
          borderDash: sc => allDates[sc.p1DataIndex] && at(allDates[sc.p1DataIndex])?.partial ? [5, 4] : undefined,
        },
      };
    });

    if (_chartTrends) { _chartTrends.destroy(); _chartTrends = null; }
    const ctx = document.getElementById("chartTrends")?.getContext("2d");
    if (ctx) {
      _chartTrends = new Chart(ctx, {
        type: "line",
        data: { labels: allDates.map(d => d.slice(5)), datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            subtitle: {
              display: anyPartial,
              text: "◇ 末尾の白いひし形＝本日の速報値（暫定：Googleトレンド時間別データを日次換算）",
              position: "bottom", align: "start",
              font: { size: 10 }, color: "rgba(128,128,128,.85)",
              padding: { top: 6 },
            },
            tooltip: {
              mode: "index", intersect: false,
              callbacks: {
                title: (items) => allDates[items[0]?.dataIndex] ?? "",
                label: (item) => {
                  const kw = keywords[item.datasetIndex];
                  const h  = getPlotSlice(kw).find(x => x.date === allDates[item.dataIndex]);
                  return `${kw.keyword}: ${item.raw}` + (h?.partial ? "（速報）" : "");
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: "rgba(128,128,128,.08)" },
              ticks: { font: { size: 11 }, maxTicksLimit: allDates.length <= 7 ? 7 : allDates.length <= 30 ? 10 : 12 }
            },
            y: {
              min: 0, max: 100,
              grid: { color: "rgba(128,128,128,.08)" },
              ticks: { font: { size: 11 } }
            }
          }
        }
      });
    }

    // ── 右パネル：平均値バーチャート（HTML） ──
    const panel = document.getElementById("trendsAvgPanel");
    if (!panel) return;

    const avgData = keywords.map(kw => Math.round(getAvg(getSlice(kw.history))));
    const maxAvg = Math.max(...avgData, 1);
    const BAR_MAX = 260;

    panel.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:10px">インタレストの平均値</div>
      <div style="display:flex;align-items:flex-end;gap:8px;height:${BAR_MAX}px;margin-bottom:10px">
        ${keywords.map((kw, i) => {
          const barH = Math.max(Math.round(avgData[i] / maxAvg * BAR_MAX), avgData[i] > 0 ? 6 : 0);
          const col   = COLORS[i % COLORS.length];
          return `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px;min-width:0">
              <span style="font-size:13px;font-weight:800;color:var(--text);line-height:1">${avgData[i]}</span>
              <div style="width:100%;height:${barH}px;background:${col};border-radius:4px 4px 0 0;opacity:0.8"></div>
            </div>`;
        }).join('')}
      </div>
      <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px">
        ${keywords.map((kw, i) => `
          <div style="display:flex;align-items:center;gap:6px;min-width:0">
            <span style="width:10px;height:10px;border-radius:50%;background:${COLORS[i % COLORS.length]};flex-shrink:0"></span>
            <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(kw.keyword)}</span>
          </div>`).join('')}
      </div>`;
  }

  // ─── 起動 ─────────────────────────────────────────────────────────────────
  // ─── イベント配線（CSP でインラインハンドラを禁止しているため addEventListener で接続）──
  // 動的に生成するカード内のボタンは data-action 属性で識別し、document で一括委譲する。
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    switch (el.dataset.action) {
      case "toggle-accordion": toggleAccordion(el.dataset.target, el); break;
      case "toggle-diet-acc":  toggleDietAcc(el.dataset.target, el); break;
      case "toggle-diet-full": toggleDietFullText(el.dataset.target, el.dataset.speechId, el); break;
    }
  });

  document.getElementById("trendsRefreshBtn")?.addEventListener("click", () => loadTrends(true));

  // ヒーロー画像の読込失敗時は非表示（旧インライン onerror の置き換え）
  const heroImg = document.querySelector(".hero-mascot img");
  if (heroImg) {
    const hideHero = () => { heroImg.style.display = "none"; };
    if (heroImg.complete && heroImg.naturalWidth === 0) hideHero();
    else heroImg.addEventListener("error", hideHero);
  }

  init();
})();
