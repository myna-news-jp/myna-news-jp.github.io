"""
統計データ取得スクリプト
デジタル庁「マイナンバーカード普及状況ダッシュボード」公開CSVから
  ① マイナンバーカード保有率（※2026年にCSVから率が廃止されたため、保有枚数÷人口基準で概算）
  ② 健康保険証としての利用登録率
を取得して stats_data.json に保存します。

データ元: https://www.digital.go.jp/resources/govdashboard/mynumber_penetration_rate
CSV:  上記ページの *_penetration_usage_table_01.csv（縦持ち: 年月・指標名・値）。
      2026年にファイル名（penetration-rate→penetration_usage）と形式（横持ち→縦持ち）が変更された。
"""

import sys
import os
import re
import json
import csv
import io
import datetime
import time
import argparse
import urllib.request
import urllib.parse
import urllib.error

try:
    import requests as _requests
    _USE_REQUESTS = True
except ImportError:
    _USE_REQUESTS = False

# ─── 設定 ────────────────────────────────────────────────────────────────────
FRESHNESS_SECS  = 3600
CONNECT_TIMEOUT = 10
READ_TIMEOUT    = 30

DASHBOARD_PAGE  = "https://www.digital.go.jp/resources/govdashboard/mynumber_penetration_rate"
# CSVリンクの正規表現（日付部分はページ更新ごとに変わる）
CSV_LINK_PAT    = re.compile(
    r'(/assets/contents/node/basic_page/field_ref_resources/'
    r'[^"\']+penetration[^"\']*table_01\.csv)',   # 旧 penetration-rate / 新 penetration_usage 両対応
    re.IGNORECASE,
)
DIGITAL_GO_BASE = "https://www.digital.go.jp"

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


