---
title: Interface-0002 AHS 归档读写契约
description: AHS 磁盘归档的写入/读取 API：exportSessions/writeArchive/readManifest/readRecords/readBlob，blob 外置与完整性校验语义。
type: interface
status: proposed
created: 2026-07-21T13:30:00Z
---

# AHS Archive

AHS 磁盘归档（布局见 [spec/0001-ahs.md](../spec/0001-ahs.md) "磁盘布局与 blob 外置"）的读写契约。权威实现：`src/ahs/writer.ts`、`src/ahs/reader.ts`。

## 写入

```typescript
writeArchive(adapter: HarnessAdapter, sessionId: string, outDir: string): Promise<void>
exportSessions(adapter: HarnessAdapter, outDir: string, filter?: SessionFilter): Promise<void>
```

- 每 session 产出 `<outDir>/<sanitized-sessionId>/manifest.json` + `records.jsonl`（seq 升序，JSON key 排序）
- **blob 外置**：文本块或 tool_result 内容 > 64 KiB → `blobs/sha256-<hex>`，record 内替换为 `BlobRef`（含 256 字符 preview）
- **幂等**：重复导出同一 outDir 字节一致；已存在的 blob 跳过重写
- sessionId 目录名净化：`[A-Za-z0-9.-]` 以外字符按 UTF-8 字节转义为 `_xHH`（`_` 自身也转义），单射可逆

## 读取

```typescript
readManifest(dir: string): Promise<Manifest>
readRecords(dir: string): AsyncIterable<AhsRecord>
readBlob(dir: string, sha256: string): Promise<Uint8Array>
```

- Manifest 与 record 均经 zod 校验，非法即抛错
- `readBlob` 重新哈希校验完整性，不匹配即抛错
- 读取方**不需要**任何适配器/源存储知识——关系图通过扫描各 session 的 manifest.json 重建（AC 层4 的核心断言）

## 消费方参考实现

`examples/ahs-report.ts`：`renderReport(archiveRoot, sessionId)` 渲染可读 transcript（含沿 spawned_by 递归的子 session 缩进渲染）并聚合跨 session 的 Usage 总量。此为 AC 层4"可用"验收的实证。
