"""
国会会議録取得スクリプト
NDL 国会会議録検索システム API から
マイナ保険証・オンライン資格確認関連の発言を取得して diet_data.json に保存します。

データ構造: フラットな発言リスト → 質問＋答弁セット（exchanges 形式）
  - issueID（同一会議号）と speechOrder（発言順）でペアリング
  - 質問（非大臣）に後続する大臣答弁をグルーピング

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
from collections import defaultdict

try:
    import requests
    _USE_REQUESTS = True
except ImportError:
    _USE_REQUESTS = False

# ─── 設定 ────────────────────────────────────────────────────────────────────
NDL_SPEECH_API = "https://kokkai.ndl.go.jp/api/speech"

FROM_DATE   = "2024-10-01"   # 2024年10月以降
MAX_EXCHANGES = 60           # 保持する最大 exchange 数

SEARCH_KEYWORDS = [
    "マイナ保険証",
    "オンライン資格確認",
    "健康保険証",
    "マイナンバーカード 保険",
    "資格確認書",
]

# 政府側発言の判定キーワード（役職）
MINISTER_KEYWORDS = [
    "大臣", "長官", "副大臣", "大臣政務官",
    "政府参考人", "内閣総理大臣", "委員長",
]

FRESHNESS_SECS  = 3600
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


def _extract_title(text: str, max_len: int = 60) -> str:
    """
    発言テキストから見出しを生成する。
    最初の文（句点まで）を優先し、なければ max_len 文字で切る。
    冒頭の定型句（「ただいま…」「おはようございます」等）は読み飛ばす。
    """
    text = re.sub(r"\s+", " ", text).strip()
    # 冒頭の定型フレーズを除去
    skip_patterns = [
        r"^ただいまから[^。]{0,30}。",
        r"^おはようございます[。　 ]*",
        r"^ありがとうございます[。　 ]*",
        r"^委員長[^。]{0,20}。",
        r"^衆議院[^。]{0,20}、",
    ]
    for pat in skip_patterns:
        text = re.sub(pat, "", text, count=1).strip()
    if not text:
        return "（発言内容）"
    # 最初の句点までを見出しに
    first_period = text.find("。")
    if 8 < first_period <= max_len:
        return text[:first_period + 1]
    if len(text) <= max_len:
        return text
    return text[:max_len].rstrip() + "…"


def _trim_excerpt(text: str, max_len: int = 180) -> str:
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
        "maximumRecords": 100,
        "recordPacking":  "json",
    }
    url = NDL_SPEECH_API + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    t0  = time.perf_counter()
    try:
        resp = session.get(url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                           headers={"User-Agent": UA})
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
    position    = (r.get("speakerPosition") or "").strip()
    party       = (r.get("speakerGroup")    or "").strip()
    role        = (r.get("speakerRole")     or "").strip()
    is_minister = any(kw in position for kw in MINISTER_KEYWORDS)

    return {
        "speechID":        r.get("speechID",        ""),
        "issueID":         r.get("issueID",          ""),
        "session":         r.get("session"),
        "nameOfHouse":     r.get("nameOfHouse",     ""),
        "nameOfMeeting":   r.get("nameOfMeeting",   ""),
        "issue":           r.get("issue",            ""),
        "imageKind":       r.get("imageKind",        ""),
        "date":            r.get("date",             ""),
        "speaker":         r.get("speaker",          ""),
        "speakerYomi":     r.get("speakerYomi",      ""),
        "speakerGroup":    party,
        "speakerPosition": position,
        "speakerRole":     role,
        "is_minister":     is_minister,
        "title":           _extract_title(speech_raw),
        "excerpt":         _trim_excerpt(speech_raw),
        "speechURL":       r.get("speechURL",        ""),
        "startPage":       r.get("startPage"),
        "speechOrder":     r.get("speechOrder"),
    }


# ─── 重複排除 ─────────────────────────────────────────────────────────────────
def dedup_speeches(speeches: list[dict]) -> list[dict]:
    seen, result = set(), []
    for s in speeches:
        sid = s.get("speechID", "")
        if sid and sid not in seen:
            seen.add(sid)
            result.append(s)
    return result


# ─── 質問＋答弁ペアリング ────────────────────────────────────────────────────
def build_exchanges(speeches: list[dict]) -> list[dict]:
    """
    issueID（同一会議号）と speechOrder（発言順）を使い、
    質問（非大臣発言）とその後続答弁（大臣等発言）をグルーピングして
    exchange リストを返す。

    ・同一 issueID 内で speechOrder 順に並べて走査
    ・非大臣発言が来たら「新しい exchange 開始」
    ・大臣発言が来たら「直前の exchange の answers に追加」
    ・大臣発言のみで質問が見当たらない場合は question=None で exchange 化
    """
    # issueID でグループ化
    groups: dict[str, list] = defaultdict(list)
    for s in speeches:
        groups[s["issueID"]].append(s)

    exchanges: list[dict] = []

    for issue_id, group in groups.items():
        group.sort(key=lambda s: s.get("speechOrder") or 0)

        current_q:   dict | None = None
        current_ans: list        = []

        def _flush():
            if current_q is None and not current_ans:
                return
            ref = current_q or current_ans[0]
            exchanges.append({
                "issueID":       ref["issueID"],
                "session":       ref["session"],
                "nameOfHouse":   ref["nameOfHouse"],
                "nameOfMeeting": ref["nameOfMeeting"],
                "issue":         ref["issue"],
                "imageKind":     ref["imageKind"],
                "date":          ref["date"],
                "question":      current_q,
                "answers":       list(current_ans),
            })

        for speech in group:
            if speech["is_minister"]:
                current_ans.append(speech)
            else:
                # 新しい質問が来たら直前の exchange を確定
                _flush()
                current_q   = speech
                current_ans = []

        _flush()  # 最後のブロックを確定

    # 日付降順（同日は speechOrder 降順）
    exchanges.sort(
        key=lambda e: (
            e.get("date", ""),
            (e["question"] or (e["answers"][0] if e["answers"] else {})).get("speechOrder") or 0
        ),
        reverse=True,
    )
    return exchanges[:MAX_EXCHANGES]


# ─── 保存 ─────────────────────────────────────────────────────────────────────
def save_diet(exchanges: list[dict], json_path: str) -> None:
    total_q   = sum(1 for e in exchanges if e["question"])
    total_ans = sum(len(e["answers"]) for e in exchanges)

    data = {
        "updated":         _iso_jst(),
        "total_exchanges": len(exchanges),
        "total_questions": total_q,
        "total_answers":   total_ans,
        "exchanges":       exchanges,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(json_path) / 1024
    print(f"  [保存] {len(exchanges)} exchanges "
          f"（質問 {total_q} 件 / 答弁 {total_ans} 件）  ({size_kb:.1f} KB)")


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
        print(f"  [スキップ] 前回更新から1時間以内です "
              f"（{d.get('total_exchanges', d.get('total', 0))} exchanges 保存済み）")
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
        time.sleep(0.5)

    print(f"  [取得合計] {len(all_raw)} 件（重複含む）")

    normalized = [normalize_speech(r) for r in all_raw]
    deduped    = dedup_speeches(normalized)
    print(f"  [重複排除後] {len(deduped)} 件")

    exchanges = build_exchanges(deduped)
    print(f"  [ペアリング] {len(exchanges)} exchanges 生成")

    save_diet(exchanges, json_path)
    print("=" * 52)


if __name__ == "__main__":
    main()
