"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchImageNavigation, type ImageConversation, type ImageNavigationPage } from "@/store/image-conversations";

export type ResultTarget = { turn_id: string; image_id?: string };

export function ImageNavigation({ authKey, conversation, viewport, onLocate, open, onOpenChange }: {
  authKey: string;
  conversation: ImageConversation | null;
  viewport: RefObject<HTMLDivElement | null>;
  onLocate: (target: ResultTarget) => Promise<boolean>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState<ImageNavigationPage | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ResultTarget | null>(null);
  const id = conversation?.id;
  useEffect(() => {
    setPage(null);
    setActive(null);
    setExpanded(new Set());
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      const turns: ImageNavigationPage["turns"] = [];
      const sources = new Map<string, NonNullable<ImageConversation["sourceEntries"]>[number]>();
      let offset: number | null = 0;
      while (offset !== null && !cancelled) {
        const next = await fetchImageNavigation(authKey, id, offset);
        turns.push(...next.turns);
        next.sourceEntries?.forEach((source) => sources.set(source.id, source));
        offset = next.pagination?.next_offset ?? null;
      }
      if (!cancelled) setPage({ id, turns, sourceEntries: [...sources.values()] });
    })().catch((reason) => { if (!cancelled) setError(reason.message || "读取导航失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authKey, id, conversation?.updatedAt, retry]);

  // Observe only this finite result page. Position updates stay in the navigation component.
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const visible = new Set<HTMLElement>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => entry.isIntersecting ? visible.add(entry.target as HTMLElement) : visible.delete(entry.target as HTMLElement));
      const top = root.getBoundingClientRect().top;
      const candidates = [...visible].sort((a, b) => Math.abs(a.getBoundingClientRect().top - top) - Math.abs(b.getBoundingClientRect().top - top));
      if (!candidates.length) return;
      setActive((previous) => {
        // Images in the same grid row share a scroll position; keep the explicitly selected image.
        const preferred = candidates.find((node) => previous?.image_id && node.dataset.imageId === previous.image_id);
        const element = preferred && Math.abs(preferred.getBoundingClientRect().top - candidates[0].getBoundingClientRect().top) < 1 ? preferred : candidates[0];
        const turn = element.closest<HTMLElement>("[data-turn-id]");
        if (!turn) return previous;
        const next = { turn_id: turn.dataset.turnId!, image_id: element.dataset.imageId };
        return previous?.turn_id === next.turn_id && previous?.image_id === next.image_id ? previous : next;
      });
    }, { root, threshold: [0, 0.25, 0.75, 1] });
    root.querySelectorAll<HTMLElement>("[data-result-anchor]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [viewport, conversation]);

  const groups = useMemo(() => (page && page.id === id ? page.sourceEntries || [] : []).map((source) => ({
    ...source, turns: page!.turns.filter((turn) => turn.sourceEntryId === source.id),
  })), [page, id]);
  const toggle = (key: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const locate = async (target: ResultTarget) => {
    onOpenChange(false);
    if (await onLocate(target)) setActive(target);
  };
  const tree = <nav aria-label="结果定位导航" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 text-sm">
    {loading && <p role="status" className="p-2 text-stone-500">读取导航…</p>}
    {error && <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>读取失败，重试</Button>}
    {!id && <p className="p-2 text-stone-500">选择会话后查看结果</p>}
    {groups.map((source) => {
      const current = source.turns.find((turn) => turn.id === active?.turn_id);
      const label = [source.documentId, source.name.trim().slice(0, 24)].filter(Boolean).join(" · ");
      return <div key={source.id} className="mb-2" data-navigation-source={source.id}>
        <div className={`flex items-start rounded-lg ${current ? "bg-emerald-50 text-emerald-800" : "text-stone-700"}`}>
          <button type="button" aria-label={`展开或收起 ${label}`} aria-expanded={expanded.has(source.id)} onClick={() => toggle(source.id)} className="shrink-0 rounded p-2">
            <ChevronRight className={`size-4 ${expanded.has(source.id) ? "rotate-90" : ""}`} />
          </button>
          <button type="button" className="min-w-0 flex-1 break-words p-2 text-left" aria-current={current ? "location" : undefined}
            onClick={() => void locate({ turn_id: source.turns.at(-1)!.id })}>
            {label || "普通生成"}
            {current && <span className="block text-xs">当前位置 · 第 {current.sourceOrdinal} 次{active?.image_id ? ` · 图片 ${current.images.find((image) => image.id === active.image_id)?.ordinal ?? ""}` : ""}</span>}
          </button>
        </div>
        {expanded.has(source.id) && source.turns.map((turn) => <div key={turn.id} className="ml-4">
          <div className="flex items-center">
            <button type="button" aria-label={`展开或收起第 ${turn.sourceOrdinal} 次图片`} aria-expanded={expanded.has(turn.id)} onClick={() => toggle(turn.id)} className="rounded p-2">
              <ChevronRight className={`size-3 ${expanded.has(turn.id) ? "rotate-90" : ""}`} />
            </button>
            <button type="button" className="flex-1 rounded p-2 text-left aria-[current=location]:bg-emerald-100" aria-current={active?.turn_id === turn.id ? "location" : undefined}
              onClick={() => void locate({ turn_id: turn.id })}>第 {turn.sourceOrdinal} 次 · {turn.images.length} 张</button>
          </div>
          {expanded.has(turn.id) && <div className="ml-6 flex flex-wrap gap-1">
            {turn.images.map((image) => <button key={image.id} type="button" data-navigation-image={image.id}
              aria-label={`第 ${turn.sourceOrdinal} 次 图片 ${image.ordinal}`} aria-current={active?.image_id === image.id ? "location" : undefined}
              title={image.status === "success" ? "已完成" : image.status === "error" ? "失败" : "处理中"}
              className="min-w-8 rounded border border-stone-200 px-2 py-1 aria-[current=location]:bg-emerald-200"
              onClick={() => void locate({ turn_id: turn.id, image_id: image.id })}>{image.ordinal}</button>)}
          </div>}
        </div>)}
      </div>;
    })}
  </nav>;
  return <>
    <aside className="hidden h-full min-h-0 flex-col border-l border-stone-200 pl-2 xl:flex">
      <h2 className="p-3 font-medium">结果定位</h2>{tree}
    </aside>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[720px] w-[calc(100vw-2rem)] max-w-sm flex-col overflow-hidden p-3">
        <DialogHeader className="shrink-0 p-2"><DialogTitle>结果定位</DialogTitle></DialogHeader>
        {tree}
      </DialogContent>
    </Dialog>
  </>;
}