def _get(url: str) -> bytes | None:
    headers = {"User-Agent": UA}
    try:
        if _USE_REQUESTS:
            r = _requests.get(url, headers=headers,
                              timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
            r.raise_for_status()
            return r.content
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as resp:
                return resp.read()
    except Exception as e:
        print(f"  [fetch] {url} → エラー: {e}")
        return None


# ─── CSVのURLをページから動的に取得 ──────────────────────────────────────────
def resolve_csv_url() -> str | None:
    print(f"  [ページ取得] {DASHBOARD_PAGE}")
    raw = _get(DASHBOARD_PAGE)
    if not raw:
        return None

    html = raw.decode("utf-8", errors="replace")
    m = CSV_LINK_PAT.search(html)
    if m:
        path = m.group(1)
        full = DIGITAL_GO_BASE + path
        print(f"  [CSV URL] {full}")
        return full

    # フォールバック: 直近の既知 URL（ページからCSVリンクを取れなかった場合）
    fallback = (
        DIGITAL_GO_BASE
        + "/assets/contents/node/basic_page/field_ref_resources/"
        "65ee2cb2-0b1f-46fa-9a40-7eefea58a06b/5e08d4d2/"
        "20260731_mynumber_card_penetration_usage_table_01.csv"
    )
    print(f"  [CSV URL] フォールバック: {fallback}")
    return fallback


# ─── CSV パース（デジタル庁 縦持ち: 年月・指標名・値）─────────────────────────
# 2026年にデジタル庁がCSVを縦持ち形式へ変更。必要な指標を「指標名」列で拾う。
METRIC_MYNA_CUMUL  = "マイナンバーカード_保有枚数"     # 累計枚数（人口保有率は廃止）
METRIC_KENPO_RATE  = "マイナ保険証_利用登録率"          # 小数（0.91 = 91%）
METRIC_KENPO_CUMUL = "マイナ保険証_利用登録件数"        # 累計件数

# マイナンバーカードの「人口に対する保有率(%)」は 2026年にデジタル庁CSVから廃止された。
# UI維持のため保有枚数÷人口基準で概算する（※推計）。
# 基準 = 旧公式系列の最終点(2026-01: 101,148,007枚 / 81.4%)から逆算 ≒ 1.243億。
POPULATION_BASE    = 124_260_452

def _parse_num(s: str) -> int | None:
    s = s.strip().replace(",", "").replace('"', "")
    try:
        return int(s)
    except ValueError:
        return None

def _parse_pct(s: str) -> float | None:
    s = s.strip().replace("%", "").replace('"', "")
    try:
        return float(s)
    except ValueError:
        return None

def _parse_month(s: str) -> str | None:
    """'Feb-25' → '2025-02' などに変換"""
    s = s.strip()
    # すでに YYYY-MM 形式
    if re.match(r"^\d{4}-\d{2}$", s):
        return s
    # MMM-YY 形式（英語月略称）
    months_en = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "may": 5, "jun": 6, "jul": 7, "aug": 8,
        "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }
    m = re.match(r"^([A-Za-z]+)-(\d{2})$", s)
    if m:
        mon = months_en.get(m.group(1).lower())
        yr  = int(m.group(2))
        yr  = yr + 2000 if yr < 100 else yr
        if mon:
            return f"{yr:04d}-{mon:02d}"
    # 日本語: 令和X年Y月 / YYYY年M月
    m2 = re.match(r"令和(\d+)年(\d+)月", s)
    if m2:
        return f"{int(m2.group(1)) + 2018:04d}-{int(m2.group(2)):02d}"
    m3 = re.match(r"(\d{4})年(\d+)月", s)
    if m3:
        return f"{int(m3.group(1)):04d}-{int(m3.group(2)):02d}"
    # YYYY/M/D 形式（新CSV: 2025/5/1）
    m4 = re.match(r"^(\d{4})/(\d{1,2})/\d{1,2}$", s)
    if m4:
        return f"{int(m4.group(1)):04d}-{int(m4.group(2)):02d}"
    return None


def parse_csv(raw: bytes) -> dict:
    """CSV bytes（縦持ち: 年月・指標名・値）→ {"myna": [...], "kenpo": [...]}"""
    # エンコーディング検出
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            pass
    if text is None:
        raise ValueError("CSV エンコーディングを判定できませんでした")

    myna_cumul  = {}   # month -> 保有枚数（累計）
    kenpo_rate  = {}   # month -> 利用登録率(%)
    kenpo_cumul = {}   # month -> 利用登録件数（累計）

    for row in csv.reader(io.StringIO(text)):
        if len(row) < 3:
            continue
        month = _parse_month(row[0])
        if not month:
            continue                       # ヘッダ行「年月」等はここで除外
        name = row[1].strip()
        if name == METRIC_MYNA_CUMUL:
            n = _parse_num(row[2])
            if n is not None:
                myna_cumul[month] = n
        elif name == METRIC_KENPO_RATE:
            f = _parse_pct(row[2])          # 0.91 のような小数
            if f is not None:
                kenpo_rate[month] = round(f * 100, 1)   # → 91.0(%)
        elif name == METRIC_KENPO_CUMUL:
            n = _parse_num(row[2])
            if n is not None:
                kenpo_cumul[month] = n

    # ① マイナカード: 保有枚数から保有率(%)を概算（※推計）
    myna = [
        {"month": m,
         "rate":  round(myna_cumul[m] / POPULATION_BASE * 100, 1),
         "cumul": myna_cumul[m]}
        for m in sorted(myna_cumul)
    ]
    # ② 健保利用登録: 率が取れた月のみ（UIは率を主に使う）
    kenpo = [
        {"month": m, "rate": kenpo_rate[m], "cumul": kenpo_cumul.get(m)}
        for m in sorted(kenpo_rate)
    ]
    return {"myna": myna, "kenpo": kenpo}


# ─── メイン ───────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="統計データ取得（デジタル庁CSV）")
    parser.add_argument("--force", "-f", action="store_true",
                        help="鮮度チェックをスキップして強制取得")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path  = os.path.join(script_dir, "stats_data.json")

    print("=" * 52)
    print(f"  統計データ取得  {_iso_jst()}")
    print("=" * 52)

    if not args.force and is_fresh(json_path):
        print("  [スキップ] 前回更新から1時間以内です")
        print("             強制取得するには --force を付けてください。")
        print("=" * 52)
        return

    csv_url = resolve_csv_url()
    if not csv_url:
        print("  [エラー] CSV URLを取得できませんでした")
        sys.exit(1)

    print(f"  [CSV DL] ...")
    raw = _get(csv_url)
    if not raw:
        print("  [エラー] CSVのダウンロードに失敗しました")
        sys.exit(1)

    parsed = parse_csv(raw)
    myna  = parsed["myna"]
    kenpo = parsed["kenpo"]

    print(f"  [マイナカード] {len(myna)} ヶ月分 "
          + (f"（最新: {myna[-1]['month']} / {myna[-1]['rate']}%）" if myna else ""))
    print(f"  [健保利用登録] {len(kenpo)} ヶ月分 "
          + (f"（最新: {kenpo[-1]['month']} / {kenpo[-1]['rate']}%）" if kenpo else ""))

    stats = {
        "updated":             _iso_jst(),
        "csv_url":             csv_url,
        "source":              "デジタル庁「マイナンバーカード普及状況ダッシュボード」",
        "source_page":         DASHBOARD_PAGE,
        "myna_card":           myna,
        "kenpo_reg":           kenpo,
        "myna_rate_estimated": True,          # ①保有率は保有枚数÷人口基準の概算
        "population_base":     POPULATION_BASE,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    size_kb = os.path.getsize(json_path) / 1024
    print(f"  [保存] {json_path}  ({size_kb:.1f} KB)")
    print("=" * 52)


if __name__ == "__main__":
    main()
