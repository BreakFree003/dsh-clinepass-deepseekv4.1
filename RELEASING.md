# 发版清单（RELEASING）

给未来的自己看。**每次发版都要走完第 5 步 —— 它不是可选项。**

## 0. 先记住这一条：**tag ≠ Release**

`git push origin v1.2.3` 推上去的只是一个 **git tag**。GitHub 的 **Releases 页面**是另一个
对象，必须用 `gh release create`（或网页上点）**再建一次**，否则 Releases 页面上一片空白 ——
它不会因为 tag 存在就自动出现任何条目。

这个坑踩过一次：v0.7.1 / v0.7.2 的 tag 推上去了、Releases 页面却是空的，因为漏了第 5 步。
本仓库每个 release 都附带一个 `dsh-clinepass-<版本>.tgz`（`.gitignore` 里排除 `*.tgz`
正是为了让它们只作为 release 资产存在，不进仓库）。

## 1. 版本与文档

- 改 `package.json` 的 `version`；
- 在 `CHANGELOG.md` **顶部**加 `## <version>` 段（`test-package.mjs` 会断言「顶段 ==
  manifest 版本」，加错位置会直接把测试跑红）；
- 扫一遍 README / CHANGELOG 里**互相打架**的地方：计数、版本号、安装示例引用的 tag、
  以及「某行为已变」之后还留在 FAQ 里的旧说法。**记不住的数就不要写** ——
  写清结论即可（例：「写法换过很多种」而不是「一共试过 N 种」）。
  一个和别人对不上的数字，比没有数字更糟。
- 这次如果只动文档、代码没动，就明说（例：0.6.1「`index.js` 与 0.6.0 逐字节相同」）。

## 2. 跑测试

```sh
npm test    # test-package / test-fetch / test-settings / test-usage / test-install，五个都不需要外网
```

要报断言条数就**从输出里数**，不要凭记忆写：

```sh
node test-fetch.mjs | grep -c '^  ok'
```

## 3. commit + tag + push

```sh
git add -A && git commit -m "dsh-clinepass <version> — <一句话>"
git tag -a v<version> -m 'dsh-clinepass <version>'
git push origin main
git push origin v<version>
```

- tag 用 **annotated**（`-a`），message 跟已有的保持一致：`dsh-clinepass <version>`。
- **公开出去的 tag 不要重打。** README 里 v0.6.0 / v0.6.1 两处都记着这条：任何按 commit
  pin 过的 lockfile 都会被重打弄坏。
- 只给**真正产出过 `package.json` 版本**的版本打 tag / release。例：0.7.1 与 0.7.2 是同一批
  改动，`package.json` 直接跳到 0.7.2，所以 0.7.1 只有 CHANGELOG 段，没有 tag、也没有 release。

## 4. 打包

```sh
npm pack                              # → dsh-clinepass-<version>.tgz（零依赖、无生命周期脚本）
tar tzf dsh-clinepass-<version>.tgz   # 核对文件列表，应当与 package.json 的 files 一致
```

## 5. 建 Release（**别漏这一步**）

```sh
gh release create v<version> ./dsh-clinepass-<version>.tgz \
  --repo BreakFree003/dsh-clinepass-deepseekv4.1 \
  --title "v<version> — <一句话>" \
  --notes-file <notes.md> \
  --verify-tag
```

正文按已有 release 的结构写：**加粗一句话** → `## 这次做了什么` → `## 修掉的问题` →
（有实测就加 `## 实测记录`）→ `## 已知边界` → `## 安装` → `## 维护状态`。中文，和历史一致。

## 6. 验证（不要只看「创建成功」）

```sh
# 1) 出现在列表里、资产是 uploaded、并且成了 latest
curl -sS https://api.github.com/repos/BreakFree003/dsh-clinepass-deepseekv4.1/releases/latest

# 2) 下载回来的 tgz 与本地构建的逐字节相同
curl -sSL -o /tmp/dl.tgz \
  https://github.com/BreakFree003/dsh-clinepass-deepseekv4.1/releases/download/v<version>/dsh-clinepass-<version>.tgz
shasum -a 256 /tmp/dl.tgz dsh-clinepass-<version>.tgz

# 3) 解包后：版本号对、index.js 与仓库 HEAD 一致、打包不变量仍然成立
cd /tmp && tar xzf dl.tgz && grep '"version"' package/package.json && node package/test-package.mjs
```

## 7. 收尾

- `git status` 应当是 `## main...origin/main`，没有 ahead / behind；
- `dsh-clinepass-*.tgz` **不要**提交（`.gitignore` 已排除）。
