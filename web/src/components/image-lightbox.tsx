"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, RotateCcw, Trash2, X } from "lucide-react";
import { isAxiosError } from "axios";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { downloadStoredImage, fetchStoredImageBlob, managedImagePath } from "@/store/image-conversations";
import { getStoredAuthKey } from "@/store/auth";
import { IdentityChanged, identityAuth } from "@/lib/identity-request";

type LightboxImage = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
  filename?: string;
  ordinal?: number;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
  onDelete?: () => void;
  roundImages?: LightboxImage[];
  offset?: number;
  total?: number;
  pageLoading?: boolean;
};

type ImageTransform = {
  scale: number;
  x: number;
  y: number;
};

type TouchPoints = {
  [index: number]: React.Touch;
};

type TouchGesture =
  | {
      type: "swipe";
      startX: number;
      startY: number;
    }
  | {
      type: "pan";
      startX: number;
      startY: number;
      startTransform: ImageTransform;
    }
  | {
      type: "pinch";
      startDistance: number;
      startCenterX: number;
      startCenterY: number;
      startTransform: ImageTransform;
    };

const minScale = 1;
const maxScale = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getTouchDistance(touches: TouchPoints) {
  const first = touches[0];
  const second = touches[1];
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function getTouchCenter(touches: TouchPoints) {
  const first = touches[0];
  const second = touches[1];
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

export function ImageLightbox({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
  onDelete,
  roundImages,
  offset = 0,
  total = images.length,
  pageLoading = false,
}: ImageLightboxProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const mouseDragRef = useRef<{ pointerId: number; startX: number; startY: number; startTransform: ImageTransform } | null>(null);
  const gestureRef = useRef<TouchGesture | null>(null);
  const lastTapRef = useRef(0);
  const pendingTransformRef = useRef<ImageTransform | null>(null);
  const rafRef = useRef<number | null>(null);
  const [transform, setTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const [displayed, setDisplayed] = useState<{
    image: LightboxImage; url: string; objectUrl: string; dimensions: string; index: number; offset: number; total: number;
  } | null>(null);
  const previewIdentity = useRef<Promise<string> | null>(null);
  const [downloads, setDownloads] = useState<{ image: LightboxImage; name?: string; error?: string }[]>([]);
  const [downloading, setDownloading] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  const current = images[currentIndex];
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const targetKey = `${current?.id}:${current?.src}`;
  // Keep an old page visible during navigation, but never retain a deleted image.
  const visible = displayed && (images.some(image => image.id === displayed.image.id && image.src === displayed.image.src)
    || (offset !== displayed.offset && total >= displayed.total)) ? displayed : null;
  const ready = !!visible && visible.image.id === current?.id && visible.image.src === current?.src && !pageLoading;
  const shown = visible?.image ?? current;
  const hasPrev = offset + currentIndex > 0;
  const hasNext = offset + currentIndex < total - 1;

  useEffect(() => {
    previewIdentity.current = open ? getStoredAuthKey() : null;
    if (!open) setDisplayed(null);
  }, [open]);

  useEffect(() => {
    if (!open || !current) return;
    const controller = new AbortController();
    let objectUrl = "";
    let committed = false;
    setFailedImage(null);
    void (async () => {
      const key = await previewIdentity.current!;
      await identityAuth(key);
      if (managedImagePath(current.src)) {
        const blob = await fetchStoredImageBlob(current.src, controller.signal, key);
        controller.signal.throwIfAborted();
        objectUrl = URL.createObjectURL(blob);
      }
      const image = new Image();
      image.src = objectUrl || current.src;
      await image.decode();
      await identityAuth(key);
      controller.signal.throwIfAborted();
      committed = true;
      setDisplayed({ image: current, url: image.src, objectUrl, dimensions: `${image.naturalWidth} x ${image.naturalHeight}`,
        index: currentIndex, offset, total });
    })().catch(error => {
      if (objectUrl && !committed) URL.revokeObjectURL(objectUrl);
      if (controller.signal.aborted) return;
      if (error instanceof IdentityChanged || (isAxiosError(error.cause) && [401, 403].includes(error.cause.response?.status ?? 0))) {
        setDisplayed(null);
      }
      setFailedImage(targetKey);
    });
    return () => {
      controller.abort();
      if (objectUrl && !committed) URL.revokeObjectURL(objectUrl);
    };
  }, [open, current?.id, current?.src, currentIndex, offset, loadAttempt]);

  useEffect(() => () => { if (displayed?.objectUrl) URL.revokeObjectURL(displayed.objectUrl); }, [displayed]);

  useEffect(() => {
    if (displayed && !visible) setDisplayed(null);
  }, [displayed, visible]);

  useEffect(() => {
    if (!open) { setDownloads([]); setDownloading(false); }
    return () => { downloadController.current?.abort(); };
  }, [open]);

  const cancelScheduledTransform = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingTransformRef.current = null;
  }, []);

  const scheduleTransform = useCallback((next: ImageTransform) => {
    pendingTransformRef.current = next;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pending = pendingTransformRef.current;
      pendingTransformRef.current = null;
      if (pending) {
        setTransform(pending);
      }
    });
  }, []);

  const normalizeTransform = useCallback((next: ImageTransform) => {
    const scale = clamp(next.scale, minScale, maxScale);
    const maxX = (imageRef.current?.offsetWidth ?? 0) * (scale - 1) / 2;
    const maxY = (imageRef.current?.offsetHeight ?? 0) * (scale - 1) / 2;
    return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  }, []);

  const flushScheduledTransform = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pending = pendingTransformRef.current;
    pendingTransformRef.current = null;
    if (pending) {
      setTransform(pending);
    }
  }, []);

  const resetTransform = useCallback(() => {
    cancelScheduledTransform();
    setTransform({ scale: 1, x: 0, y: 0 });
    setIsGesturing(false);
    gestureRef.current = null;
    const pointerId = mouseDragRef.current?.pointerId;
    mouseDragRef.current = null;
    if (pointerId !== undefined && imageRef.current?.hasPointerCapture(pointerId)) imageRef.current.releasePointerCapture(pointerId);
  }, [cancelScheduledTransform]);

  const goPrev = useCallback(() => {
    if (hasPrev && !pageLoading) onIndexChange(currentIndex - 1);
  }, [hasPrev, currentIndex, onIndexChange, pageLoading]);

  const goNext = useCallback(() => {
    if (hasNext && !pageLoading) onIndexChange(currentIndex + 1);
  }, [hasNext, currentIndex, onIndexChange, pageLoading]);

  useEffect(() => {
    resetTransform();
  }, [displayed?.url, displayed?.image.id, open, resetTransform]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== contentRef.current) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "Delete" && onDelete && ready) {
        e.preventDefault();
        onDelete();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext, onDelete, ready]);

  const handleDownload = useCallback(async (targets: LightboxImage[], batch = false) => {
    if (downloadController.current && !downloadController.current.signal.aborted) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloads(items => [...(batch ? [] : items.filter(item => !targets.some(image => image.id === item.image.id))),
      ...targets.map(image => ({ image }))]);
    try {
      const authKey = await getStoredAuthKey();
      for (const image of targets) {
        if (controller.signal.aborted) break;
        try {
          const name = await downloadStoredImage(image.src, image.filename || `image-${image.id}`, controller.signal, authKey);
          if (!controller.signal.aborted) setDownloads(items => items.map(item => item.image.id === image.id ? { image, name } : item));
        } catch (error) {
          if (controller.signal.aborted) break;
          const message = error instanceof Error ? error.message : "下载失败";
          setDownloads(items => items.map(item => item.image.id === image.id ? { image, error: message } : item));
          if (!batch) toast.error(message);
          if (error instanceof IdentityChanged) break;
        }
        // ponytail: pace native downloads below Chrome's burst limit; manual retry covers browser policy differences.
        if (batch) await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }, []);

  const toggleZoom = useCallback(() => {
    cancelScheduledTransform();
    setTransform((currentTransform) =>
      currentTransform.scale > minScale ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 },
    );
  }, [cancelScheduledTransform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !visible || !canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!imageRef.current) return;
      const currentTransform = pendingTransformRef.current ?? transform;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      const scale = clamp(currentTransform.scale * Math.exp(-delta * 0.002), minScale, maxScale);
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - (rect.left + rect.width / 2);
      const y = event.clientY - (rect.top + rect.height / 2);
      const ratio = scale / currentTransform.scale;
      const next = normalizeTransform({ scale, x: x - (x - currentTransform.x) * ratio, y: y - (y - currentTransform.y) * ratio });
      const drag = mouseDragRef.current;
      if (drag) {
        drag.startX = event.clientX;
        drag.startY = event.clientY;
        drag.startTransform = next;
      }
      scheduleTransform(next);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [open, visible, transform, normalizeTransform, scheduleTransform]);

  const finishMouseDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (mouseDragRef.current?.pointerId !== event.pointerId) return;
    mouseDragRef.current = null;
    flushScheduledTransform();
    setIsGesturing(false);
    if (imageRef.current?.hasPointerCapture(event.pointerId)) imageRef.current.releasePointerCapture(event.pointerId);
  }, [flushScheduledTransform]);

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        const startDistance = getTouchDistance(event.touches);
        if (startDistance < 1) {
          gestureRef.current = null;
          return;
        }
        const center = getTouchCenter(event.touches);
        cancelScheduledTransform();
        setIsGesturing(true);
        gestureRef.current = {
          type: "pinch",
          startDistance,
          startCenterX: center.x,
          startCenterY: center.y,
          startTransform: transform,
        };
        return;
      }

      if (event.touches.length !== 1) {
        gestureRef.current = null;
        return;
      }

      const touch = event.touches[0];
      if (transform.scale > minScale) {
        cancelScheduledTransform();
        setIsGesturing(true);
        gestureRef.current = {
          type: "pan",
          startX: touch.clientX,
          startY: touch.clientY,
          startTransform: transform,
        };
      } else {
        gestureRef.current = {
          type: "swipe",
          startX: touch.clientX,
          startY: touch.clientY,
        };
      }
    },
    [transform, cancelScheduledTransform],
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      if (gesture.type === "pinch" && event.touches.length === 2) {
        event.preventDefault();
        const targetScale = clamp(
          (getTouchDistance(event.touches) / gesture.startDistance) * gesture.startTransform.scale,
          minScale,
          maxScale,
        );
        const effectiveRatio = targetScale / gesture.startTransform.scale;
        const center = getTouchCenter(event.touches);
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const viewportCenterX = rect.left + rect.width / 2;
        const viewportCenterY = rect.top + rect.height / 2;
        const nextX =
          center.x -
          viewportCenterX -
          (gesture.startCenterX - viewportCenterX - gesture.startTransform.x) * effectiveRatio;
        const nextY =
          center.y -
          viewportCenterY -
          (gesture.startCenterY - viewportCenterY - gesture.startTransform.y) * effectiveRatio;
        scheduleTransform(
          normalizeTransform({ scale: targetScale, x: nextX, y: nextY }),
        );
        return;
      }

      if (gesture.type === "pan" && event.touches.length === 1) {
        event.preventDefault();
        const touch = event.touches[0];
        scheduleTransform(
          normalizeTransform({
            scale: gesture.startTransform.scale,
            x: gesture.startTransform.x + touch.clientX - gesture.startX,
            y: gesture.startTransform.y + touch.clientY - gesture.startY,
          }),
        );
        return;
      }

      if (event.touches.length !== 1) {
        gestureRef.current = null;
      }
    },
    [scheduleTransform, normalizeTransform],
  );

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      flushScheduledTransform();
      setIsGesturing(false);

      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;

      if (gesture.type !== "swipe" || event.changedTouches.length !== 1) {
        return;
      }

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      const now = Date.now();

      if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10 && now - lastTapRef.current < 280) {
        event.preventDefault();
        lastTapRef.current = 0;
        toggleZoom();
        return;
      }
      lastTapRef.current = now;

      if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) {
        return;
      }

      if (deltaX > 0) {
        goPrev();
      } else {
        goNext();
      }
    },
    [goPrev, goNext, toggleZoom, flushScheduledTransform],
  );

  const handleTouchCancel = useCallback(() => {
    cancelScheduledTransform();
    setIsGesturing(false);
    gestureRef.current = null;
  }, [cancelScheduledTransform]);

  if (!current) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={contentRef}
          aria-describedby={undefined}
          onClick={(event) => event.stopPropagation()}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center outline-none"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览
          </DialogPrimitive.Title>


          <div
            ref={canvasRef}
            data-image-canvas
            className="relative flex min-h-0 w-full flex-1 touch-none items-center justify-center overflow-hidden sm:absolute sm:inset-0"
            onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
            onPointerDown={(event) => {
              if (event.pointerType !== "mouse" || event.button !== 0 || event.target !== imageRef.current) return;
              const currentTransform = pendingTransformRef.current ?? transform;
              event.preventDefault();
              flushScheduledTransform();
              mouseDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startTransform: currentTransform };
              imageRef.current!.setPointerCapture(event.pointerId);
              setIsGesturing(true);
            }}
            onPointerMove={(event) => {
              const drag = mouseDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
              scheduleTransform(normalizeTransform({ scale: drag.startTransform.scale, x: drag.startTransform.x + dx, y: drag.startTransform.y + dy }));
            }}
            onPointerUp={finishMouseDrag}
            onPointerCancel={finishMouseDrag}
            onLostPointerCapture={finishMouseDrag}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
          >
            {visible && <img
              ref={imageRef}
              src={visible.url}
              alt=""
              decoding="sync"
              className={cn(
                "max-h-full max-w-[90vw] rounded-lg object-contain will-change-transform sm:max-h-[82dvh]",
                isGesturing ? "" : "transition-transform duration-150 ease-out",
                transform.scale > minScale ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
              )}
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                toggleZoom();
              }}
              draggable={false}
            />}
          {hasPrev && transform.scale <= minScale && (
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={pageLoading}
                  className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-sm transition hover:bg-black/60 focus-visible:outline-2 disabled:opacity-40 sm:left-6"
                  aria-label="上一张"
                >
                  <ChevronLeft className="size-5" />
                </button>
              )}

              {hasNext && transform.scale <= minScale && (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={pageLoading}
                  className="absolute right-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-sm transition hover:bg-black/60 focus-visible:outline-2 disabled:opacity-40 sm:right-6"
                  aria-label="下一张"
                >
                  <ChevronRight className="size-5" />
                </button>
              )}
          </div>
          <div className="relative z-10 mb-[max(1rem,env(safe-area-inset-bottom))] max-h-[55dvh] w-max max-w-[94vw] shrink-0 overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-black/55 p-2 text-sm text-white shadow-2xl backdrop-blur-md sm:absolute sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:left-1/2 sm:mb-0 sm:max-h-[calc(100dvh-2rem)] sm:-translate-x-1/2">
            {failedImage === targetKey ? <p role="alert" className="mb-2 text-center text-sm">目标图片加载失败。<button type="button" className="ml-2 min-h-9 underline" onClick={() => { setFailedImage(null); setLoadAttempt((value) => value + 1); }}><RotateCcw className="mr-1 inline size-4" />重试加载</button></p>
              : !ready && <p role="status" className="mb-2 text-center text-sm">正在加载{pageLoading ? "下一页图片" : `第 ${offset + currentIndex + 1} 张图片`}…</p>}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-2 text-xs">{[shown.sizeLabel, visible?.dimensions ?? shown.dimensions].filter(Boolean).join(" · ") || "图片"}</span>
              <span className="rounded-full bg-white/10 px-3 py-2 text-xs">图片 {shown.ordinal ?? (visible ? visible.offset + visible.index + 1 : offset + currentIndex + 1)}（{visible ? visible.offset + visible.index + 1 : offset + currentIndex + 1}/{total}）</span>
              <button type="button" onClick={resetTransform} disabled={!visible} aria-label="重置缩放" title="滚轮缩放，可同时按住左键拖拽；点击恢复 100%" className="min-h-9 rounded-full bg-white/10 px-3 text-xs tabular-nums disabled:opacity-50 focus-visible:outline-2">{Math.round(transform.scale * 100)}%</button>
              <button type="button" disabled={downloading || !ready} onClick={() => void handleDownload([current])} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white/10 px-3 disabled:opacity-50 focus-visible:outline-2" aria-label="下载图片"><Download className="size-4" />{downloads.some((item) => item.image.id === current.id && item.error) ? "重试下载" : "下载"}</button>
              {roundImages && <button type="button" disabled={downloading || !ready || !roundImages.length} onClick={() => void handleDownload(roundImages, true)} className="min-h-9 rounded-full bg-white/10 px-3 text-sm disabled:opacity-50 focus-visible:outline-2" aria-label="下载本轮成功图片">下载本轮（{roundImages.length}）</button>}
              {onDelete && <button type="button" disabled={!ready} onClick={onDelete} aria-label="删除当前生成结果" className="inline-flex min-h-9 items-center gap-1 rounded-full bg-rose-500/20 px-3 text-rose-200 hover:bg-rose-500/30 disabled:opacity-50 focus-visible:outline-2"><Trash2 className="size-4" />删除</button>}
              <DialogPrimitive.Close className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white/10 px-3 focus-visible:outline-2"><X className="size-4" />关闭</DialogPrimitive.Close>
            </div>
            {downloads.length > 0 && <div className="mx-auto mt-2 max-w-xl text-xs">
              <p role="status">已请求 {downloads.filter(item => item.name).length}/{downloads.length} 张{downloading ? "，正在逐张下载…" : ""}；失败 {downloads.filter(item => item.error).length} 张。</p>
              <details><summary className="cursor-pointer py-2">下载明细与逐张重试</summary>
                <div className="max-h-[min(30dvh,16rem)] overflow-y-auto overscroll-contain">
                <p>请检查浏览器下载记录；如多文件下载被拦截，请允许后逐张点击下方按钮继续下载。</p>
                {downloads.map(item => <div key={item.image.id} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 break-all">{item.name || item.image.filename || item.image.id} · {item.error || (item.name ? "已请求下载" : "待下载")}</span>
                  <button type="button" disabled={downloading} onClick={() => void handleDownload([item.image])} className="min-h-9 shrink-0 rounded bg-white/10 px-2 disabled:opacity-50">{item.error ? "重试" : "再次下载"}</button>
                </div>)}
                </div>
              </details>
            </div>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
