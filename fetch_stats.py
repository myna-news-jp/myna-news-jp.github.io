"""
統計データ取得・集計スクリプト
- news_data.json  → 月別ニュース件数 / カテゴリ別件数
- diet_data.json  → 月別国会質疑件数
- 総務省 Web     → マイナンバーカード交付率（ベストエフォート）
結果を stats_data.json に保存します。
"""

import sys
import os
import re
import json
import datetime
import time
import argparse
import urllib.request
import urllib.error
import html

try:
    import requests as _requests
    _USE_REQUESTS = True
except ImportError:
    _USE_REQUESTS = False

# ─── 設定 ────────────────────────────────────────────────────────────────────
FRESHNESS_SECS = 3600          # 1 時間以内なら再取得スキップ
CONNECT_TIMEOUT = 10
READ_TIMEOUT    = 30

# 総務省 マイナンバーカード交付状況ページ
SOUMU_URL = "https://www.soumu.go.jp/kojinbango_card/kofujokyo.html"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


# ─── ユーティリティ ───────────────────────────────────────────────────────────
def _now_jst():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))

def _iso_jst(dt=None):
    dt = dt or _now_jst()
    return dt.strftime("%Y-%m-%dT%H:%M:%S+09:00")

def is_fresh(json_path: str) -> bool:
    if not os.path.exists(json_path):
        return False
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        updated = datetime.datetime.fromisoformat(data.get("updated", ""))
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=datetime.timezone.utc)
        return (_now_jst() - updated).total_seconds() < FRESHNESS_SECS
    except Exception:
        return False


# ─── ニュース集計 ─────────────────────────────────────────────────────────────
def aggregate_news(script_dir: str) -> list[dict]:
    path = os.path.join(script_dir, "news_data.json")
    if not os.path.exists(path):
        print("  [ニュース] news_data.json が見つかりません → スキップ")
        return []

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    articles = data.get("articles", [])
    monthly: dict[str, dict] = {}

    for art in articles:
        date_str = art.get("pub_date", art.get("date", ""))
        if not date_str:
            continue
        month = date_str[:7]   # "YYYY-MM"
        if month not in monthly:
            monthly[month] = {"month": month, "total": 0, "categories": {}}
        monthly[month]["total"] += 1
        cat = art.get("category", "その他")
        monthly[month]["categories"][cat] = monthly[month]["categories"].get(cat, 0) + 1

    result = sorted(monthly.values(), key=lambda x: x["month"])
    print(f"  [ニュース] {len(articles)} 件 → {len(result)} ヶ月分")
    return result


# ─── 国会質疑集計 ─────────────────────────────────────────────────────────────
def aggregate_diet(script_dir: str) -> list[dict]:
    path = os.path.join(script_dir, "diet_data.json")
    if not os.path.exists(path):
        print("  [国会質疑] diet_data.json が見つかりません → スキップ")
        return []

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    exchanges = data.get("exchanges", [])
    monthly: dict[str, dict] = {}

    for ex in exchanges:
        date_str = ex.get("date", "")
        if not date_str:
            continue
        month = date_str[:7]
        if month not in monthly:
            monthly[month] = {"month": month, "exchanges": 0, "questions": 0, "answers": 0}
        monthly[month]["exchanges"] += 1
        if ex.get("question"):
            monthly[month]["questions"] += 1
        monthly[month]["answers"] += len(ex.get("answers", []))

    result = sorted(monthly.values(), key=lambda x: x["month"])
    print(f"  [国会質疑] {len(exchanges)} exchanges → {len(result)} ヶ月分")
    return result


# ─── カテゴリ集計 ─────────────────────────────────────────────────────────────
def aggregate_categories(script_dir: str) -> dict:
    """全期間のカテゴリ別件数を返す"""
    path = os.path.join(script_dir, "news_data.json")
    if not os.path.exists(path):
        return {}

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cats: dict[str, int] = {}
    for art in data.get("articles", []):
        cat = art.get("category") or "その他"
        cats[cat] = cats.get(cat, 0) + 1
    return cats


