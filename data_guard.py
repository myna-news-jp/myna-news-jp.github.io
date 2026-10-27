"""
取得データの健全性チェック（安全弁）

上流（Google News / デジタル庁CSV / 国会会議録API / Googleトレンド）の障害・仕様変更・
改ざんで異常なデータが返っても、そのまま公開面（GitHub Pages）へ反映しないための共通処理。
異常を検知したら「更新を見送り、前回データを保持」し、GitHub Actions の警告として可視化する。
"""

import datetime
import json
import os
import re

JST = datetime.timezone(datetime.timedelta(hours=9))
_HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)


def warn(msg: str) -> None:
    """GitHub Actions では警告アノテーション（実行サマリに表示）、ローカルでは通常出力。"""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::warning title=データ健全性チェック::{msg}")
    else:
        print(f"  [健全性チェック] {msg}")


def load_json(path: str):
    """前回データを読む。無い/壊れている場合は None。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def is_http_url(u) -> bool:
    return bool(u) and bool(_HTTP_RE.match(str(u).strip()))


def count_ok(label: str, new_count: int, prev_count: int | None,
             min_ratio: float = 0.5) -> bool:
    """件数が0、または前回の min_ratio 未満へ急減したら False（＝保存しない）。"""
    if new_count <= 0:
        warn(f"{label}: 取得件数が0件のため更新を見送り、前回データを保持します")
        return False
    if prev_count and new_count < prev_count * min_ratio:
        warn(f"{label}: 件数が急減（前回 {prev_count} → 今回 {new_count}）。"
             f"上流の障害・仕様変更の可能性があるため更新を見送り、前回データを保持します")
        return False
    return True


def drop_non_http_links(items: list[dict], key: str, label: str) -> list[dict]:
    """リンクが http(s) でない要素を除外する（javascript: 等の混入対策）。"""
    kept = [it for it in items if is_http_url(it.get(key))]
    if len(kept) != len(items):
        warn(f"{label}: http(s) 以外のリンクを持つ {len(items) - len(kept)} 件を除外しました")
    return kept


def drop_future_dated(items: list[dict], key: str, label: str,
                      tolerance_days: int = 1) -> list[dict]:
    """日付が未来（許容幅超え）の要素を除外する。日付降順の一覧の先頭への居座りを防ぐ。"""
    limit = datetime.datetime.now(JST) + datetime.timedelta(days=tolerance_days)
    kept, dropped = [], 0
    for it in items:
        try:
            dt = datetime.datetime.fromisoformat(str(it.get(key)))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=JST)
            if dt > limit:
                dropped += 1
                continue
        except Exception:
            pass   # 日付が解釈できない要素は残す（既存の挙動を変えない）
        kept.append(it)
    if dropped:
        warn(f"{label}: 未来日付の {dropped} 件を除外しました（誤データ・改ざんの可能性）")
    return kept
