"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/image-lightbox";
import { formatBeijingDateTime } from "@/lib/business-time";
import { cleanupImageImports, correctImportCandidate, fetchImageImports, ImportIdentityChanged, reserveImportReference, submitSelectedMdBatch, uploadImportFile, type CandidateChanges, type ImportCandidate, type ImageImports, type ImportCleanup, type ImportMutation, type SelectedMdBatch } from "@/store/image-imports";
import { ReferenceThumbnail } from "./reference-thumbnail";

type Upload = { file: File; mutation: ImportMutation; url: string; progress: number; busy: boolean; error?: string; cancelled?: boolean };

export function ImageImportDialog({ open, onOpenChange, authKey, conversationId, model, quality, count, onCountChange, onAccepted }: {
  open: boolean; onOpenChange: (open: boolean) => void; authKey: string;
  conversationId: string | null; model: string; quality: string; count: string;
  onCountChange: (value: string) => void;
  onAccepted: (conversationId: string, submittedFrom: string | null) => Promise<void>;
}) {
  const [materials, setMaterials] = useState<ImageImports | null>(null);
  const current = useRef<ImageImports | null>(null);
  const [uploads, setUploads] = useState<Record<string, Upload>>({});
  const uploadsRef = useRef<Record<string, Upload>>({});
  const [mdUpload, setMdUpload] = useState<Upload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const pendingBatch = useRef<SelectedMdBatch | null>(null);
  const [submissionMessage, setSubmissionMessage] = useState("");
  const [failedCleanup, setFailedCleanup] = useState<ImportCleanup | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const mdInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const transfers = useRef(Array.from({ length: 4 }, () => Promise.resolve()));
  const nextTransfer = useRef(0);
  const mounted = useRef(true);
  const identityChanged = useRef(false);
  const handleImportError = useCallback((reason: unknown) => {
    if (reason instanceof ImportIdentityChanged) {
      identityChanged.current = true;
      current.current = null;
      for (const item of Object.values(uploadsRef.current)) URL.revokeObjectURL(item.url);
      uploadsRef.current = {};
      setMaterials(null);
      setUploads({});
      setMdUpload(null);
      setFailedCleanup(null);
      setPreview(null);
      setError(reason.message);
    }
    return (reason as Error).message;
  }, []);
  const accept = useCallback((next: ImageImports) => {
    if (mounted.current && !identityChanged.current && (!current.current || next.revision >= current.current.revision)) {
      current.current = next;
      setMaterials(next);
    }
  }, []);
  const refresh = useCallback(async () => accept(await fetchImageImports(authKey)), [accept, authKey]);
  function enqueue(operation: () => Promise<void>) {
    const next = queue.current.catch(() => {}).then(async () => {
      if (mounted.current && !identityChanged.current) await operation();
    });
    queue.current = next;
    void next.catch(() => {});
    return next;
  }
  function updateUpload(id: string, patch: Partial<Upload> | null) {
    const previous = uploadsRef.current[id];
    if (!previous) return;
    const next = { ...uploadsRef.current };
    if (patch) next[id] = { ...previous, ...patch };
    else { URL.revokeObjectURL(previous.url); delete next[id]; }
    uploadsRef.current = next;
    if (mounted.current) setUploads(next);
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const values = JSON.parse(localStorage.getItem("chatgpt2api:md_counts") || "{}");
      if (values && typeof values === "object") setCounts(Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string")) as Record<string, string>);
      const choices = JSON.parse(localStorage.getItem("chatgpt2api:md_selection") || "{}");
      if (choices && typeof choices === "object") setSelected(Object.fromEntries(Object.entries(choices).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>);
    } catch { /* preferences are optional */ }
    return () => {
      mounted.current = false;
      for (const item of Object.values(uploadsRef.current)) URL.revokeObjectURL(item.url);
    };
  }, []);
  useEffect(() => {
    if (open) void refresh().catch((reason: Error) => setError(handleImportError(reason)));
  }, [open, refresh, handleImportError]);

  async function sendReference(item: Upload) {
    const id = item.mutation.request_id;
    if (!mounted.current || identityChanged.current || !uploadsRef.current[id] || uploadsRef.current[id].cancelled) return;
    updateUpload(id, { busy: true, error: undefined });
    try {
      const result = await uploadImportFile(authKey, item.file, "reference", item.mutation, (progress) => updateUpload(id, { progress }));
      accept(result);
      if (!uploadsRef.current[id]?.cancelled) updateUpload(id, null);
    } catch (reason) {
      if (!uploadsRef.current[id]?.cancelled) updateUpload(id, { busy: false, error: handleImportError(reason) });
    }
  }
  function scheduleReference(item: Upload) {
    // Bound browser file transfers independently of generation/account capacity.
    const slot = nextTransfer.current++ % transfers.current.length;
    transfers.current[slot] = transfers.current[slot].catch(() => {}).then(() => sendReference(item));
  }
  function addReferences(files: File[]) {
    const selected = files.map((file): Upload => ({ file, mutation: { request_id: crypto.randomUUID(), version: current.current?.version ?? 0 }, url: URL.createObjectURL(file), progress: 0, busy: true }));
    for (const item of selected) uploadsRef.current[item.mutation.request_id] = item;
    setUploads({ ...uploadsRef.current });
    for (const item of selected) void enqueue(async () => {
      const id = item.mutation.request_id;
      if (uploadsRef.current[id]?.cancelled) return;
      try {
        item.mutation.version = current.current!.version;
        accept(await reserveImportReference(authKey, item.file, item.mutation));
        // Registration is ordered; file transfers may finish while further files are registered.
        scheduleReference(item);
      } catch (reason) {
        updateUpload(id, { busy: false, error: handleImportError(reason) });
      }
    });
  }
  function retryReference(item: Upload) {
    updateUpload(item.mutation.request_id, { busy: true, error: undefined });
    void enqueue(async () => {
      try {
        accept(await reserveImportReference(authKey, item.file, item.mutation));
        scheduleReference(item);
      } catch (reason) {
        updateUpload(item.mutation.request_id, { busy: false, error: handleImportError(reason) });
      }
    });
  }
  function replaceMd(files: File[]) {
    if (files.length !== 1) { setError("每次请选择一个 MD 文件"); return; }
    const item: Upload = { file: files[0], mutation: { request_id: crypto.randomUUID(), version: current.current!.version }, url: "", progress: 0, busy: true };
    setMdUpload(item);
    sendMd(item, true);
  }
  function sendMd(item: Upload, fresh = false) {
    setMdUpload({ ...item, busy: true, error: undefined });
    void enqueue(async () => {
      try {
        if (fresh) item.mutation.version = current.current!.version;
        accept(await uploadImportFile(authKey, item.file, "md", item.mutation, (progress) => setMdUpload({ ...item, progress, busy: true })));
        setMdUpload(null);
      } catch (reason) {
        const message = handleImportError(reason);
        if (!identityChanged.current) setMdUpload({ ...item, busy: false, error: message });
      }
    });
  }
  function cleanup(clear: boolean, uploadId?: string, retry?: ImportCleanup) {
    const ids = clear ? Object.keys(uploadsRef.current) : [uploadId!];
    for (const id of ids) updateUpload(id, { cancelled: true });
    setBusy(true);
    setError("");
    void enqueue(async () => {
      const operation = retry ?? { request_id: crypto.randomUUID(), version: current.current!.version, upload_ids: ids, clear };
      try {
        accept(await cleanupImageImports(authKey, operation));
        for (const id of ids) updateUpload(id, null);
        if (clear) setMdUpload(null);
        setFailedCleanup(null);
      } catch (reason) {
        setError(handleImportError(reason));
        if (!identityChanged.current) setFailedCleanup(operation);
        await refresh().catch(handleImportError);
      } finally { setBusy(false); }
    });
  }

  async function correct(key: string, changes: CandidateChanges, version: number, mdVersion: number) {
    await enqueue(async () => {
      try {
        accept(await correctImportCandidate(authKey, key, { request_id: crypto.randomUUID(), version, md_version: mdVersion }, changes));
      } catch (reason) {
        handleImportError(reason);
        await refresh().catch(handleImportError);
        throw reason;
      }
    });
  }

  const validCount = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100;
  const selectedCandidates = (materials?.candidates ?? []).filter(item => !item.skipped && item.status !== "error" && selected[item.config.document_id] !== false);
  const countsValid = validCount(count) && selectedCandidates.every(item => !counts[item.config.document_id] || validCount(counts[item.config.document_id]));
  function changeOverride(documentId: string, value: string) {
    const next = { ...counts, [documentId]: value };
    setCounts(next);
    try { localStorage.setItem("chatgpt2api:md_counts", JSON.stringify(next)); } catch { /* preferences are optional */ }
  }
  function changeSelection(next: Record<string, boolean>) {
    setSelected(next);
    try { localStorage.setItem("chatgpt2api:md_selection", JSON.stringify(next)); } catch { /* preferences are optional */ }
  }
  async function startBatch() {
    if (submitting || !materials || identityChanged.current) return;
    if (!pendingBatch.current) {
      if (!countsValid || !selectedCandidates.length) { setError("请选择有效条目，数量须为 1–100 的整数"); return; }
      pendingBatch.current = { request_id: crypto.randomUUID(), version: materials.version, md_version: materials.md_version,
        conversation_id: conversationId, model, quality, count: Number(count),
        entries: selectedCandidates.map(item => ({ key: item.key,
          ...(counts[item.config.document_id] ? { count: Number(counts[item.config.document_id]) } : {}) })) };
    }
    const submitted = pendingBatch.current;
    setSubmitting(true); setError(""); setSubmissionMessage("");
    try {
      const saved = await submitSelectedMdBatch(authKey, submitted);
      pendingBatch.current = null;
      setSubmissionMessage(`已接受 ${submitted.entries.length} 条；各条参考图就绪后自动生成。`);
      await onAccepted(saved.id, submitted.conversation_id);
    } catch (reason) {
      setError(handleImportError(reason));
    } finally { if (mounted.current) setSubmitting(false); }
  }

  const pending = materials?.pending ?? failedCleanup;
  const blocked = !materials || busy || !!materials.pending;
  const rows = [
    ...(materials?.references ?? []).map((item) => ({ ...item, upload: uploads[item.request_id] })),
    ...Object.entries(uploads).filter(([id]) => !materials?.references.some((item) => item.request_id === id))
      .map(([id, upload]) => ({ request_id: id, name: upload.file.name, size: upload.file.size, reference: null, error: undefined, upload })),
  ];
  const previewRow = rows.find(item => item.request_id === preview);
  const previewSource = previewRow?.reference?.url ?? previewRow?.upload?.url;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(94vw,960px)] flex-col gap-4 overflow-hidden p-4 sm:p-6">
      <DialogHeader className="shrink-0 pr-6">
        <DialogTitle>上传 MD 和参考图</DialogTitle>
        <DialogDescription>当前素材在所有生图会话中共享，关闭弹窗后保留。新 MD 直接替换，参考图追加。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {error && <p role="alert" className="mb-3 break-words text-sm text-rose-600">{error}</p>}
        {submissionMessage && <p role="status" className="mb-3 text-sm">{submissionMessage}</p>}
        {busy && <p role="status" className="mb-3 text-sm">正在清理当前素材…</p>}
        {!materials && !identityChanged.current && <p role="status">正在读取当前素材…</p>}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="min-w-0 rounded-2xl border p-3">
            <h3 className="mb-2 font-medium">MD 文件</h3>
            <input ref={mdInput} type="file" accept=".md,text/markdown" aria-label="选择 MD 文件" className="hidden" onChange={(event) => { replaceMd(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <button type="button" disabled={blocked || !!mdUpload?.busy} onClick={() => mdInput.current?.click()}
              onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!blocked && !mdUpload?.busy) replaceMd(Array.from(event.dataTransfer.files)); }}
              className="w-full rounded-xl border-2 border-dashed p-5 text-sm disabled:opacity-50">点击或拖入一个 MD 文件</button>
            <p className="mt-1 text-xs text-muted-foreground">UTF-8 编码，最大 5MB</p>
            {mdUpload && <div className="mt-3 break-words text-sm" role="status">
              <p>{mdUpload.file.name} · {mdUpload.busy ? `上传中 ${mdUpload.progress}%` : mdUpload.error}</p>
              {mdUpload.busy && <progress className="w-full" aria-label="MD 上传进度" max={100} value={mdUpload.progress} />}
              {!mdUpload.busy && <Button variant="outline" size="sm" onClick={() => sendMd(mdUpload)} disabled={blocked}>重试 MD 上传</Button>}
            </div>}
            {materials?.md && <div className="mt-3 min-w-0 text-sm">
              <p className="break-all font-medium">{materials.md.name} · {(materials.md.size / 1024).toFixed(1)} KB</p>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-stone-50 p-3 font-sans text-xs dark:bg-stone-900">{materials.md.content}</pre>
            </div>}
          </section>
          <section className="min-w-0 rounded-2xl border p-3">
            <h3 className="mb-2 font-medium">参考图 · {rows.length} 张</h3>
            <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-label="选择导入参考图" className="hidden" onChange={(event) => { addReferences(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <button type="button" disabled={blocked} onClick={() => referenceInput.current?.click()}
              onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!blocked) addReferences(Array.from(event.dataTransfer.files)); }}
              className="w-full rounded-xl border-2 border-dashed p-5 text-sm disabled:opacity-50">点击或拖入参考图，支持分批追加</button>
            <p className="mt-1 text-xs text-muted-foreground">PNG、JPEG、WebP、GIF，每张最大 50MB</p>
            <ul className="mt-3 max-h-80 space-y-3 overflow-y-auto overscroll-contain" aria-label="导入参考图列表">
              {rows.map((item) => {
                const source = item.reference?.url ?? item.upload?.url;
                const message = item.upload?.cancelled ? "正在移除或等待重试清理" : item.upload?.busy ? `上传中 ${item.upload.progress}%` : item.upload?.error ?? item.error;
                return <li key={item.request_id} className="flex min-w-0 items-start gap-2">
                  {source && <button type="button" className="shrink-0" aria-label={`预览导入参考图 ${item.name}`} onClick={() => setPreview(item.request_id)}><ReferenceThumbnail src={source} alt={item.name} className="size-12 rounded-lg object-cover" /></button>}
                  <div className="min-w-0 flex-1 text-xs"><p className="break-all">{item.name}</p><p>{(item.size / 1024).toFixed(1)} KB</p>
                    {message && <p role="status" className="break-words">{message}</p>}
                    {item.upload?.busy && !item.upload.cancelled && <progress className="w-full" aria-label={`${item.name} 上传进度`} max={100} value={item.upload.progress} />}
                    {item.upload?.error && !item.upload.cancelled && <button type="button" className="underline" disabled={blocked} onClick={() => retryReference(item.upload!)}>重试上传</button>}
                  </div>
                  <button type="button" disabled={blocked} className="shrink-0 text-xs underline disabled:opacity-50" aria-label={`移除导入参考图 ${item.name}`} onClick={() => cleanup(false, item.request_id)}>移除</button>
                </li>;
              })}
            </ul>
          </section>
        </div>
        {materials?.md && <section className="mt-4 min-w-0 space-y-3" aria-label="MD 条目预览">
          <h3 className="font-medium">MD 条目预览 · {materials.candidates.length} 条</h3>
          <p className="text-xs text-muted-foreground">仅使用下列 Prompt 和目标尺寸。缺少文件或结构错误需修正；等待上传表示文件已登记，尚未就绪。跳过的条目不提交。</p>
          <label className="flex flex-wrap items-center gap-2 text-sm">批量生成数量
            <input aria-label="批量生成数量" inputMode="numeric" value={count} onChange={event => onCountChange(event.target.value)} className="w-20 rounded-md border bg-background p-2" />
            <span className="text-xs text-muted-foreground">1–100，单条留空时沿用此值 · {model} / {quality}</span>
          </label>
          <div className="flex gap-3 text-xs"><button type="button" className="underline" onClick={() => changeSelection({ ...selected, ...Object.fromEntries(materials.candidates.map(item => [item.config.document_id, true])) })}>选择全部有效条目</button><button type="button" className="underline" onClick={() => changeSelection({ ...selected, ...Object.fromEntries(materials.candidates.map(item => [item.config.document_id, false])) })}>取消全选</button></div>
          {materials.candidates.length === 0 && <p role="status" className="text-sm">未识别到需要生成的条目。请检查章节标识、Prompt 区块，或文档是否声明直通。</p>}
          {materials.candidates.map((candidate) => <div key={candidate.key}>
            <div className="mb-1 flex flex-wrap items-center gap-3 text-sm">
              <label><input type="checkbox" aria-label={`选择 ${candidate.config.document_id}`} disabled={candidate.skipped || candidate.status === "error"} checked={!candidate.skipped && candidate.status !== "error" && selected[candidate.config.document_id] !== false} onChange={event => changeSelection({ ...selected, [candidate.config.document_id]: event.target.checked })} /> 选择</label>
              <label>单条数量 <input aria-label={`${candidate.config.document_id} 单条数量`} inputMode="numeric" placeholder={count} value={counts[candidate.config.document_id] || ""} onChange={event => changeOverride(candidate.config.document_id, event.target.value)} className="w-20 rounded-md border bg-background p-1" /></label>
              <span className="text-xs text-muted-foreground">生效：{counts[candidate.config.document_id] || count} 张</span>
            </div>
            <CandidatePreview candidate={candidate} version={materials.version} mdVersion={materials.md_version} disabled={blocked} onCorrect={correct} />
          </div>)}
        </section>}
      </div>
      <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t pt-3">
        <span className="basis-full text-xs text-muted-foreground sm:mr-auto sm:basis-auto">{materials?.updated_at ? `更新于 ${formatBeijingDateTime(materials.updated_at)}` : "尚未导入素材"}</span>
        <Button variant="outline" disabled={busy} onClick={() => { setError(""); setFailedCleanup(null); void refresh().catch((reason: Error) => setError(handleImportError(reason))); }}>刷新素材</Button>
        {pending && <Button variant="outline" disabled={busy} onClick={() => cleanup(pending.clear, pending.upload_ids[0], pending)}>重试清理</Button>}
        <Button variant="outline" disabled={blocked} onClick={() => cleanup(true)}>清除上传内容</Button>
        <Button disabled={submitting || (!pendingBatch.current && (blocked || !countsValid || !selectedCandidates.length))} onClick={() => void startBatch()}>{submitting ? "正在保存批量任务…" : pendingBatch.current ? "重试本次提交" : `开始生成（${selectedCandidates.length} 条）`}</Button>
        {pendingBatch.current && !submitting && <Button variant="outline" onClick={() => { pendingBatch.current = null; setSubmissionMessage("已解除重试；若服务器已接受，原批次仍会继续，可在会话历史查看。"); }}>准备新的提交</Button>}
        <Button onClick={() => onOpenChange(false)}>完成</Button>
      </DialogFooter>
      {previewRow && previewSource && <ImageLightbox open={!!preview} onOpenChange={(value) => { if (!value) setPreview(null); }} images={[{ id: previewRow.request_id, src: previewSource, filename: previewRow.name }]} currentIndex={0} onIndexChange={() => {}} />}
    </DialogContent>
  </Dialog>;
}