# ─── 総務省 マイナカード交付率スクレイピング ──────────────────────────────────
def _fetch_url(url: str) -> str | None:
    """URL からテキストを取得（requests / urllib 両対応）"""
    headers = {"User-Agent": UA}
    try:
        if _USE_REQUESTS:
            r = _requests.get(url, headers=headers,
                              timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return r.text
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as resp:
                charset = "utf-8"
                ct = resp.headers.get("Content-Type", "")
                m = re.search(r"charset=([\w-]+)", ct)
                if m:
                    charset = m.group(1)
                return resp.read().decode(charset, errors="replace")
    except Exception as e:
        print(f"  [fetch] {url} → エラー: {e}")
        return None


def _parse_issuance_rate(html_text: str) -> list[dict]:
    """
    総務省ページの HTML から「交付枚数累計」「人口に対する交付率」を抽出する。
    ページ構造が変わると取れなくなるため best-effort。
    """
    records = []

    # 「令和X年Y月末現在」などの日付パターンを探す
    # 典型的な表: | 令和X年Y月末 | 交付枚数 | 交付率 |
    #
    # パターン1: <td>令和X年Y月末現在</td> 形式
    # パターン2: テキスト内に埋め込まれた数値

    # HTML エンティティを展開
    text = html.unescape(html_text)

    # 令和 → 西暦変換
    def reiwa_to_ad(y: int, m: int) -> str:
        return f"{y + 2018}-{m:02d}"

    # テーブル行を探す
    # <tr>...</tr> を全部取り出して中身を解析
    row_pat = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
    cell_pat = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)
    tag_pat  = re.compile(r"<[^>]+>")

    for row_m in row_pat.finditer(text):
        row_html = row_m.group(1)
        cells = [tag_pat.sub("", c.group(1)).strip()
                 for c in cell_pat.finditer(row_html)]
        # 空白・改行を正規化
        cells = [re.sub(r"\s+", "", c) for c in cells if re.sub(r"\s+", "", c)]

        if not cells:
            continue

        # 日付セルを探す (令和X年Y月 / YYYY年M月)
        date_cell = None
        date_idx  = -1
        for i, c in enumerate(cells):
            m1 = re.search(r"令和(\d+)年(\d+)月", c)
            m2 = re.search(r"(\d{4})年(\d+)月", c)
            if m1:
                year_ad = int(m1.group(1)) + 2018
                date_cell = f"{year_ad}-{int(m1.group(2)):02d}"
                date_idx = i
                break
            elif m2:
                year_ad = int(m2.group(1))
                if 2020 <= year_ad <= 2030:
                    date_cell = f"{year_ad}-{int(m2.group(2)):02d}"
                    date_idx = i
                    break

        if date_cell is None:
            continue

        # 交付率（XX.X% 形式）を探す
        rate = None
        count = None
        for i, c in enumerate(cells):
            if i == date_idx:
                continue
            # 交付率
            rm = re.search(r"(\d+\.\d+)%?$", c)
            if rm and rate is None:
                v = float(rm.group(1))
                if 0 < v <= 100:
                    rate = v
            # 交付枚数（万枚 / 千枚単位 / そのまま）
            cm = re.search(r"^([\d,]+)$", c)
            if cm and count is None:
                v = int(cm.group(1).replace(",", ""))
                if v > 1000:   # 枚数は最低でも千の単位
                    count = v

        if rate is not None:
            records.append({
                "month":         date_cell,
                "rate":          rate,
                "issued_count":  count,
                "source":        "総務省",
            })

    # 重複排除・ソート
    seen = set()
    unique = []
    for r in records:
        if r["month"] not in seen:
            seen.add(r["month"])
            unique.append(r)
    unique.sort(key=lambda x: x["month"])
    return unique


def fetch_card_issuance() -> list[dict]:
    print(f"  [総務省] {SOUMU_URL}")
    html_text = _fetch_url(SOUMU_URL)
    if not html_text:
        print("  [総務省] 取得失敗 → スキップ")
        return []

    records = _parse_issuance_rate(html_text)
    if records:
        print(f"  [総務省] {len(records)} 件取得 "
              f"（最新: {records[-1]['month']} / {records[-1]['rate']}%）")
    else:
        print("  [総務省] データを解析できませんでした（ページ構造が変わった可能性）")
    return records


# ─── 保存 ─────────────────────────────────────────────────────────────────────
def save_stats(data: dict, json_path: str) -> None:
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(json_path) / 1024
    print(f"  [保存] {json_path}  ({size_kb:.1f} KB)")


# ─── メイン ───────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="統計データ集計")
    parser.add_argument("--force", "-f", action="store_true",
                        help="鮮度チェックをスキップして強制取得")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path  = os.path.join(script_dir, "stats_data.json")

    print("=" * 52)
    print(f"  統計データ集計  {_iso_jst()}")
    print("=" * 52)

    if not args.force and is_fresh(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            d = json.load(f)
        print(f"  [スキップ] 前回更新から1時間以内です")
        print(f"             強制取得するには --force を付けてください。")
        print("=" * 52)
        return

    news_monthly    = aggregate_news(script_dir)
    diet_monthly    = aggregate_diet(script_dir)
    categories_all  = aggregate_categories(script_dir)
    card_issuance   = fetch_card_issuance()

    stats = {
        "updated":        _iso_jst(),
        "news_monthly":   news_monthly,
        "diet_monthly":   diet_monthly,
        "categories_all": categories_all,
        "card_issuance":  card_issuance,
    }

    save_stats(stats, json_path)
    print("=" * 52)


if __name__ == "__main__":
    main()
