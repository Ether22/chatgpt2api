"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Clock3, Download, EyeOff, LoaderCircle, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurn, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";
import { downloadStoredImage, useImageSource } from "@/store/image-conversations";
import { ReferenceThumbnail } from "./reference-thumbnail";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
  filename?: string;
  conversationId?: string;
  turnId?: string;
  ordinal?: number;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  imageDimensions: Map<string, { width: number; height: number }>;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onDeleteImage: (conversationId: string, turnId: string, imageId: string, ordinal: number) => void;
  onRetryDeleteImage: (conversationId: string, turnId: string, imageId: string, ordinal: number) => void | Promise<void>;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string, count?: number) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onTimeoutRetryContinue: (taskId: string) => void | Promise<void>;
  onDismissErrors: (conversationId: string, turnId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

export function getStoredImageSrc(image: StoredImage) {
  return image.url || (image.b64_json ? `data:image/png;base64,${image.b64_json}` : "");
}

export function resultFilename(turn: ImageTurn, image: StoredImage, index: number) {
  const ordinal = image.ordinal ?? index + 1;
  const clean = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "");
  if (!turn.md) return `${clean(turn.prompt.replace(/\s+/g, " ").trim()).slice(0, 60) || "image"}_${ordinal}.png`;
  const { document_id, name, output_name } = turn.md;
  const identifier = clean(document_id).slice(0, 30);
  const output = clean(output_name?.replace(/\.[^.]+$/, "") || "").slice(0, 100);
  const suffix = `_${ordinal}${output ? `_${output}` : ""}.png`;
  return `${identifier}_${clean(name).slice(0, 180 - identifier.length - 1 - suffix.length)}${suffix}`;
}

