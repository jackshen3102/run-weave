#!/usr/bin/env bash
#
# app-ios-resign.sh — 重新签名并重装 Runweave 到 iPhone
#
# 用途：免费 Apple ID 的描述文件只有 7 天有效期，到期后 app 会闪退。
#       本脚本一条命令完成：重建 web 产物 → 同步 → 重新签名编译 → 重装到设备。
#
# 用法：
#   ./scripts/app-ios-resign.sh              # 自动选择已连接的设备
#   ./scripts/app-ios-resign.sh --check      # 只查描述文件剩余天数，不做任何改动
#   ./scripts/app-ios-resign.sh --device <UDID>   # 指定设备
#   ./scripts/app-ios-resign.sh --skip-web   # 跳过 web 构建（仅重签名，更快）
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
IOS_DIR="$APP_DIR/ios"
XCODE_PROJ_DIR="$IOS_DIR/App"
BUILD_DIR="$IOS_DIR/DerivedData/codex-ios-build"
PKG_CACHE_DIR="$IOS_DIR/DerivedData/codex-ios-packages"
APP_BUNDLE="$BUILD_DIR/Build/Products/Debug-iphoneos/App.app"
BUNDLE_ID="com.runweave.app"
SDK="iphoneos"

DEVICE_UDID=""
SKIP_WEB=0
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE_UDID="${2:-}"; shift 2 ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[resign]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 检查描述文件剩余有效期 ----------
profile_days_left() {
  local best=-1
  local dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  [[ -d "$dir" ]] || { echo "-1"; return; }
  shopt -s nullglob
  for f in "$dir"/*.mobileprovision; do
    local plist name exp
    plist="$(security cms -D -i "$f" 2>/dev/null)" || continue
    name="$(printf '%s' "$plist" | plutil -extract Name raw - 2>/dev/null)" || continue
    [[ "$name" == *"$BUNDLE_ID"* ]] || continue
    exp="$(printf '%s' "$plist" | plutil -extract ExpirationDate raw - 2>/dev/null)" || continue
    local exp_epoch now_epoch days
    exp_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$exp" '+%s' 2>/dev/null)" || continue
    now_epoch="$(date '+%s')"
    days=$(( (exp_epoch - now_epoch) / 86400 ))
    (( days > best )) && best=$days
  done
  shopt -u nullglob
  echo "$best"
}

DAYS_LEFT="$(profile_days_left)"
if [[ "$DAYS_LEFT" == "-1" ]]; then
  warn "未找到 $BUNDLE_ID 的描述文件（首次运行或已被清理，将重新申请）"
else
  if (( DAYS_LEFT <= 0 )); then
    warn "描述文件已过期，app 现在会闪退 —— 需要重签"
  elif (( DAYS_LEFT <= 2 )); then
    warn "描述文件剩余 ${DAYS_LEFT} 天，建议现在重签"
  else
    ok "描述文件剩余 ${DAYS_LEFT} 天"
  fi
fi

# 顺带报一下证书（1 年期，通常不用管）
CERT_LINE="$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 'Apple Development' || true)"
if [[ -z "$CERT_LINE" ]]; then
  die "本机没有有效的 Apple Development 签名证书。
     请在 Xcode → Settings → Apple Accounts → 选中账号 → 双击 Personal Team
     → Manage Certificates… → 左下 + → Apple Development 重新签发。"
fi
ok "签名证书可用"

if (( CHECK_ONLY )); then
  log "--check 模式，未做任何改动"
  exit 0
fi

# ---------- 选择设备 ----------
if [[ -z "$DEVICE_UDID" ]]; then
  log "探测已连接设备…"
  JSON=/tmp/rw_devices_$$.json
  xcrun devicectl list devices --json-output "$JSON" >/dev/null 2>&1 || die "无法枚举设备"
  DEVICE_UDID="$(python3 - "$JSON" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get('result', {}).get('devices', [])
# 优先 connected；同等条件下优先 wired（更稳）
def rank(d):
    cp = d.get('connectionProperties', {})
    state = cp.get('tunnelState')
    transport = cp.get('transportType')
    if state == 'connected':
        return 0 if transport == 'wired' else 1
    return 9
best = sorted(devices, key=rank)
for d in best:
    cp = d.get('connectionProperties', {})
    if cp.get('tunnelState') == 'connected':
        print(d.get('hardwareProperties', {}).get('udid', ''))
        break
PY
)"
  rm -f "$JSON"
  [[ -n "$DEVICE_UDID" ]] || die "没有已连接的设备。
     请用数据线连接 iPhone 并解锁（首次需点\"信任此电脑\"），
     或在 Xcode → Window → Devices and Simulators 勾选
     \"Connect via network\" 以启用无线安装。"
fi
ok "目标设备: $DEVICE_UDID"

# ---------- 构建 web 产物 ----------
if (( SKIP_WEB )); then
  log "跳过 web 构建（--skip-web）"
  [[ -d "$APP_DIR/dist" ]] || die "app/dist 不存在，首次运行不能用 --skip-web"
else
  log "构建 web 产物…"
  ( cd "$REPO_ROOT" && pnpm --filter @runweave/app build ) || die "web 构建失败"
  ok "web 产物就绪"
fi

# ---------- 同步到原生工程 ----------
log "同步到 iOS 工程…"
( cd "$APP_DIR" && npx capacitor sync ios ) || die "capacitor sync 失败"
ok "同步完成"

# ---------- 编译 + 重新签名 ----------
# 说明：
#   SUPPORTED_PLATFORMS=iphoneos  绕过本机 destination 解析异常（模拟器运行时未装时会误报）
#   -disableAutomaticPackageResolution + 固定 PKG_CACHE_DIR  复用已缓存的 xcframework，避免联网拉包
#   -allowProvisioningUpdates  让 Xcode 自动续签描述文件（这一步就是"续期"的本体）
log "编译并重新签名（这一步会自动续签描述文件）…"
BUILD_LOG=/tmp/rw_build_$$.log
if ! ( cd "$XCODE_PROJ_DIR" && xcodebuild \
        -scheme App \
        -configuration Debug \
        -sdk "$SDK" \
        -arch arm64 \
        -allowProvisioningUpdates \
        -derivedDataPath "$BUILD_DIR" \
        -clonedSourcePackagesDirPath "$PKG_CACHE_DIR" \
        -disableAutomaticPackageResolution \
        SUPPORTED_PLATFORMS=iphoneos \
        build ) >"$BUILD_LOG" 2>&1; then
  echo "--- 构建日志尾部 ---" >&2
  tail -30 "$BUILD_LOG" >&2
  die "编译失败，完整日志: $BUILD_LOG"
fi
grep -q '\*\* BUILD SUCCEEDED \*\*' "$BUILD_LOG" || {
  tail -30 "$BUILD_LOG" >&2
  die "未见 BUILD SUCCEEDED，日志: $BUILD_LOG"
}
rm -f "$BUILD_LOG"
[[ -d "$APP_BUNDLE" ]] || die "产物不存在: $APP_BUNDLE"
ok "编译成功"

# 校验签名真的有效（不只看编译退出码）
codesign --verify --deep --strict "$APP_BUNDLE" 2>/dev/null \
  && ok "签名校验通过" \
  || warn "codesign 校验有告警，若安装失败请检查证书"

# ---------- 安装 ----------
log "安装到设备…"
xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_BUNDLE" \
  || die "安装失败。若提示设备锁定，请解锁 iPhone 后重试。"
ok "安装完成"

# ---------- 验证新的有效期 ----------
NEW_DAYS="$(profile_days_left)"
echo
ok "全部完成 —— 描述文件已续期，剩余 ${NEW_DAYS} 天"
log "下次到期前重新运行本脚本即可；查剩余天数: ./scripts/app-ios-resign.sh --check"
