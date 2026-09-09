"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, ExternalLink, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { downloadStoredImage, useImageSource } from "@/store/image-conversations";
import { getStoredAuthKey } from "@/store/auth";
import { IdentityChanged } from "@/lib/identity-request";

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

function normalizeTransform(transform: ImageTransform) {
  if (transform.scale <= minScale) {
    return { scale: minScale, x: 0, y: 0 };
  }

  const maxX = window.innerWidth * (transform.scale - 1) * 0.5;
  const maxY = window.innerHeight * (transform.scale - 1) * 0.5;
  return {
    scale: transform.scale,
    x: clamp(transform.x, -maxX, maxX),
    y: clamp(transform.y, -maxY, maxY),
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
  const gestureRef = useRef<TouchGesture | null>(null);
  const lastTapRef = useRef(0);
  const pendingTransformRef = useRef<ImageTransform | null>(null);
  const rafRef = useRef<number | null>(null);
  const [transform, setTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const [dimensions, setDimensions] = useState<{ id: string; value: string } | null>(null);
  const [downloads, setDownloads] = useState<{ image: LightboxImage; name?: string; error?: string }[]>([]);
  const [downloading, setDownloading] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  const current = images[currentIndex];
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const markFailed = useCallback(() => setFailedImage(current?.id ?? null), [current?.id]);
  const imageSource = useImageSource(open ? current?.src : undefined, loadAttempt, markFailed);
  const hasPrev = offset + currentIndex > 0;
  const hasNext = offset + currentIndex < total - 1;

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
  }, [cancelScheduledTransform]);

  const goPrev = useCallback(() => {
    if (hasPrev && !pageLoading) onIndexChange(currentIndex - 1);
  }, [hasPrev, currentIndex, onIndexChange, pageLoading]);

  const goNext = useCallback(() => {
    if (hasNext && !pageLoading) onIndexChange(currentIndex + 1);
  }, [hasNext, currentIndex, onIndexChange, pageLoading]);

  useEffect(() => {
    resetTransform();
    setFailedImage(null);
  }, [current?.id, open, resetTransform]);

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
      } else if (e.key === "Delete" && onDelete) {
        e.preventDefault();
        onDelete();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext, onDelete]);

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
    setTransform((currentTransform) =>
      currentTransform.scale > minScale ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 },
    );
  }, []);

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
        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
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
    [scheduleTransform],
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
            className="relative flex min-h-0 w-full flex-1 touch-none items-center justify-center overflow-hidden sm:absolute sm:inset-0"
            onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
          >
            <img
              key={`${current.id}:${loadAttempt}`}
              src={imageSource}
              alt=""
              onError={markFailed}
              onLoad={(event) => setDimensions({ id: current.id, value: `${event.currentTarget.naturalWidth} x ${event.currentTarget.naturalHeight}` })}
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
            />
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
            {failedImage === current.id && <p role="alert" className="mb-2 text-center text-sm">原图加载失败。<button type="button" className="ml-2 min-h-9 underline" onClick={() => { setFailedImage(null); setLoadAttempt((value) => value + 1); }}><RotateCcw className="mr-1 inline size-4" />重试加载</button></p>}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-2 text-xs">{[current.sizeLabel, dimensions?.id === current.id ? dimensions.value : current.dimensions].filter(Boolean).join(" · ") || "图片"}</span>
              <span className="rounded-full bg-white/10 px-3 py-2 text-xs">图片 {current.ordinal ?? offset + currentIndex + 1}（{offset + currentIndex + 1}/{total}）{pageLoading ? " 加载中…" : ""}</span>
              <button type="button" disabled={downloading} onClick={() => void handleDownload([current])} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white/10 px-3 disabled:opacity-50 focus-visible:outline-2" aria-label="下载图片"><Download className="size-4" />{downloads.some((item) => item.image.id === current.id && item.error) ? "重试下载" : "下载"}</button>
              {imageSource && <a href={imageSource} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white/10 px-3 focus-visible:outline-2"><ExternalLink className="size-4" />打开原图</a>}
              {roundImages && <button type="button" disabled={downloading || !roundImages.length} onClick={() => void handleDownload(roundImages, true)} className="min-h-9 rounded-full bg-white/10 px-3 text-sm disabled:opacity-50 focus-visible:outline-2" aria-label="下载本轮成功图片">下载本轮（{roundImages.length}）</button>}
              {onDelete && <button type="button" onClick={onDelete} aria-label="删除当前生成结果" className="inline-flex min-h-9 items-center gap-1 rounded-full bg-rose-500/20 px-3 text-rose-200 hover:bg-rose-500/30 focus-visible:outline-2"><Trash2 className="size-4" />删除</button>}
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
