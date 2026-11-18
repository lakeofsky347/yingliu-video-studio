# 语言与文案 / Language and localization

## 中文

工作台跟随 **DSH 设置 → 通用 → 语言**，支持中文（`zh`）和英文（`en`）。切换语言会更新界面，不会改写工程内容；新建影片和镜头的默认文字使用创建时的界面语言。

维护文案时遵循以下约定：

- 新的界面文字通过 `src/client/i18n.ts` 的 `t()` 显示，中文原句作为键，英文译文放入 `src/locales/` 下对应词典。需要响应语言切换的组件使用 `useLocale()`。
- 任务状态和错误记录保留原始文案，在已明确属于系统提示的展示位置调用 `systemMessage()`。只有已收录的提示会翻译，未识别的原文保持不变。
- 不翻译用户工程里的片名、镜头文字、字幕、素材名称、源码和未保存草稿，也不翻译模型或服务商返回的原始内容。界面语言不决定影片语言。
- `{name}`、`{0}` 等参数占位符必须完整保留，可调整语序，不能增删或改名；参数中的用户内容保持原样。
- 日期通过 `formatDate()` 显示，中文使用 `zh-CN`，英文使用 `en-US`；存储的时间不变，默认沿用设备时区。

新增或修改文案后，在仓库根目录运行：

```sh
npm run typecheck
node --import tsx --test tests/localization.test.ts tests/localization-ui.test.ts tests/localization-media-ui.test.ts tests/localized-spec.test.ts
```

这些检查覆盖词典与占位符、语言切换、默认文字，以及编辑草稿和画布状态的保留。界面测试需要可用的本地 Chromium；未检测到浏览器时会跳过。

主要使用说明提供 [中文 README](../README.md) 和 [English README](../README.en.md)。历史记录和专题文档目前仍以中文为主。

## English

The studio follows **DSH Settings → General → Language** and supports Chinese (`zh`) and English (`en`). Switching languages updates the interface without rewriting project content. New films and shots use the interface language at creation for their default text.

When maintaining text:

- Display new UI text through `t()` from `src/client/i18n.ts`. Use the Chinese source text as the key and add its English translation to the appropriate dictionary under `src/locales/`. Components that need to respond to language changes use `useLocale()`.
- Store task statuses and errors in their original wording. Call `systemMessage()` only where a field is explicitly a system message. Known messages are translated; unrecognized text stays unchanged.
- Preserve user-authored film titles, shot text, subtitles, asset names, source code, and unsaved drafts. Keep raw model and provider output unchanged. The interface language does not determine the film's language.
- Preserve every parameter placeholder, such as `{name}` or `{0}`. You may reorder placeholders, but never add, remove, or rename them. User content passed as a parameter stays unchanged.
- Display dates with `formatDate()`, using `zh-CN` for Chinese and `en-US` for English. Stored timestamps stay unchanged, and the device time zone is used by default.

After adding or changing text, run these checks from the repository root:

```sh
npm run typecheck
node --import tsx --test tests/localization.test.ts tests/localization-ui.test.ts tests/localization-media-ui.test.ts tests/localized-spec.test.ts
```

The checks cover dictionaries and placeholders, language switching, default text, and preservation of editor drafts and canvas state. UI tests require a local Chromium browser and are skipped when no browser is detected.

The main user guide is available as the [Chinese README](../README.md) and [English README](../README.en.md). Historical and topic-specific documents remain primarily in Chinese.