function CandidatePreview({ candidate, version, mdVersion, disabled, onCorrect }: {
  candidate: ImportCandidate; version: number; mdVersion: number; disabled: boolean;
  onCorrect: (key: string, changes: CandidateChanges, version: number, mdVersion: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ config: ImportCandidate["config"]; version: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { config } = candidate;
  const fieldNames: Record<string, string> = { document_id: "文档标识", name: "名称", prompt: "Prompt", size: "目标尺寸", output_name: "输出名称", reference_names: "参考图声明" };
  const conflicts = [...new Set(candidate.errors.filter(item => item.code === "conflicting_field" || item.code === "unclosed_prompt").map(item => item.field))];
  const title = `${config.document_id} ${config.name}`.trim();
  const status = { ready: "已就绪", pending: "等待上传", error: "需要修正" }[candidate.status];
  async function save(changes: CandidateChanges, baseVersion: number) {
    setSaving(true);
    setError("");
    try {
      await onCorrect(candidate.key, changes, baseVersion, mdVersion);
      setDraft(null);
    } catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  }
  function edit() { setError(""); setDraft({ config: { ...config }, version }); }
  const inputClass = "mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm";
  return <article className="min-w-0 rounded-xl border p-3 text-sm" aria-label={`条目 ${title}`}>
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="min-w-0 flex-1 break-words font-medium">{title}</h4>
      <span role="status" className={candidate.status === "error" ? "text-rose-600" : "text-muted-foreground"}>{candidate.skipped ? `已跳过 · ${status}` : status}</span>
      <Button size="sm" variant="outline" disabled={disabled || saving} onClick={() => void save({ skipped: !candidate.skipped }, version)}>{candidate.skipped ? "取消跳过" : "跳过此条"}</Button>
    </div>
    <p className="mt-2 break-all">目标尺寸：{config.size || "缺失"} · 输出名称：{config.output_name || "未指定（按条目命名）"}</p>
    <details className="mt-2">
      <summary className="cursor-pointer">查看实际 Prompt（{config.prompt.length} 字符）</summary>
      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-sans text-xs">{config.prompt || "缺少明确的 Prompt 区块"}</pre>
    </details>
    <p className="mt-2 text-xs">参考图（按声明顺序）：{config.reference_names === null ? "缺少声明" : config.reference_names.length === 0 ? "明确无参考图" : ""}</p>
    <ol className="mt-1 space-y-1">
      {candidate.matches.map((match, index) => <li key={`${index}:${match.name}`} className="flex min-w-0 items-center gap-2 text-xs">
        {match.reference && <ReferenceThumbnail src={match.reference.url} alt={match.name} className="size-10 shrink-0 rounded object-cover" />}
        <span className="min-w-0 break-all">{index + 1}. {match.name} · {match.status === "ready" ? "已匹配" : match.status === "pending" ? "已登记，等待上传" : "未匹配或有冲突"}</span>
      </li>)}
    </ol>
    {candidate.errors.length > 0 && <ul className="mt-2 space-y-1 text-xs text-rose-600" aria-label="条目错误">
      {candidate.errors.map((item, index) => <li key={index} className="break-words">{item.message}</li>)}
    </ul>}
    {error && <p role="alert" className="mt-2 break-words text-rose-600">{error}</p>}
    {!draft ? <Button className="mt-3" variant="outline" size="sm" disabled={disabled || saving} onClick={edit}>修正此条</Button> :
      <form className="mt-3 space-y-3" onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const changes: CandidateChanges = {};
        for (const key of ["document_id", "name", "prompt", "size", "output_name"] as const) {
          const value = key === "output_name" ? String(fields.get(key) || "") || null : String(fields.get(key) || "");
          if (value !== draft.config[key] || fields.has(`confirm_${key}`)) Object.assign(changes, { [key]: value });
        }
        const mode = String(fields.get("reference_mode"));
        const listedNames = String(fields.get("reference_names") || "").split(/\r?\n/).filter(name => name.length > 0);
        const names = mode === "missing" || (mode === "files" && listedNames.length === 0) ? null : mode === "none" ? [] : listedNames;
        if (JSON.stringify(names) !== JSON.stringify(draft.config.reference_names) || fields.has("confirm_reference_names")) changes.reference_names = names;
        if (Object.keys(changes).length) void save(changes, draft.version);
        else setDraft(null);
      }}>
        <div key={draft.version} className="space-y-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label>文档标识<input className={inputClass} name="document_id" defaultValue={draft.config.document_id} /></label>
            <label>名称<input className={inputClass} name="name" defaultValue={draft.config.name} /></label>
            <label>目标尺寸<input className={inputClass} name="size" placeholder="1600x1600" defaultValue={draft.config.size} /></label>
            <label>输出名称（可留空）<input className={inputClass} name="output_name" defaultValue={draft.config.output_name ?? ""} /></label>
          </div>
          <label className="block">Prompt<textarea aria-label="Prompt" className={inputClass} rows={6} name="prompt" defaultValue={draft.config.prompt} /></label>
          <label className="block">参考图声明<select aria-label="参考图声明" className={inputClass} name="reference_mode" defaultValue={draft.config.reference_names === null ? "missing" : draft.config.reference_names.length ? "files" : "none"}>
            <option value="missing">尚未声明（无效）</option><option value="none">明确无参考图</option><option value="files">使用以下文件，按行匹配</option>
          </select></label>
          <label className="block">参考图文件名（每行一个，保留顺序和大小写）<textarea aria-label="参考图文件名（每行一个，保留顺序和大小写）" className={inputClass} rows={3} name="reference_names" defaultValue={draft.config.reference_names?.join("\n") ?? ""} /></label>
          {conflicts.map(field => <label key={field} className="flex items-start gap-2 text-xs"><input type="checkbox" name={`confirm_${field}`} />确认以表单中的{fieldNames[field]}修正该字段冲突</label>)}
        </div>
        {draft.version !== version && <p className="text-xs text-amber-700">素材版本已变化，请重新载入此条后修正。</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={disabled || saving}>{saving ? "正在保存并校验…" : "保存并校验"}</Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={edit}>重新载入此条</Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setDraft(null)}>取消修正</Button>
        </div>
      </form>}
  </article>;
}
