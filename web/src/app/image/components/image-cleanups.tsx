"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchImageCleanups, retryImageCleanup, retryAllImageCleanups, type ImageCleanupPage } from "@/store/image-conversations";

const states = {
  complete: { label: "已完成", icon: CheckCircle2, color: "text-emerald-700 bg-emerald-50" },
  pending: { label: "等待中", icon: Clock3, color: "text-blue-700 bg-blue-50" },
  retained: { label: "引用保留", icon: Link2, color: "text-amber-700 bg-amber-50" },
  error: { label: "清理失败", icon: CircleAlert, color: "text-red-700 bg-red-50" },
};

export function ImageCleanups({ authKey }: { authKey: string }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ImageCleanupPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setPage(null); setOffset(0); setOpen(false); setNotice(""); }, [authKey]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await fetchImageCleanups(authKey, open ? offset : 0);
        if (!cancelled) {
          setPage(next); setError("");
          if (open && offset >= next.pagination.total && offset > 0) {
            setOffset(Math.floor(Math.max(0, next.pagination.total - 1) / 50) * 50);
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "读取清理进度失败");
      }
      if (!cancelled) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [authKey, open, offset, revision]);

  const retry = async (id?: string) => {
    setRetrying(id ?? "all");
    setNotice("");
    try {
      if (id) { await retryImageCleanup(authKey, id); setNotice("已加入重试队列"); }
      else {
        const result = await retryAllImageCleanups(authKey);
        setNotice(result.accepted ? `已加入 ${result.accepted} 项，正在依次核实和清理` : result.running ? "批量重试正在进行" : "没有需要重试的失败项");
      }
      setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重试清理失败"); }
    finally { setRetrying(null); }
  };

  return <>
    <Button variant="ghost" size="sm" className="self-end" onClick={() => setOpen(true)}>
      删除清理{page ? ` · 等待 ${page.stats.pending} / 失败 ${page.stats.error}` : ""}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="shrink-0 space-y-3 border-b p-4 sm:p-5">
          <DialogHeader><DialogTitle>删除清理</DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">仅核实和清理当前身份的已有任务，不重新生成。</DialogDescription></DialogHeader>
          <div className="grid grid-cols-4 gap-2" role="status">
            {Object.entries(states).map(([key, meta]) => <div key={key} className={`min-w-0 rounded-lg px-2 py-1.5 sm:px-3 sm:py-2 ${meta.color}`}>
              <span className="flex items-center gap-1.5 whitespace-nowrap text-[10px] sm:text-xs"><meta.icon className="hidden size-3.5 sm:block" />{meta.label}</span>
              <span className="mt-1 block text-lg font-semibold tabular-nums">{page?.stats[key as keyof typeof states] ?? "—"}</span>
            </div>)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={retrying !== null || !page?.stats.error} onClick={() => void retry()}>
              <RefreshCw className={`size-3.5 ${retrying === "all" ? "animate-spin" : ""}`} />一键重试所有失败项{page?.stats.error ? `（${page.stats.error}）` : ""}
            </Button>
            <span className="hidden text-xs text-stone-500 sm:inline">包含所有页</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {notice && <p role="status" className="text-xs text-stone-600">{notice}</p>}
          {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
          {page?.items.map((item) => {
            const meta = states[item.state];
            return <div key={item.id} className="rounded-xl border border-stone-200 bg-white p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <p className="break-words font-medium text-stone-800">{item.conversation_title || "生成任务"}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <Badge variant="outline" className={`gap-1 border-0 ${meta.color}`}><meta.icon className="size-3" />{meta.label}</Badge>
                    <span>第 {item.turn_number} 轮 · 结果 {item.ordinal}</span>
                  </div>
                </div>
                {item.state !== "pending" && <Button variant="outline" size="sm" className="shrink-0" disabled={retrying !== null} onClick={() => void retry(item.id)}>
                  {retrying === item.id ? "重试中…" : "重试"}
                </Button>}
              </div>
              {item.state === "error" ? <details className="mt-2 text-xs text-red-700">
                <summary className="cursor-pointer">查看失败原因</summary>
                <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.error || "清理未完成，请重试"}</p>
              </details> : <p className="mt-2 break-words text-xs text-stone-500">{item.state === "retained" ? "文件仍被其他轮次或当前素材引用，解除引用后会继续清理。" : item.error || "正在后台清理文件…"}</p>}
            </div>;
          })}
          {page && !page.items.length && <div className="py-12 text-center text-sm text-stone-500"><CheckCircle2 className="mx-auto mb-3 size-7 text-emerald-500" />暂无待处理项</div>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-stone-50 px-4 py-3">
          <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button>
          <span className="text-xs tabular-nums text-stone-500">{page?.pagination.total ?? 0} 项待处理 · 第 {Math.floor(offset / 50) + 1} 页</span>
          <Button variant="ghost" size="sm" disabled={!page || page.pagination.next_offset === null} onClick={() => setOffset(page!.pagination.next_offset!)}>下一页</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
