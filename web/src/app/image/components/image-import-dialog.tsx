"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileText, Images, X } from "lucide-react";
import { ImageLightbox } from "@/components/image-lightbox";
import { cleanupImageImports, correctImportCandidate, fetchImageImports, ImportIdentityChanged, reserveImportReference, submitSelectedMdBatch, uploadImportFile, type CandidateChanges, type ImportCandidate, type ImageImports, type ImportCleanup, type ImportMutation, type SelectedMdBatch } from "@/store/image-imports";
import { ReferenceThumbnail } from "./reference-thumbnail";
import type { ImageConversation } from "@/store/image-conversations";

type Upload = { file: File; mutation: ImportMutation; url: string; progress: number; busy: boolean; error?: string; cancelled?: boolean };

export function ImageImportDialog({ open, onOpenChange, authKey, conversationId, draftId, model, quality, count, onCountChange, onAccepted }: {
  open: boolean; onOpenChange: (open: boolean) => void; authKey: string;
  conversationId: string | null; model: string; quality: string; count: string;
  draftId?: string;
  onCountChange: (value: string) => void;
  onAccepted: (conversation: ImageConversation, submittedFrom: string | null, draftId?: string) => Promise<void>;
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
  function changeGlobalCount(value: string) {
    onCountChange(value);
    setCounts({});
    try { localStorage.removeItem("chatgpt2api:md_counts"); } catch { /* preferences are optional */ }
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
        conversation_id: conversationId, draft_id: conversationId ? undefined : draftId, model, quality, count: Number(count),
        entries: selectedCandidates.map(item => ({ key: item.key,
          ...(counts[item.config.document_id] ? { count: Number(counts[item.config.document_id]) } : {}) })) };
    }
    const submitted = pendingBatch.current;
    setSubmitting(true); setError(""); setSubmissionMessage("");
    try {
      const saved = await submitSelectedMdBatch(authKey, submitted);
      pendingBatch.current = null;
      setSubmissionMessage(`已接受 ${submitted.entries.length} 条；各条参考图就绪后自动生成。`);
      await onAccepted(saved, submitted.conversation_id, submitted.draft_id);
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
  const candidates = materials?.candidates ?? [];
  const declaredNames = new Set(candidates.flatMap((candidate) => candidate.config.reference_names ?? []));
  const nameCounts = new Map<string, number>();
  rows.forEach((row) => nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1));
  const missing = [...new Set(candidates.flatMap((candidate) => candidate.matches.filter((match) => !nameCounts.has(match.name)).map((match) => match.name)))];
  const conflicts = [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name);
  const unused = [...nameCounts.keys()].filter((name) => !declaredNames.has(name) && nameCounts.get(name) === 1);
  const total = selectedCandidates.reduce((sum, item) => sum + (validCount(counts[item.config.document_id] || count) ? Number(counts[item.config.document_id] || count) : 0), 0);
  const pendingTotal = pendingBatch.current?.entries.reduce((sum, item) => sum + (item.count ?? pendingBatch.current!.count), 0);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] w-[min(94vw,860px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:rounded-3xl sm:max-w-[860px]">
      <DialogHeader className="shrink-0 px-5 pb-4 pt-5 pr-10 sm:px-7 sm:pt-6">
        <DialogTitle>导入 Prompt 包</DialogTitle>
        <DialogDescription>上传 Markdown 和参考图，选择条目后生成。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-4 sm:px-7">
        {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
        {submissionMessage && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700">{submissionMessage}</p>}
        {busy && <p role="status" className="text-xs">正在清理当前素材…</p>}
        {!materials && !identityChanged.current && <p role="status" className="text-sm">正在读取当前素材…</p>}
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <input ref={mdInput} type="file" accept=".md,text/markdown" aria-label="选择 MD 文件" className="hidden" onChange={(event) => { replaceMd(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" disabled={blocked || !!mdUpload?.busy} onClick={() => mdInput.current?.click()}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!blocked && !mdUpload?.busy) replaceMd(Array.from(event.dataTransfer.files)); }}
            className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 px-3 py-5 text-sm hover:bg-stone-100 disabled:opacity-50">
            <FileText className="size-5 text-stone-400" /><span className="line-clamp-2 break-all">{mdUpload?.file.name || materials?.md?.name || "选择或拖入 Markdown"}</span>
            <span className="text-[11px] text-stone-400">{mdUpload?.busy ? `上传中 ${mdUpload.progress}%` : "一个 MD · 最大 5MB"}</span>
          </button>
          <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-label="选择导入参考图" className="hidden" onChange={(event) => { addReferences(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" disabled={blocked} onClick={() => referenceInput.current?.click()}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!blocked) addReferences(Array.from(event.dataTransfer.files)); }}
            className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 px-3 py-5 text-sm hover:bg-stone-100 disabled:opacity-50">
            <Images className="size-5 text-stone-400" /><span>选择或拖入参考图</span>
            <span className="text-[11px] text-stone-400">已选 {rows.length} 张 · 可分批补充</span>
          </button>
        </div>
        {mdUpload && !mdUpload.busy && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-rose-700"><span className="break-words">{mdUpload.error}</span><Button variant="outline" size="sm" onClick={() => sendMd(mdUpload)} disabled={blocked}>重试 MD 上传</Button></div>}
        <ul className="flex flex-wrap gap-1.5" aria-label="导入参考图列表">
          {rows.map((item) => {
            const source = item.reference?.url ?? item.upload?.url;
            const failure = item.upload?.error ?? item.error;
            return <li key={item.request_id} className={`flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-xs ${failure ? "bg-rose-50 text-rose-700" : "bg-stone-100 text-stone-600"}`}>
              <button type="button" disabled={!source} className="min-w-0 truncate text-left" title={`${item.name} · ${(item.size / 1024).toFixed(1)} KB${failure ? ` · ${failure}` : ""}`} aria-label={`预览导入参考图 ${item.name}`} onClick={() => setPreview(item.request_id)}>{item.name}</button>
              {item.upload?.busy && <span className="shrink-0 text-[10px] text-stone-400">{item.upload.progress}%</span>}
              {failure && item.upload && !item.upload.cancelled && <button type="button" className="shrink-0 underline" disabled={blocked || !item.upload} title={failure} onClick={() => item.upload && retryReference(item.upload)}>重试</button>}
              <button type="button" disabled={blocked || item.upload?.cancelled} className="shrink-0 rounded-full p-0.5 hover:bg-stone-200 disabled:opacity-40" aria-label={`移除导入参考图 ${item.name}`} onClick={() => cleanup(false, item.request_id)}><X className="size-3" /></button>
            </li>;
          })}
        </ul>
        {materials?.md && <section className="min-w-0 space-y-3" aria-label="MD 条目预览">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-stone-100 px-4 py-3">
            <div className="min-w-0"><h3 className="break-all text-sm font-semibold">{materials.md.name.replace(/\.md$/i, "")}</h3>
              <p className="mt-0.5 text-xs text-stone-500">{candidates.length} 条 · 已选 {selectedCandidates.length} 条 · {countsValid ? `共 ${total} 张图片` : "请修正生成数量"}</p></div>
            <label className="flex items-center gap-2 text-xs text-stone-500">每条
              <input type="number" min={1} max={100} step={1} aria-label="批量生成数量" aria-invalid={!validCount(count)} inputMode="numeric" value={count} onChange={event => changeGlobalCount(event.target.value)} className="w-16 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-center text-sm" />张
            </label>
          </div>
          {(missing.length > 0 || conflicts.length > 0) && <div role="alert" className="space-y-1 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-600">
            {!!missing.length && <p className="break-words">缺少：{missing.join("、")}</p>}
            {!!conflicts.length && <p className="break-words">同名冲突：{conflicts.join("、")}</p>}
          </div>}
          {!!unused.length && <p className="break-words rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-700">未使用：{unused.join("、")}</p>}
          <div className="flex justify-end text-xs text-stone-500">
            <div className="flex gap-3"><button type="button" onClick={() => changeSelection({ ...selected, ...Object.fromEntries(candidates.map(item => [item.config.document_id, true])) })}>全选</button><button type="button" onClick={() => changeSelection({ ...selected, ...Object.fromEntries(candidates.map(item => [item.config.document_id, false])) })}>全不选</button></div>
          </div>
          {candidates.length === 0 && <p role="status" className="py-6 text-center text-sm text-stone-500">未识别到生成条目，请检查文档的 Prompt 区块。</p>}
          {candidates.map((candidate) => <CandidatePreview key={candidate.key} candidate={candidate} version={materials.version} mdVersion={materials.md_version} disabled={blocked}
            selected={!candidate.skipped && candidate.status !== "error" && selected[candidate.config.document_id] !== false}
            onSelect={(checked) => changeSelection({ ...selected, [candidate.config.document_id]: checked })}
            count={count} countOverride={counts[candidate.config.document_id] || ""} onCountChange={(value) => changeOverride(candidate.config.document_id, value)} onCorrect={correct} />)}
        </section>}
        {pendingBatch.current && <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">上次提交：{pendingBatch.current.entries.length} 条 · {pendingTotal} 张。重试会沿用当时的配置。</p>}
      </div>
      <DialogFooter className="shrink-0 flex-row flex-wrap items-center gap-2 border-t px-5 py-3 sm:px-7">
        <div className="mr-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={blocked} onClick={() => cleanup(true)}>清除上传内容</Button>
          {error && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setError(""); setFailedCleanup(null); void refresh().catch((reason: Error) => setError(handleImportError(reason))); }}>重新加载</Button>}
          {pending && <Button variant="outline" size="sm" disabled={busy} onClick={() => cleanup(pending.clear, pending.upload_ids[0], pending)}>重试清理</Button>}
          {pendingBatch.current && !submitting && <Button variant="outline" size="sm" onClick={() => { pendingBatch.current = null; setSubmissionMessage("已解除重试；已接受的批次仍会继续，可在历史查看。"); }}>准备新的提交</Button>}
        </div>
        <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        <Button disabled={submitting || (!pendingBatch.current && (blocked || !countsValid || !selectedCandidates.length))} onClick={() => void startBatch()}>{submitting ? "提交中…" : pendingBatch.current ? `重试上次提交（${pendingTotal} 张）` : `生成已选条目（${total} 张）`}</Button>
      </DialogFooter>
      {previewRow && previewSource && <ImageLightbox open={!!preview} onOpenChange={(value) => { if (!value) setPreview(null); }} images={[{ id: previewRow.request_id, src: previewSource, filename: previewRow.name }]} currentIndex={0} onIndexChange={() => {}} />}
    </DialogContent>
  </Dialog>;
}

function CandidatePreview({ candidate, version, mdVersion, disabled, selected, onSelect, count, countOverride, onCountChange, onCorrect }: {
  candidate: ImportCandidate; version: number; mdVersion: number; disabled: boolean;
  selected: boolean; onSelect: (checked: boolean) => void; count: string; countOverride: string; onCountChange: (value: string) => void;
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
  return <article className={`min-w-0 rounded-2xl border px-3 py-2.5 text-sm ${candidate.status === "error" && !candidate.skipped ? "border-rose-200" : "border-stone-200"}`} aria-label={`条目 ${title}`}>
    <div className="flex items-start gap-2.5">
      <input type="checkbox" className="mt-1 size-3.5 shrink-0 accent-stone-900" aria-label={`选择 ${config.document_id}`} disabled={candidate.skipped || candidate.status === "error"} checked={selected} onChange={(event) => onSelect(event.target.checked)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h4 className="min-w-0 flex-1 break-words"><strong>{config.document_id}</strong> <span className="text-stone-600">{config.name}</span></h4>
          <span className="text-[11px] text-stone-400">{config.size || "尺寸缺失"} · 参考图 {candidate.matches.filter((match) => match.status === "ready").length}/{config.reference_names?.length ?? "?"}</span>
          {countOverride && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">单条 {countOverride} 张</span>}
          {(candidate.skipped || candidate.status !== "ready") && <span role="status" className={`text-[11px] ${candidate.status === "error" ? "text-rose-600" : "text-stone-400"}`}>{candidate.skipped ? "已跳过" : status}</span>}
          {candidate.ignored && candidate.status !== "error" && <span className="text-[11px] text-stone-400">已忽略</span>}
          {candidate.status === "error" && !candidate.skipped && candidate.errors.some(item => item.field === "reference_names" || item.code === "unclosed_prompt") && <button type="button" disabled={disabled || saving} onClick={() => void save({ ignored: true }, version)} className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50">忽略</button>}
          <button type="button" disabled={disabled || saving} onClick={edit} className="rounded-md px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-50">修正</button>
          {candidate.skipped && <button type="button" disabled={disabled || saving} onClick={() => void save({ skipped: false }, version)} className="text-xs">取消跳过</button>}
        </div>
        {candidate.errors.length > 0 && <p className="mt-1 break-words text-xs text-rose-600" aria-label="条目错误">{candidate.errors.map(item => item.message).join("；")}</p>}
        {error && <p role="alert" className="mt-1 break-words text-xs text-rose-600">{error}</p>}
        <details className="mt-1 text-xs text-stone-500">
          <summary className="cursor-pointer">参考图与 Prompt</summary>
          <div className="mt-3 space-y-3">
            {config.output_name && <p className="break-all">输出名称：{config.output_name}</p>}
            <p>参考图（按声明顺序）：{config.reference_names === null ? "缺少声明" : config.reference_names.length === 0 ? "明确无参考图" : ""}</p>
            <ol className="space-y-1">
              {candidate.matches.map((match, index) => <li key={`${index}:${match.name}`} className="flex min-w-0 items-center gap-2">
                {match.reference && <ReferenceThumbnail src={match.reference.url} alt={match.name} className="size-9 shrink-0 rounded object-cover" />}
                <span className="min-w-0 break-all">{index + 1}. {match.name} · {match.status === "ready" ? "已匹配" : match.status === "pending" ? "已登记，等待上传" : "未匹配或有冲突"}</span>
              </li>)}
            </ol>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-50 p-2 font-sans">{config.prompt || "缺少明确的 Prompt 区块"}</pre>
            <label className="flex flex-wrap items-center gap-2">单条数量<input type="number" min={1} max={100} step={1} aria-label={`${config.document_id} 单条数量`} inputMode="numeric" placeholder={count} value={countOverride} onChange={(event) => onCountChange(event.target.value)} className="w-20 rounded-md border bg-white p-1" /><span>留空使用统一数量 · 生效 {countOverride || count} 张</span></label>
            <Button size="sm" variant="outline" disabled={disabled || saving} onClick={() => void save({ skipped: !candidate.skipped }, version)}>{candidate.skipped ? "取消跳过" : "跳过此条"}</Button>
          </div>
        </details>
    {draft &&
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
        const names = mode === "none" ? [] : listedNames.length ? listedNames : null;
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
          <label className="block">参考图声明<select aria-label="参考图声明" className={inputClass} name="reference_mode" defaultValue={draft.config.reference_names?.length === 0 ? "none" : "files"}>
            <option value="none">明确无参考图</option><option value="files">使用以下文件，按行匹配</option>
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
      </div>
    </div>
  </article>;
}
