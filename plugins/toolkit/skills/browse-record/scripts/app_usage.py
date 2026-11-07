"""Turn existing ScreenJournal day queries into per-device browsing cards."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import socket
import subprocess
import sys
import uuid
from zoneinfo import ZoneInfo

APP_NAMES = {
    "com.runweave.app.native": "Runweave", "com.runweave.suiji": "随记",
    "com.tencent.xin": "微信",
    "com.zhihu.ios": "知乎", "com.openai.chat": "ChatGPT",
    "com.apple.mobilesafari": "Safari", "com.google.ios.youtube": "YouTube",
    "tv.danmaku.bilianime": "哔哩哔哩", "com.ss.iphone.ugc.Aweme": "抖音",
    "com.bot.doubao": "豆包",
    "com.apple.control-center": "控制中心", "com.apple.InCallService": "通话界面",
    "com.apple.springboard.home-screen-open-folder": "主屏幕文件夹",
    "com.apple.springboard.today-view": "今天视图", "com.apple.Preferences": "设置",
    "com.apple.camera": "相机", "com.apple.mobilephone": "电话", "com.apple.MobileSMS": "信息",
}


def source_identity(archive):
    path = Path(archive).expanduser()
    if not path.is_absolute() or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError("Archive must be an absolute path without symlinks")
    # This binds a local user's archive, not an inferred Apple account.
    value = socket.gethostname() + ":" + str(path.resolve())
    return "screenjournal:" + hashlib.sha256(value.encode()).hexdigest()


def duration(seconds):
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("Invalid app duration")
    if 0 < seconds < 1:
        return "不足 1 秒"
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    return " ".join(value for value in [f"{hours} 小时" if hours else "", f"{minutes} 分钟" if minutes else "", f"{secs} 秒" if secs or not seconds else ""] if value)


def local_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S") if value else "暂无记录"


def card(device, data):
    identity = device.get("identity") or {}
    device_id = device["device_id"]
    name = identity.get("name") or identity.get("device_kind") or "设备"
    if name == "iphone":
        name = "iPhone"
    name += " · " + device_id[-8:]
    apps = device["apps"]
    summary = duration(device["seconds"]) + f" · {len(apps)} 个应用标识" if apps else "暂无可计算时长，不代表未使用"
    lines = ["前台使用时长：" + summary,
             "最新设备事件：" + local_time(device["last_event"]),
             "归档更新：" + local_time(data["latest_snapshot_at"]),
             "仅为已观察到的前台焦点记录，可能延迟或缺失；不等同于 Apple 官方屏幕使用时间。",
             "设备：" + name + "（" + (identity.get("hardware_model") or "型号未知") + "）",
             "日期：" + data["date"] + "（上海时区）", "", "应用时长排行（含系统界面标识）"]
    for index, app in enumerate(apps, 1):
        label = APP_NAMES.get(app["app_id"], app["app_id"])
        lines.append(f"{index}. {label}：{duration(app['seconds'])}")
    if apps:
        lines += ["", "已匹配区间：" + duration(sum(a["matched_seconds"] for a in apps)),
                  "推断区间：" + duration(sum(a["inferred_seconds"] for a in apps)),
                  "超过 4 小时的区间：" + duration(sum(a["over_4h_seconds"] for a in apps))]
    return name + " · " + summary, "\n".join(lines)


def collect(c, options):
    if source_identity(c["archivePath"]) != c["externalAccountId"]:
        raise ValueError("ARCHIVE_IDENTITY_CHANGED")
    tools = [Path(__file__).resolve().parents[5] / "packages/screen-recording-macos/tools/app-usage/archive.py",
             Path("/Applications/ScreenJournal.app/Contents/Resources/AppUsageTools/archive.py")]
    tool = next((p for p in tools if p.is_file()), None)
    if tool is None:
        raise ValueError("App usage archive tool is unavailable")
    day, finish = dt.date.fromisoformat(options["from"]), dt.date.fromisoformat(options["to"])
    if finish < day or (finish - day).days > 30:
        raise ValueError("App usage imports allow at most 31 days")
    captured = dt.datetime.now(dt.timezone.utc).isoformat()
    items, snapshot = [], None
    while day <= finish:
        result = subprocess.run([sys.executable, str(tool), "--archive", c["archivePath"], "day", day.isoformat(), "--timezone", c["timeZone"]], capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise ValueError("App usage archive query failed")
        data = json.loads(result.stdout)
        if data["date"] != day.isoformat() or data["timezone"] != c["timeZone"] or not data["latest_snapshot_at"]:
            raise ValueError("Invalid or empty app usage archive")
        if snapshot is not None and snapshot != data["latest_snapshot_at"]:
            raise ValueError("Archive changed during collection; collect again")
        snapshot = data["latest_snapshot_at"]
        occurred = dt.datetime.combine(day, dt.time(), ZoneInfo(c["timeZone"])).isoformat()
        for device in data["devices"]:
            # Device mappings without any observed events are not usage sources.
            if not device["first_event"]:
                continue
            title, body = card(device, data)
            items.append({"observation": {"contentType": "app-usage", "contentId": device["device_id"], "readTime": occurred, "observedAt": captured},
                          "entry": {"captureId": str(uuid.uuid4()), "browseDate": day.isoformat(), "occurredAt": occurred, "capturedAt": captured,
                                    "title": title, "body": body, "userNote": "", "source": {"provider": "app-usage", "displayName": "App 使用时长", "connectionId": c["connectionId"]},
                                    "contentType": "app-usage", "captureMethod": "connector", "sourceUrl": None, "contentState": {"state": "available", "reason": None}, "attachmentIds": []}})
        day += dt.timedelta(days=1)
    return {"identityBefore": c["externalAccountId"], "identityAfter": source_identity(c["archivePath"]), "items": items,
            "coverage": {"state": "partial", "pages": 0, "metadata": len(items), "content": len(items), "errors": ["observed-only"]}, "historyUnchanged": True}
