"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchImageCleanups, retryImageCleanup, type ImageCleanupPage } from "@/store/image-conversations";

export function ImageCleanups({ authKey }: { authKey: string }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ImageCleanupPage | null>(null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await fetchImageCleanups(authKey, open ? offset : 0);
        if (!cancelled) { setPage(next); setError(""); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "读取清理进度失败");
      }
      if (!cancelled) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [authKey, open, offset, revision]);

  const retry = async (id: string) => {
    setRetrying(id);
    try { await retryImageCleanup(authKey, id); setRevision((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重试清理失败"); }
    finally { setRetrying(null); }
  };

  return <>
    <Button variant="ghost" size="sm" className="self-end" onClick={() => setOpen(true)}>
      删除清理{page ? ` · 等待 ${page.stats.pending} / 失败 ${page.stats.error}` : ""}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>当前身份的删除清理</DialogTitle>
          <DialogDescription>已删除会话的清理进度仍保留在这里。重试只核实和清理已有任务，不重新生成。</DialogDescription></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
        {page && <p role="status" className="text-sm">完成 {page.stats.complete} · 等待 {page.stats.pending} · 引用保留 {page.stats.retained} · 失败 {page.stats.error}</p>}
        {page?.items.map((item) => <div key={item.id} className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="break-words text-xs text-stone-500">{item.conversation_title} · 第 {item.turn_number} 轮 · 结果 {item.ordinal}</p>
          <p className="break-words">{item.state === "error" ? `清理失败：${item.error}` : item.state === "retained" ? "文件仍被其他轮次或当前素材引用，已保留。" : item.error || "正在后台清理文件。"}</p>
          <Button variant="outline" size="sm" disabled={retrying !== null} onClick={() => void retry(item.id)}>
            {retrying === item.id ? "正在重试" : "重试清理"}
          </Button>
        </div>)}
        {page && <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button>
          <span className="text-xs">{page.pagination.total} 项待处理</span>
          <Button variant="ghost" disabled={page.pagination.next_offset === null} onClick={() => setOffset(page.pagination.next_offset!)}>下一页</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
