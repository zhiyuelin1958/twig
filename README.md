# Twig

读论文时，一个问题往往引出下一个问题，对话越长越乱。Twig 把阅读过程画成一棵树：论文各节沿主干竖排，追问向右分叉，每个节点有一张知识卡片。回头复习时，顺着线就能看出“先懂什么，才能懂什么”。

## 功能

- **实时预览**：打开任意 `*_twig.md`，点编辑器右上角的树形图标，旁边出现树状图，编辑后自动刷新。Ctrl + 滚轮或右下角按钮缩放，按住空白处拖动平移。
- **知识卡片**：点方框打开卡片。卡片里的 `[文字](#id)` 链接可跳到其他节点。
- **节点状态**：虚线框表示暂挂的问题，米黄框表示超出本文范围的拓展问题。
- **跳转原文**：在文件开头的元信息里写上论文 PDF 的路径和起始页码后，点卡片中的【原文 · … p.994】就会打开论文并跳到该页。此功能需要另装 [PDF Viewer](https://marketplace.visualstudio.com/items?itemName=mathematic.vscode-pdf) 扩展。
- **导出网页**：右键 `*_twig.md` →“导出 HTML”，生成一个独立网页，可以直接发给别人。
- **新建**：命令面板执行“Twig：新建 Twig”，从模板新建文件。

## 文件格式

```markdown
---
title: 作者 (年份) Twig
progress: §1 引言
current: s1
pdf: ../论文.pdf
firstPage: 991
---

## 全文主线：一句话说清这篇论文 {#topic}

【原文 · §1 p.991】
卡片正文，支持表格、列表、引用、$N_{0r}$ 这类行内公式。

## §1 引言：这节在做什么 {#s1}

## 追问的问题？ {#q1 parent=s1 status=pending}
```

| 元信息 | 含义 |
|---|---|
| `progress` | 主线读到哪，显示在页面顶部 |
| `current` | 当前所在节点的 id，方框高亮 |
| `pdf` | 论文 PDF 的路径，相对于 Twig 文件 |
| `firstPage` | PDF 第 1 页对应的期刊页码，用于把卡片中的期刊页码换算成 PDF 页码 |

节点标题写成 `## 标题 {#id parent=父节点id status=pending}`：不写 `parent` 即为主干；`status` 可取 `pending`（暂挂）或 `extra`（超出本文）。

## 配合 AI 使用（可选）

扩展自带一套书写规则（skill `twig`），说明 AI 应如何维护 Twig 文件、写知识卡片、标注出处。第一次启动时扩展会询问是否安装：

- 同意后，规则写入家目录下 `.claude/skills/twig`；本机装有 Codex、Gemini 时，也会写入 `.codex/skills`、`.gemini/skills`。Copilot 读取 Claude Code 的目录；
- 安装后，对 AI 说“开始读某篇论文”即可；
- 之后扩展升级时，规则会随之自动更新。设置中的 `twig.installSkill` 可以关闭自动更新；命令“Twig：重新安装 AI 书写规则”可以手动安装。

## 许可

MIT
