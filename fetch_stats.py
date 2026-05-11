"""
統計データ取得スクリプト
デジタル庁「マイナンバー普及ダッシュボード」公開CSVから
  ① マイナンバーカード普及率（保有率）
  ② 健康保険証としての利用登録率
を取得して stats_data.json に保存します。

データ元: https://www.digital.go.jp/resources/govdashboard/mynumber_penetration_rate
CSV:  上記ページの table_01.csv（デジタル庁が毎月更新）
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
    r'[^"\']+mynumber-penetration-rate_table_01\.csv)',
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

    # フォールバック: 直近の既知 URL（取得できなかった場合）
    fallback = (
        DIGITAL_GO_BASE
        + "/assets/contents/node/basic_page/field_ref_resources/"
        "5a1f1ef4-89a9-495c-9a09-35845488fe9c/"
        "b8d2170c/20260227_resources_govdashboard_"
        "mynumber-penetration-rate_table_01.csv"
    )
    print(f"  [CSV URL] フォールバック: {fallback}")
    return fallback


# ─── CSV パース ───────────────────────────────────────────────────────────────
# 列インデックス（0-based）
# [0]  年月
# [3]  マイナカード_保有枚数_累計
# [4]  マイナカード_人口に対する保有率 (xx.xx%)
# [8]  健保利用登録_有効登録数_累計
# [9]  健保利用登録_有効登録数_率 (xx.xx%)
COL_MONTH           = 0
COL_MYNA_CUMUL      = 3
COL_MYNA_RATE       = 4
COL_KENPO_CUMUL     = 8
COL_KENPO_RATE      = 9

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
    return None


def parse_csv(raw: bytes) -> dict:
    """CSV bytes → {"myna": [...], "kenpo": [...], "source_url": "..."}"""
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

    reader = csv.reader(io.StringIO(text))
    rows   = list(reader)
    # ヘッダ行をスキップ（数字以外で始まる行）
    data_rows = [r for r in rows if r and re.match(r"[A-Za-z]", r[0].strip())]

    myna  = []
    kenpo = []

    for row in data_rows:
        if len(row) <= max(COL_MYNA_RATE, COL_KENPO_RATE):
            continue
        month = _parse_month(row[COL_MONTH])
        if not month:
            continue

        myna_rate  = _parse_pct(row[COL_MYNA_RATE])
        myna_cumul = _parse_num(row[COL_MYNA_CUMUL])
        kenpo_rate  = _parse_pct(row[COL_KENPO_RATE])
        kenpo_cumul = _parse_num(row[COL_KENPO_CUMUL])

        if myna_rate is not None:
            myna.append({
                "month":    month,
                "rate":     myna_rate,
                "cumul":    myna_cumul,
            })
        if kenpo_rate is not None:
            kenpo.append({
                "month":    month,
                "rate":     kenpo_rate,
                "cumul":    kenpo_cumul,
            })

    # 月順ソート
    myna.sort(key=lambda x: x["month"])
    kenpo.sort(key=lambda x: x["month"])
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
        "updated":      _iso_jst(),
        "csv_url":      csv_url,
        "source":       "デジタル庁「マイナンバーカード普及状況ダッシュボード」",
        "source_page":  DASHBOARD_PAGE,
        "myna_card":    myna,
        "kenpo_reg":    kenpo,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    size_kb = os.path.getsize(json_path) / 1024
    print(f"  [保存] {json_path}  ({size_kb:.1f} KB)")
    print("=" * 52)


if __name__ == "__main__":
    main()