export function ImageResults({
  selectedConversation,
  imageDimensions,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onDeleteImage,
  onRetryDeleteImage,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  onTimeoutRetryContinue,
  onDismissErrors,
  formatConversationTime,
}: ImageResultsProps) {
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // 仅在存在 loading 图片时启动定时器，避免空闲时无谓重渲染
  const hasLoadingImages = selectedConversation?.turns.some(
    (turn) => !turn.resultsDeleted && turn.images.some((image) => image.status === "loading"),
  );
  useEffect(() => {
    if (!hasLoadingImages) return;
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, [hasLoadingImages]);

  const updateImageDimensions = (id: string, width: number, height: number) => {
    imageDimensions.set(id, { width, height });
    // ponytail: retain geometry for 400 recent images; use server dimensions if older-page restoration needs it.
    if (imageDimensions.size > 400) imageDimensions.delete(imageDimensions.keys().next().value!);
  };
  const dimensionsLabel = (id: string) => {
    const size = imageDimensions.get(id);
    return size ? formatImageDimensions(size.width, size.height) : undefined;
  };

  if (!selectedConversation || selectedConversation.turns.length === 0) {
    return (
      <div className="flex h-full min-h-[260px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl">
          <h1
            className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            会话与任务保存在服务器，同一身份换浏览器后可以继续查看和生成。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const readyReferences = turn.referenceImages.filter(image => image.url);
        const referenceLightboxImages = readyReferences.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.url,
          filename: image.name,
        }));
        const successfulTurnImages = turn.images.flatMap((image, index) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  sizeLabel: formatStoredImageSize(image),
                  dimensions: dimensionsLabel(image.id),
                  filename: resultFilename(turn, image, index),
                  ordinal: image.ordinal ?? index + 1,
                  conversationId: selectedConversation.id,
                  turnId: turn.id,
                },
              ]
            : [];
        });

        return (
          <div key={turn.id} data-turn-id={turn.id} data-result-anchor tabIndex={-1} className="flex flex-col gap-3 outline-none sm:gap-4">
            {!turn.promptDeleted ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] px-1 py-1 text-[14px] leading-6 text-stone-900 sm:max-w-[82%] sm:text-[15px] sm:leading-7">
                  <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-stone-400 sm:mb-2">
                    <span>第 {(selectedConversation.pagination?.offset ?? 0) + turnIndex + 1} 轮</span>
                    <span>
                      {turn.mode === "edit" ? "编辑图" : "文生图"}
                    </span>
                    <span>{getTurnStatusLabel(turn.status)}</span>
                    <span>{formatConversationTime(turn.createdAt)}</span>
                    {turn.md && <span>{turn.md.document_id} · {turn.md.name} · {turn.md.document_name}</span>}
                  </div>
                  <CollapsiblePrompt prompt={turn.prompt} id={`prompt-${turn.id}`} />
                  <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      复用配置
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePrompt(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除提示词记录"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex justify-end text-xs text-stone-500">
                <span>提示词已删除</span>
                <button type="button" className="ml-3 underline" onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}>复用其他配置</button>
              </div>
            )}

            {!turn.resultsDeleted ? (
              <div className="flex justify-start">
                <div className="w-full p-1">
                  {readyReferences.length > 0 ? (
                    <div className="mb-4 flex flex-col items-end">
                      <div className="mb-3 text-xs font-medium text-stone-500">本轮参考图</div>
                      <div className="flex flex-wrap justify-end gap-3">
                        {readyReferences.map((image, index) => (
                          <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                              className="group relative h-24 w-24 overflow-hidden border border-stone-200/80 bg-stone-100/60 text-left transition hover:border-stone-300"
                              aria-label={`预览参考图 ${image.name || index + 1}`}
                            >
                              <ReferenceThumbnail
                                src={image.url}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                              />
                            </button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="rounded-full border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                              onClick={() => onContinueEdit(selectedConversation.id, image)}
                            >
                              <Sparkles className="size-4" />
                              加入编辑
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                    <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                    {turn.status === "queued" ? (
                      <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">等待账号可用容量</span>
                    ) : null}
                  </div>

                  {turn.resultCleanups?.map((cleanup) => (
                    <div key={cleanup.id} role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700">
                      <span className="min-w-0 break-words">结果 {cleanup.ordinal} 已隐藏。{cleanup.state === "error" ? `清理失败：${cleanup.error}` : cleanup.state === "retained" ? "清理时文件仍被其他轮次或素材使用，已保留。可重试检查引用是否已释放。" : "正在清理文件；服务中断后可重试。"}</span>
                      <Button size="sm" variant="outline" onClick={() => void onRetryDeleteImage(selectedConversation.id, turn.id, cleanup.id, cleanup.ordinal)}>重试清理结果 {cleanup.ordinal}</Button>
                    </div>
                  ))}
                  <div className="grid grid-cols-3 items-start gap-2 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] sm:gap-4">
                    {turn.images.map((image, index) => {
                      const ordinal = image.ordinal ?? index + 1;
                      const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                      if (image.status === "success" && imageSrc) {
                        const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                        const sizeLabel = formatStoredImageSize(image);
                        const dimensions = dimensionsLabel(image.id);
                        const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                        return (
                          <div
                            key={image.id}
                            data-image-id={image.id} data-result-anchor tabIndex={-1}
                            className="min-w-0"
                          >
                            <LazyImage
                              src={imageSrc}
                              dimensions={imageDimensions.get(image.id)}
                              alt={`Generated result ${ordinal}`}
                              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-xl sm:aspect-auto"
                              onLoad={(event) => {
                                updateImageDimensions(
                                  image.id,
                                  event.currentTarget.naturalWidth,
                                  event.currentTarget.naturalHeight,
                                );
                              }}
                              onOpen={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                            />
                            <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-3 sm:text-xs">
                              <div className="min-w-0 text-stone-500">
                                <span>结果 {ordinal}</span>
                                {image.durationMs != null ? <span className="text-stone-400 sm:ml-2">{formatDuration(image.durationMs)}</span> : null}
                                <span className="block min-h-[1lh] text-stone-400">{imageMeta || "\u00a0"}</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 shrink-0 rounded-full border-stone-200 bg-white px-0 text-rose-600 sm:h-8 sm:w-8"
                                  onClick={() => onDeleteImage(selectedConversation.id, turn.id, image.id, ordinal)}
                                  aria-label={`删除结果 ${ordinal}`}
                                >
                                  <Trash2 className="size-3 sm:size-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:h-8 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => onContinueEdit(selectedConversation.id, image)}
                                  aria-label="加入编辑"
                                >
                                  <Sparkles className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">加入编辑</span>
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:h-8 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => void downloadStoredImage(getStoredImageSrc(image), resultFilename(turn, image, index)).catch(error => toast.error(error instanceof Error ? error.message : "下载失败"))}
                                  aria-label="下载"
                                >
                                  <Download className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">下载</span>
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (image.status === "error") {
                        const isTimeoutError = image.canResume && image.taskId;
                        return (
                          <div key={image.id} data-image-id={image.id} data-result-anchor tabIndex={-1} className="min-w-0">
                            <div
                              className={cn(
                                "overflow-auto rounded-xl border border-rose-200 bg-rose-50",
                                "min-h-56 sm:aspect-square",
                                turn.ratio === "1:1" && "sm:aspect-square",
                                turn.ratio === "16:9" && "sm:aspect-video",
                                turn.ratio === "9:16" && "sm:aspect-[9/16]",
                                turn.ratio === "4:3" && "sm:aspect-[4/3]",
                                turn.ratio === "3:4" && "sm:aspect-[3/4]",
                              )}
                            >
                            <div className="flex h-full min-h-56 flex-col items-center justify-center gap-1.5 px-2 py-2 text-center text-[11px] leading-4 text-rose-600 sm:gap-3 sm:px-6 sm:py-8 sm:text-sm sm:leading-6">
                              <p className="font-medium">图片 {ordinal}/{turn.count}</p>
                              <span className="shrink-0 line-clamp-2 sm:line-clamp-none">{image.error || "生成失败"}</span>
                              <details className="w-full text-left">
                                <summary className="cursor-pointer text-center">失败详情</summary>
                                <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px]">{image.errorDetail || JSON.stringify({ task_id: image.taskId || image.id, error: image.error }, null, 2)}</pre>
                                <button type="button" className="underline" onClick={() => void navigator.clipboard.writeText(image.errorDetail || JSON.stringify({ task_id: image.taskId || image.id, error: image.error }, null, 2)).then(() => toast.success("已复制失败详情"), () => toast.error("复制失败，请选中详情手动复制"))}>复制失败详情</button>
                              </details>
                              <div className="flex flex-wrap justify-center gap-2">
                                {isTimeoutError && (
                                  <button
                                    type="button"
                                    onClick={() => void onTimeoutRetryContinue(image.taskId!)}
                                    className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-medium text-emerald-600 shadow-sm transition hover:bg-emerald-200 sm:px-3 sm:text-xs"
                                  >
                                    继续等待
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                  className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-rose-600 shadow-sm transition hover:bg-rose-100 sm:px-3 sm:text-xs"
                                >
                                  重新生成这一张
                                </button>
                              </div>
                            </div>
                            </div>
                            <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-3 sm:text-xs">
                              <div className="min-w-0 text-stone-500">
                                <span>结果 {ordinal}</span>
                                {image.durationMs != null ? <span className="text-stone-400 sm:ml-2">{formatDuration(image.durationMs)}</span> : null}
                                <span className="block text-transparent">-</span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const imageTaskStatus = image.taskStatus || (turn.status === "queued" ? "queued" : "running");
                      const imageStatusLabel = image.waiting?.message ? `${image.waiting.message}${image.waiting.restore_at ? `（${new Date(image.waiting.restore_at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}）` : ""}` : imageTaskStatus === "queued" ? "排队中" : getProgressLabel(image.progress);
                      const showElapsed = imageTaskStatus === "running" && image.elapsedSecs != null;
                      const elapsedDisplay = showElapsed
                        ? formatElapsed(
                            image.elapsedUpdatedAt != null
                              ? image.elapsedSecs! + (currentTime - image.elapsedUpdatedAt!) / 1000
                              : image.elapsedSecs!,
                          )
                        : null;
                      return (
                        <div key={image.id} data-image-id={image.id} data-result-anchor tabIndex={-1} className="min-w-0">
                          <div
                            className={cn(
                              "overflow-hidden rounded-xl border border-stone-200/80 bg-stone-100/80 relative",
                              turn.ratio === "1:1" && "aspect-square",
                              turn.ratio === "16:9" && "aspect-video",
                              turn.ratio === "9:16" && "aspect-[9/16]",
                              turn.ratio === "4:3" && "aspect-[4/3]",
                              turn.ratio === "3:4" && "aspect-[3/4]",
                            )}
                          >
                          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 py-3 text-center text-stone-500 sm:gap-3 sm:px-6 sm:py-8">
                            <div className="rounded-full bg-white p-2 shadow-sm sm:p-3">
                              {imageTaskStatus === "queued" ? (
                                <Clock3 className="size-4 sm:size-5" />
                              ) : (
                                <LoaderCircle className="size-4 animate-spin sm:size-5" />
                              )}
                            </div>
                            <p className="text-[11px] font-medium leading-4 sm:text-sm">
                              图片 {ordinal}/{turn.count}
                            </p>
                            <p className="text-[10px] leading-4 text-stone-400 sm:text-xs">
                              {imageStatusLabel}
                            </p>
                          </div>
                          </div>
                          {elapsedDisplay != null && (
                            <div className="px-0.5 py-1 text-[10px] text-stone-400 sm:px-3 sm:py-3 sm:text-xs">{elapsedDisplay}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {turn.status === "error" && turn.error ? (
                    <div className="mt-4 flex items-center justify-between border-l-2 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                      <span>{turn.error}</span>
                      <button
                        type="button"
                        onClick={() => void onDismissErrors(selectedConversation.id, turn.id)}
                        className="ml-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700 transition hover:bg-amber-200 hover:text-amber-900"
                      >
                        <EyeOff className="size-3" />
                        忽略错误
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] sm:mt-4">
                    <RegenerateTurn count={turn.count} onRegenerate={(count) => onRegenerateTurn(selectedConversation.id, turn.id, count)} />
                    <button
                      type="button"
                      onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除生成结果"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RegenerateTurn({ count, onRegenerate }: { count: number; onRegenerate: (count: number) => void | Promise<void> }) {
  const [value, setValue] = useState(String(count));
  const valid = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100;
  return <>
    <label className="flex items-center gap-1">新轮数量
      <input type="text" inputMode="numeric" pattern="[0-9]*" value={value} aria-invalid={!valid}
        onChange={(event) => setValue(event.target.value)} className="w-12 rounded border border-stone-200 px-1.5 py-1" />
    </label>
    <button type="button" disabled={!valid} onClick={() => void onRegenerate(Number(value))}
      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-500 transition hover:bg-stone-200 disabled:opacity-40">
      <RotateCcw className="size-3" />重新生成
    </button>
    {!valid && <span role="alert" className="text-rose-600">请输入1–100的纯数字整数</span>}
  </>;
}

function CollapsiblePrompt({ prompt, id }: { prompt: string; id: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      setIsLong(element.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt]);

  return (
    <div className="text-right">
      <div ref={textRef} id={id} className={cn("whitespace-pre-wrap break-words", !expanded && "line-clamp-2")}>
        {prompt}
      </div>
      {isLong ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 rounded px-1 text-xs text-stone-500 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-stone-500"
        >
          {expanded ? "收起 Prompt" : "展开 Prompt"}
        </button>
      ) : null}
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

const PROGRESS_LABELS: Record<string, string> = {
  getting_account: "确认可用账号",
  uploading: "上传图片",
  bootstrapping: "预热首页",
  getting_token: "获取 token",
  preparing_conversation: "准备会话",
  starting_generation: "启动生成",
  generating: "生成中",
  receiving_image: "接收图片中",
};

function getProgressLabel(progress?: string) {
  if (!progress) {
    return "生成中";
  }
  return PROGRESS_LABELS[progress] || "生成中";
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStoredImageSize(image: StoredImage) {
  if (image.file_size === undefined && !image.b64_json) return undefined;
  const normalized = (image.b64_json ?? "").replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = image.file_size ?? Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${bytes} B`;
  }
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}

const LazyImage = memo(function LazyImage({ src, alt, className, dimensions, onLoad, onOpen }: {
  src: string;
  alt: string;
  className: string;
  dimensions?: { width: number; height: number };
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onOpen?: () => void;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [size, setSize] = useState(dimensions);
  const placeholderHeightRef = useRef(280);
  const imageSource = useImageSource(isVisible ? src : undefined);
  const imgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = imgRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)!;
        if (!entry.isIntersecting && entry.boundingClientRect.height > 0) placeholderHeightRef.current = entry.boundingClientRect.height;
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className="relative" style={!size ? { minHeight: placeholderHeightRef.current } : undefined} data-image-frame>
      {isVisible && imageSource ? (
        <button
          type="button"
          onClick={onOpen}
          className={className}
        >
          <img
            src={imageSource}
            alt={alt}
            width={size?.width}
            height={size?.height}
            className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:h-auto sm:object-contain"
            onLoad={(event) => {
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              onLoad?.(event);
            }}
          />
        </button>
      ) : (
        <div
          style={size ? { "--image-ratio": `${size.width} / ${size.height}` } as React.CSSProperties : { height: placeholderHeightRef.current }}
          className={cn("rounded-xl bg-stone-100", className, size && "sm:aspect-[var(--image-ratio)]")}
        />
      )}
    </div>
  );
});
