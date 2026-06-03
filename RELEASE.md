# 发版流程

每次发版做这 4 步。私钥在 `~/.tauri/desktop-pet.key`（**不要进 git**）。

## 1. Bump 版本号

```bash
cd /Users/ristarhuang/CodeBuddy/陪我上班的桌宠/desktop-pet

# 三选一：
npm version patch   # 0.1.0 → 0.1.1（修 bug）
npm version minor   # 0.1.0 → 0.2.0（加 feature）
npm version major   # 0.1.0 → 1.0.0（破坏性变更）
```

> ⚠️ `npm version` 只改 `package.json`，**还要手动改一下 `src-tauri/tauri.conf.json` 的 `version` 字段**保持一致。

## 2. Build universal dmg

```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/desktop-pet.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # 生成密钥时设的空密码

npm run tauri build -- --target universal-apple-darwin
```

产物在：
- dmg：`src-tauri/target/universal-apple-darwin/release/bundle/dmg/Desktop-Pet_<version>_universal.dmg`
- 签名：同目录下 `*.app.tar.gz` + `*.app.tar.gz.sig`（updater 用的是 .app.tar.gz，不是 dmg；Tauri 会自动产出）

> 注意：`createUpdaterArtifacts: true` 已在 `tauri.conf.json` 配好，build 时会自动生成签名 artifacts。

## 3. 上传到 Vercel

把 3 个文件复制到 desktop-pet-web/public/：

```bash
VERSION=$(node -p "require('./package.json').version")
WEBDIR=/Users/ristarhuang/CodeBuddy/陪我上班的桌宠/desktop-pet-web/public

cp "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Desktop-Pet_${VERSION}_universal.dmg" \
   "$WEBDIR/Desktop-Pet-${VERSION}.dmg"

cp "src-tauri/target/universal-apple-darwin/release/bundle/macos/Desktop Pet.app.tar.gz" \
   "$WEBDIR/Desktop-Pet-${VERSION}.app.tar.gz"

cp "src-tauri/target/universal-apple-darwin/release/bundle/macos/Desktop Pet.app.tar.gz.sig" \
   "$WEBDIR/Desktop-Pet-${VERSION}.app.tar.gz.sig"
```

## 4. 写 latest.json

`desktop-pet-web/public/latest.json`：

```json
{
  "version": "0.2.0",
  "notes": "修了一堆频闪 bug + 新增默认形象 + 内置自动更新",
  "pub_date": "2026-06-03T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "<贴 .app.tar.gz.sig 文件内容>",
      "url": "https://desktop-pet.ristar.tech/Desktop-Pet-0.2.0.app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "<同上>",
      "url": "https://desktop-pet.ristar.tech/Desktop-Pet-0.2.0.app.tar.gz"
    }
  }
}
```

universal binary 一份 sig 同时配两个平台。

```bash
# 把 sig 内容贴进 latest.json：
cat "$WEBDIR/Desktop-Pet-${VERSION}.app.tar.gz.sig"
```

## 5. push 到 Vercel

```bash
cd "$WEBDIR/.."
git add public/Desktop-Pet-*.dmg public/Desktop-Pet-*.app.tar.gz* public/latest.json
git commit -m "release v${VERSION}"
git push
```

Vercel 自动部署。

## 验证

1. 装一个旧版本的 .dmg
2. 启动应用 → 主面板顶部应该出现暖色横幅"新版本 vX.Y.Z 已就绪 · 立即更新"
3. 点立即更新 → 下载 → 重启 → 应用版本号变新

## 故障排查

**横幅没出现**：
- 检查 endpoint URL 是否能访问（`curl https://desktop-pet.ristar.tech/latest.json`）
- 检查 `pub_date` 格式是否合法 ISO 8601
- 检查 `latest.json` 的 version 是否真的比当前应用 version 大

**签名验证失败**：
- 确认私钥没换（公钥在 `tauri.conf.json` 里硬编码）
- 确认 sig 文件内容贴对了（要贴整个文件内容，包括 `untrusted comment:` 那行）

**找不到对应平台**：
- universal binary 必须同时给 `darwin-x86_64` 和 `darwin-aarch64` 两个 entry，url 指向同一个 .app.tar.gz

## 私钥保管

- 路径：`~/.tauri/desktop-pet.key`
- 密码：空
- 备份：建议拷一份到 1Password / iCloud Keychain，**绝对不要进 git**
- 丢了怎么办：私钥丢了 = 不能再发更新（公钥已嵌进所有用户的应用，旧客户端不会信任新私钥签的更新）。需要重新生成 + 让用户手动重装（覆盖公钥）才能恢复
