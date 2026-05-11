"""
国会会議録取得スクリプト
NDL 国会会議録検索システム API から
マイナ保険証・オンライン資格確認関連の発言を取得して diet_data.json に保存します。

API ドキュメント: https://kokkai.ndl.go.jp/api.html
"""

import sys
import os
import re
import json
import datetime
import time
import argparse
import urllib.parse

try:
    import requests
    _USE_REQUESTS = True
except ImportError:
    _USE_REQUESTS = False

# ─── 設定 ────────────────────────────────────────────────────────────────────
NDL_SPEECH_API = "https://kokkai.ndl.go.jp/api/speech"

# 2024年10月以降を対象
FROM_DATE = "2024-10-01"

# 1回の更新で保持する最大件数
MAX_RECORDS = 100

# 検索キーワード（OR 検索として個別に取得・統合）
SEARCH_KEYWORDS = [
    "マイナ保険証",
    "オンライン資格確認",
    "健康保険証",
    "マイナンバーカード 保険",
    "資格確認書",
]

# 大臣・政府側の判定キーワード
MINISTER_KEYWORDS = ["大臣", "長官", "副大臣", "大臣政務官", "政府参考人", "内閣総理大臣"]

FRESHNESS_SECS = 3600  # 1時間以内は再取得スキップ
CONNECT_TIMEOUT = 5
READ_TIMEOUT    = 30

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

def _trim_excerpt(text: str, max_len: int = 200) -> str:
    """発言テキストを max_len 文字以内で自然に切る"""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_len:
        return text
    cut = text[:max_len]
    last_punct = max(cut.rfind("。"), cut.rfind("、"), cut.rfind("！"), cut.rfind("？"))
    if last_punct > max_len // 2:
        return text[:last_punct + 1]
    return cut.rstrip() + "…"


# ─── NDL API 取得 ─────────────────────────────────────────────────────────────
def fetch_speeches_by_keyword(session, keyword: str) -> list[dict]:
    """NDL 発言検索API から 1 キーワード分の発言を取得する"""
    params = {
        "any":            keyword,
        "from":           FROM_DATE,
        "maximumRecords": 100,     # API 上限が 100 件/リクエスト
        "recordPacking":  "json",
    }
    url = NDL_SPEECH_API + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    t0  = time.perf_counter()
    try:
        resp = session.get(
            url,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            headers={"User-Agent": UA},
        )
        resp.raise_for_status()
        data    = resp.json()
        records = data.get("speechRecord", []) or []
        elapsed = (time.perf_counter() - t0) * 1000
        print(f"  [NDL] 「{keyword}」: {elapsed:.0f}ms  {len(records)} 件")
        return records
    except Exception as e:
        print(f"  [NDL] 「{keyword}」: エラー ({e})")
        return []


# ─── 正規化 ───────────────────────────────────────────────────────────────────
def normalize_speech(r: dict) -> dict:
    """NDL API レスポンス 1 件を統一フォーマットに変換する"""
    speech_raw  = (r.get("speech") or "").strip()
    excerpt     = _trim_excerpt(speech_raw)
    position    = (r.get("speakerPosition") or "").strip()
    party       = (r.get("speakerGroup")    or "").strip()
    role        = (r.get("speakerRole")     or "").strip()
    is_minister = any(kw in position for kw in MINISTER_KEYWORDS)

    return {
        # ── 識別子 ──
        "speechID":        r.get("speechID",        ""),
        "issueID":         r.get("issueID",          ""),
        # ── 会議情報 ──
        "session":         r.get("session"),              # 国会回次（数値）
        "nameOfHouse":     r.get("nameOfHouse",     ""),  # 衆議院 / 参議院
        "nameOfMeeting":   r.get("nameOfMeeting",   ""),  # 委員会名
        "issue":           r.get("issue",            ""),  # 号数
        "imageKind":       r.get("imageKind",        ""),  # 本会議 / 委員会
        "date":            r.get("date",             ""),  # YYYY-MM-DD
        # ── 発言者情報 ──
        "speaker":         r.get("speaker",          ""),
        "speakerYomi":     r.get("speakerYomi",      ""),
        "speakerGroup":    party,
        "speakerPosition": position,
        "speakerRole":     role,
        "is_minister":     is_minister,
        # ── 発言内容 ──
        "excerpt":         excerpt,
        "speechURL":       r.get("speechURL",        ""),
        # ── メタ ──
        "startPage":       r.get("startPage"),
        "speechOrder":     r.get("speechOrder"),
    }


# ─── 重複排除 ─────────────────────────────────────────────────────────────────
def dedup_speeches(speeches: list[dict]) -> list[dict]:
    """speechID で重複を排除する"""
    seen   = set()
    result = []
    for s in speeches:
        sid = s.get("speechID", "")
        if sid and sid not in seen:
            seen.add(sid)
            result.append(s)
    return result


# ─── 保存 ─────────────────────────────────────────────────────────────────────
def save_diet(speeches: list[dict], json_path: str) -> None:
    # 日付降順でソート
    speeches.sort(key=lambda s: (s.get("date", ""), s.get("speechOrder") or 0), reverse=True)
    speeches = speeches[:MAX_RECORDS]

    data = {
        "updated":  _iso_jst(),
        "total":    len(speeches),
        "speeches": speeches,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(json_path) / 1024
    print(f"  [保存] {len(speeches)} 件  ({size_kb:.1f} KB)")


# ─── メイン ───────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="国会会議録取得 (NDL API)")
    parser.add_argument("--force", "-f", action="store_true",
                        help="鮮度チェックをスキップして強制取得")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path  = os.path.join(script_dir, "diet_data.json")

    print("=" * 52)
    print(f"  国会会議録取得  {_iso_jst()}")
    print("=" * 52)

    if not args.force and is_fresh(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            d = json.load(f)
        print(f"  [スキップ] 前回更新から1時間以内です（{d.get('total',0)} 件保存済み）")
        print(f"             強制取得するには --force を付けてください。")
        print("=" * 52)
        return

    if not _USE_REQUESTS:
        print("  [エラー] requests が未インストールです。pip install requests")
        sys.exit(1)

    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    all_raw: list[dict] = []
    for kw in SEARCH_KEYWORDS:
        records = fetch_speeches_by_keyword(session, kw)
        all_raw.extend(records)
        time.sleep(0.5)  # API レート制限対策

    print(f"  [取得合計] {len(all_raw)} 件（重複含む）")

    normalized = [normalize_speech(r) for r in all_raw]
    deduped    = dedup_speeches(normalized)
    print(f"  [重複排除後] {len(deduped)} 件")

    save_diet(deduped, json_path)
    print("=" * 52)


if __name__ == "__main__":
    main()
