"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/image-lightbox";
import { formatBeijingDateTime } from "@/lib/business-time";
import { cleanupImageImports, fetchImageImports, reserveImportReference, uploadImportFile, type ImageImports, type ImportCleanup, type ImportMutation } from "@/store/image-imports";
import { ReferenceThumbnail } from "./reference-thumbnail";

type Upload = { file: File; mutation: ImportMutation; url: string; progress: number; busy: boolean; error?: string; cancelled?: boolean };

export function ImageImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [materials, setMaterials] = useState<ImageImports | null>(null);
  const current = useRef<ImageImports | null>(null);
  const [uploads, setUploads] = useState<Record<string, Upload>>({});
  const uploadsRef = useRef<Record<string, Upload>>({});
  const [mdUpload, setMdUpload] = useState<Upload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedCleanup, setFailedCleanup] = useState<ImportCleanup | null>(null);
  const [preview, setPreview] = useState<{ id: string; src: string; filename: string } | null>(null);
  const mdInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const transfers = useRef(Array.from({ length: 4 }, () => Promise.resolve()));
  const nextTransfer = useRef(0);
  const mounted = useRef(true);
  const accept = useCallback((next: ImageImports) => {
    if (mounted.current && (!current.current || next.revision >= current.current.revision)) {
      current.current = next;
      setMaterials(next);
    }
  }, []);
  const refresh = useCallback(async () => accept(await fetchImageImports()), [accept]);
  function enqueue(operation: () => Promise<void>) {
    const next = queue.current.catch(() => {}).then(operation);
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
    return () => {
      mounted.current = false;
      for (const item of Object.values(uploadsRef.current)) URL.revokeObjectURL(item.url);
    };
  }, []);
  useEffect(() => {
    if (open) void refresh().catch((reason: Error) => setError(reason.message));
  }, [open, refresh]);

  async function sendReference(item: Upload) {
    const id = item.mutation.request_id;
    if (!uploadsRef.current[id] || uploadsRef.current[id].cancelled) return;
    updateUpload(id, { busy: true, error: undefined });
    try {
      const result = await uploadImportFile(item.file, "reference", item.mutation, (progress) => updateUpload(id, { progress }));
      accept(result);
      if (!uploadsRef.current[id]?.cancelled) updateUpload(id, null);
    } catch (reason) {
      if (!uploadsRef.current[id]?.cancelled) updateUpload(id, { busy: false, error: (reason as Error).message });
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
        accept(await reserveImportReference(item.file, item.mutation));
        // Registration is ordered; file transfers may finish while further files are registered.
        scheduleReference(item);
      } catch (reason) {
        updateUpload(id, { busy: false, error: (reason as Error).message });
      }
    });
  }
  function retryReference(item: Upload) {
    updateUpload(item.mutation.request_id, { busy: true, error: undefined });
    void enqueue(async () => {
      try {
        accept(await reserveImportReference(item.file, item.mutation));
        scheduleReference(item);
      } catch (reason) {
        updateUpload(item.mutation.request_id, { busy: false, error: (reason as Error).message });
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
        accept(await uploadImportFile(item.file, "md", item.mutation, (progress) => setMdUpload({ ...item, progress, busy: true })));
        setMdUpload(null);
      } catch (reason) {
        setMdUpload({ ...item, busy: false, error: (reason as Error).message });
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
        accept(await cleanupImageImports(operation));
        for (const id of ids) updateUpload(id, null);
        if (clear) setMdUpload(null);
        setFailedCleanup(null);
      } catch (reason) {
        setError((reason as Error).message);
        setFailedCleanup(operation);
        await refresh().catch(() => {});
      } finally { setBusy(false); }
    });
  }

  const pending = materials?.pending ?? failedCleanup;
  const blocked = !materials || busy || !!materials.pending;
  const rows = [
    ...(materials?.references ?? []).map((item) => ({ ...item, upload: uploads[item.request_id] })),
    ...Object.entries(uploads).filter(([id]) => !materials?.references.some((item) => item.request_id === id))
      .map(([id, upload]) => ({ request_id: id, name: upload.file.name, size: upload.file.size, reference: null, error: undefined, upload })),
  ];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(94vw,960px)] flex-col gap-4 overflow-hidden p-4 sm:p-6">
      <DialogHeader className="shrink-0 pr-6">
        <DialogTitle>上传 MD 和参考图</DialogTitle>
        <DialogDescription>当前素材在所有生图会话中共享，关闭弹窗后保留。新 MD 直接替换，参考图追加。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {error && <p role="alert" className="mb-3 break-words text-sm text-rose-600">{error}</p>}
        {busy && <p role="status" className="mb-3 text-sm">正在清理当前素材…</p>}
        {!materials && <p role="status">正在读取当前素材…</p>}
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
                  {source && <button type="button" className="shrink-0" aria-label={`预览导入参考图 ${item.name}`} onClick={() => setPreview({ id: item.request_id, src: source, filename: item.name })}><ReferenceThumbnail src={source} alt={item.name} className="size-12 rounded-lg object-cover" /></button>}
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
      </div>
      <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t pt-3">
        <span className="basis-full text-xs text-muted-foreground sm:mr-auto sm:basis-auto">{materials?.updated_at ? `更新于 ${formatBeijingDateTime(materials.updated_at)}` : "尚未导入素材"}</span>
        <Button variant="outline" disabled={busy} onClick={() => { setError(""); setFailedCleanup(null); void refresh().catch((reason: Error) => setError(reason.message)); }}>刷新素材</Button>
        {pending && <Button variant="outline" disabled={busy} onClick={() => cleanup(pending.clear, pending.upload_ids[0], pending)}>重试清理</Button>}
        <Button variant="outline" disabled={blocked} onClick={() => cleanup(true)}>清除上传内容</Button>
        <Button onClick={() => onOpenChange(false)}>完成</Button>
      </DialogFooter>
      {preview && <ImageLightbox open={!!preview} onOpenChange={(value) => { if (!value) setPreview(null); }} images={[preview]} currentIndex={0} onIndexChange={() => {}} />}
    </DialogContent>
  </Dialog>;
}
