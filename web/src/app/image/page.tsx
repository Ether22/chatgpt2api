"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, History, ListTree, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageCleanups } from "@/app/image/components/image-cleanups";
import { ImageImportDialog } from "@/app/image/components/image-import-dialog";
import { ImageResults, resultFilename, getStoredImageSrc, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageNavigation, type ResultTarget } from "@/app/image/components/image-navigation";
import { ImageLightbox } from "@/components/image-lightbox";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  fetchAccounts,
  fetchImageTasks,
  fetchModels,
  resumeImagePoll,
  type Account,
  type ImageModel,
  type Model,
} from "@/lib/api";
import { identityAuth, IdentityChanged } from "@/lib/identity-request";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { formatBeijingDateTime as formatConversationTime } from "@/lib/business-time";
import { useSettingsStore } from "@/app/settings/store";
import {
  clearImageConversations,
  fetchImageHistory,
  fetchImageConversation,
  fetchExistingImageConversation,
  fetchImageConversationMetadata,
  fetchStoredImageBlob,
  selectImageConversation,
  submitImageTurn,
  updateTurnVisibility,
  deleteImageConversation,
  deleteImageResult,
  getImageConversationStats,
  renameImageConversation,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ResultCleanup,
  type StoredImage,
  type StoredReferenceImage,
  type DraftReferenceImage,
  uploadReferenceImage,
  releaseReferenceImage,
  cancelReferenceUpload,
  retainReferenceImage,
  fetchReferenceImages,
} from "@/store/image-conversations";

const IMAGE_RATIO_STORAGE_KEY = "chatgpt2api:image_last_ratio";
const IMAGE_TIER_STORAGE_KEY = "chatgpt2api:image_last_tier";
const IMAGE_QUALITY_STORAGE_KEY = "chatgpt2api:image_last_quality";
const IMAGE_MODEL_STORAGE_KEY = "chatgpt2api:image_last_model";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const SCROLL_POSITIONS_STORAGE_KEY = "chatgpt2api:image_scroll_positions_full";
const SCROLL_TO_LATEST_THRESHOLD = 160;

function loadScrollPositions(storageKey = SCROLL_POSITIONS_STORAGE_KEY): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveScrollPositions(positions: Map<string, number>, storageKey = SCROLL_POSITIONS_STORAGE_KEY) {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, number> = {};
    positions.forEach((value, key) => { obj[key] = value; });
    window.sessionStorage.setItem(storageKey, JSON.stringify(obj));
  } catch {
    // sessionStorage may be full or unavailable
  }
}

function parseImageCount(value: string) {
  const count = Number(value);
  return /^\d+$/.test(value) && Number.isInteger(count) && count >= 1 && count <= 100 ? count : null;
}
function parseImageSize(size: string) {
  const match = size.match(/^(\d+)x(\d+)$/);
  return match ? { width: match[1], height: match[2] } : { width: "1024", height: "1024" };
}


function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status === "正常" && account.usage_mode === "normal");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function filterImageModels(items: Model[]): ImageModel[] {
  return items
    .map((item) => String(item.id || "").trim())
    .filter((id, index, list) => id.toLowerCase().includes("image") && list.indexOf(id) === index);
}

function normalizeStoredImageModel(value: string | null, availableModels: ImageModel[]): ImageModel {
  const normalized = String(value || "").trim();
  if (normalized && availableModels.includes(normalized)) {
    return normalized;
  }
  return availableModels[0] || "gpt-image-2";
}

async function fetchImageAsFile(authKey: string, url: string, fileName: string) {
  const blob = await fetchStoredImageBlob(url, undefined, authKey);
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) => {
    const stats = getImageConversationStats(conversation);
    return stats.queued + stats.running > 0;
  });
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function ImagePageContent({ isAdmin, authKey }: { isAdmin: boolean; authKey: string }) {
  const didLoadQuotaRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const imageDimensionsRef = useRef(new Map<string, { width: number; height: number }>());
  const historyReadVersionRef = useRef(0);
  const deletionRequestsRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const firstPageIdsRef = useRef(new Set<string>());
  const historyTotalRef = useRef(0);
  const pendingSubmissionRef = useRef<{ signature: string; turn: ImageTurn; conversationId: string | null; draftId?: string } | null>(null);
  const [draftId, setDraftId] = useState(createId);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const pendingRegenerationsRef = useRef(new Map<string, ImageTurn>());
  const loadCancelledRef = useRef(false);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const lastConversationIdRef = useRef<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const keepReadingPositionRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollPositionsRef = useRef<Map<string, number>>(loadScrollPositions());
  const isRestoringScrollRef = useRef(false);
  const scrollRestoreGenerationRef = useRef(0);
  const pendingTargetRef = useRef<ResultTarget | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<(ResultTarget & { top?: number }) | null>(null);

  const config = useSettingsStore((state) => state.config);
  const imageTimeoutRetrySecs = Number(config?.image_timeout_retry_secs || 30);

  const [imagePrompt, setImagePrompt] = useState("");
  useEffect(() => {
    let cancelled = false;
    const checkIdentity = () => void identityAuth(authKey).catch(() => {
      if (cancelled) return;
      cancelled = true;
      loadCancelledRef.current = true;
      setImagePrompt("");
      for (const image of referenceImagesRef.current) if (image.url.startsWith("blob:")) URL.revokeObjectURL(image.url);
      referenceImagesRef.current = [];
      updateReferenceImages([]);
      window.location.reload();
    });
    const timer = setInterval(checkIdentity, 1000);
    window.addEventListener("focus", checkIdentity);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("focus", checkIdentity); };
  }, [authKey]);
  const [imageCount, setImageCount] = useState("4");
  const [imageRatio, setImageRatio] = useState("auto");
  const [imageTier, setImageTier] = useState("1k");
  const [imageWidth, setImageWidth] = useState("1024");
  const [imageHeight, setImageHeight] = useState("1024");
  const [imageQuality, setImageQuality] = useState("auto");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-2");
  const [imageModels, setImageModels] = useState<ImageModel[]>(["gpt-image-2"]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isImportsOpen, setIsImportsOpen] = useState(false);
  const [referenceImages, updateReferenceImages] = useState<DraftReferenceImage[]>([]);
  const referenceImagesRef = useRef<DraftReferenceImage[]>([]);
  const activeSubmissionReferences = useRef(new Map<string, number>());
  const deferredReleases = useRef(new Map<string, DraftReferenceImage>());
  const setReferenceImages = useCallback((value: DraftReferenceImage[] | ((previous: DraftReferenceImage[]) => DraftReferenceImage[])) => {
    if (loadCancelledRef.current) return;
    const previous = referenceImagesRef.current;
    const next = typeof value === "function" ? value(previous) : value;
    referenceImagesRef.current = next;
    updateReferenceImages(next);
    for (const image of previous) {
      if (image.url.startsWith("blob:") && !next.some((item) => item.url === image.url)) URL.revokeObjectURL(image.url);
    }
  }, []);
  const releaseInputs = useCallback((images: DraftReferenceImage[]) => {
    for (const image of images) {
      if (activeSubmissionReferences.current.has(image.id)) {
        deferredReleases.current.set(image.id, image);
        continue;
      }
      void (image.file ? cancelReferenceUpload(authKey, image.id) : releaseReferenceImage(authKey, image.id)).catch((error) => {
        if (loadCancelledRef.current || error instanceof IdentityChanged) return;
        toast.error(`释放参考图失败：${error.message}`);
        setReferenceImages((current) => current.some((item) => item.id === image.id) ? current
          : [...current, { ...image, url: image.file ? URL.createObjectURL(image.file) : image.url,
            uploading: false, releasing: true, error: "释放失败，请重试移除" }]);
      });
    }
  }, [authKey, setReferenceImages]);
  useEffect(() => {
    let cancelled = false;
    void fetchReferenceImages(authKey).then(({ items }) => {
      if (!cancelled) setReferenceImages((current) => [...current, ...items.filter((image) => !current.some((item) => item.id === image.id))]);
    }).catch((error) => { if (!cancelled && !(error instanceof IdentityChanged)) toast.error(`恢复参考图失败：${error.message}`); });
    return () => { cancelled = true; };
  }, [authKey, setReferenceImages]);
  useEffect(() => () => {
    for (const image of referenceImagesRef.current) {
      if (image.url.startsWith("blob:")) URL.revokeObjectURL(image.url);
    }
    referenceImagesRef.current = [];
    deferredReleases.current.clear();
  }, []);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [reuseSource, setReuseSource] = useState<{ conversationId: string; turnId: string } | null>(null);
  const reusingRef = useRef(false);
  useEffect(() => {
    setReuseSource((source) => source?.conversationId === selectedConversationId ? source : null);
  }, [selectedConversationId]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [availableQuota, setAvailableQuota] = useState("加载中...");
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deletedResults, setDeletedResults] = useState<Record<string, ResultCleanup>>({});
  const scrollToLatestBtnRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "one"; id: string }
    | { type: "prompt"; conversationId: string; turnId: string }
    | { type: "results"; conversationId: string; turnId: string }
    | { type: "image"; conversationId: string; turnId: string; imageId: string; ordinal: number }
    | { type: "all" }
    | null
  >(null);
  const parsedCount = parseImageCount(imageCount);
  const selectedConversation = useMemo(
    () => {
      const conversation = conversations.find((item) => item.id === selectedConversationId);
      return conversation ? { ...conversation, turns: conversation.turns.map((turn) => ({
        ...turn,
        images: turn.images.filter((image) => !deletedResults[image.id]),
        resultCleanups: [...(turn.resultCleanups || []), ...turn.images.flatMap((image) => deletedResults[image.id] ? [deletedResults[image.id]] : [])],
      })) } : null;
    },
    [conversations, selectedConversationId, deletedResults],
  );
  selectedIdRef.current = selectedConversationId;
  useEffect(() => {
    const ids = new Set(selectedConversation?.turns.flatMap((turn) => turn.resultsDeleted ? [] : turn.images.map((image) => image.id)));
    const remaining = lightboxImages.filter((image) => !image.turnId ||
      image.conversationId === selectedConversation?.id && ids.has(image.id));
    if (remaining.length === lightboxImages.length) return;
    setLightboxImages(remaining);
    setLightboxIndex((index) => Math.max(0, Math.min(index, remaining.length - 1)));
    if (!remaining.length) setLightboxOpen(false);
  }, [selectedConversation, lightboxImages]);
  const deleteConfirmTitle =
    deleteConfirm?.type === "image" ? `删除结果 ${deleteConfirm.ordinal}` : deleteConfirm?.type === "all"
      ? "清空历史记录"
      : deleteConfirm?.type === "prompt"
        ? "删除提示词记录"
        : deleteConfirm?.type === "results"
          ? "删除生成结果"
          : deleteConfirm?.type === "one"
            ? "删除对话"
            : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "image" ? "确认删除这张生成结果吗？图片将立即隐藏，后台清理原图、缩略图、标签和存储副本。其他轮次或素材仍使用的文件会保留。" : deleteConfirm?.type === "all"
      ? "确认删除当前登录身份的全部会话和生成结果吗？未发送任务将停止，已发送结果返回后自动清理。当前导入素材和输入参考图会保留。清理进度及失败重试可在“删除清理”查看。"
      : deleteConfirm?.type === "prompt"
        ? "确认删除这条提示词记录吗？对应生成结果会保留。"
        : deleteConfirm?.type === "results"
          ? "确认删除本轮全部生成结果吗？未发送任务将停止，已发送结果返回后自动清理。提示词及参考图快照保留供复用，其他轮次不受影响。"
          : deleteConfirm?.type === "one"
            ? "确认仅删除这条会话及其全部生成结果吗？未发送任务将停止，已发送结果返回后自动清理。其他会话、当前导入素材和输入参考图会保留。清理失败可在“删除清理”重试。"
            : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const getLatestResult = useCallback(() => {
    const turns = conversationsRef.current.find(item => item.id === selectedIdRef.current)?.turns;
    const latest = turns?.findLast(turn => !(turn.promptDeleted && turn.resultsDeleted));
    return [...(resultsViewportRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [])]
      .find(node => node.dataset.turnId === latest?.id);
  }, []);

  const getDistanceFromLatest = useCallback((root: HTMLElement) => {
    const latest = getLatestResult();
    if (!latest) return 0;
    const rect = latest.getBoundingClientRect(), viewport = root.getBoundingClientRect();
    return Math.max(0, rect.top - viewport.bottom, viewport.top - rect.bottom);
  }, [getLatestResult]);

  const scrollResultsToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    shouldStickToBottomRef.current = true;
    keepReadingPositionRef.current = false;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    const latest = getLatestResult();
    element.scrollTo({ top: latest ? element.scrollTop + latest.getBoundingClientRect().top - element.getBoundingClientRect().top : element.scrollHeight, behavior });
  }, [getLatestResult]);

  const handleResultsScroll = useCallback(() => {
    if (scrollRafRef.current !== null) {
      return;
    }

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const element = resultsViewportRef.current;
      if (!element) {
        return;
      }

      // 恢复滚动位置期间不处理滚动事件
      if (isRestoringScrollRef.current || lastConversationIdRef.current !== selectedIdRef.current) {
        return;
      }

      // 保存当前会话的滚动位置（debounce 300ms 写入 sessionStorage）
      const convId = lastConversationIdRef.current;
      if (convId) {
        scrollPositionsRef.current.set(convId, element.scrollTop);
        if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = setTimeout(() => {
          scrollSaveTimerRef.current = null;
          saveScrollPositions(scrollPositionsRef.current);
        }, 300);
      }

      const isAwayFromLatest = getDistanceFromLatest(element) > SCROLL_TO_LATEST_THRESHOLD;
      shouldStickToBottomRef.current = !keepReadingPositionRef.current && !isAwayFromLatest;
      // 直接操作 DOM 控制按钮显隐，避免 setState 触发全组件重渲染
      const btn = scrollToLatestBtnRef.current;
      if (btn) {
        if (isAwayFromLatest) {
          btn.style.display = "";
        } else {
          btn.style.display = "none";
        }
      }
    });
  }, [getDistanceFromLatest]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollSaveTimerRef.current !== null) {
        clearTimeout(scrollSaveTimerRef.current);
        saveScrollPositions(scrollPositionsRef.current);
      }
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const storedRatio =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_RATIO_STORAGE_KEY) : null;
      const storedTier =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_TIER_STORAGE_KEY) : null;
      const storedQuality =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY) : null;
      setImageRatio(storedRatio || "1:1");
      setImageTier(storedTier || "1k");
      setImageWidth("1024");
      setImageHeight("1024");
      setImageQuality(storedQuality || "auto");

      const readVersion = ++historyReadVersionRef.current;
      const history = await fetchImageHistory(authKey);
      const nextSelectedConversationId = history.current_conversation_id ?? pickFallbackConversationId(history.items);
      const detail = nextSelectedConversationId ? await fetchImageConversation(authKey, nextSelectedConversationId) : null;
      const normalizedItems = detail ? [...history.items.filter((item) => item.id !== detail.id), detail] : history.items;
      if (loadCancelledRef.current || deletionRequestsRef.current || readVersion !== historyReadVersionRef.current) {
        return;
      }

      conversationsRef.current = sortImageConversations(normalizedItems);
      setConversations(conversationsRef.current);
      setHistoryNextOffset(history.pagination.next_offset);
      setActiveTaskCount(history.stats.queued + history.stats.running);
      firstPageIdsRef.current = new Set(history.items.map((item) => item.id));
      historyTotalRef.current = history.pagination.total;
      setSelectedConversationId(nextSelectedConversationId);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "读取会话记录失败";
      toast.error(message);
    } finally {
      if (!loadCancelledRef.current) {
        setIsLoadingHistory(false);
      }
    }
  }, [
    authKey,
    setImageRatio,
    setImageTier,
    setImageWidth,
    setImageHeight,
    setImageQuality,
    setConversations,
    setSelectedConversationId,
    setIsLoadingHistory,
  ]);

  // Handle bfcache (back/forward cache) — re-sync task status on page restore
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void loadHistory();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [loadHistory]);

  useEffect(() => {
    loadCancelledRef.current = false;
    void loadHistory();
    return () => {
      loadCancelledRef.current = true;
      // 组件卸载时保存当前滚动位置到 sessionStorage
      const element = resultsViewportRef.current;
      const convId = lastConversationIdRef.current;
      if (element && convId) {
        scrollPositionsRef.current.set(convId, element.scrollTop);
        saveScrollPositions(scrollPositionsRef.current);
      }
    };
  }, [loadHistory]);

  useEffect(() => {
    let cancelled = false;

    const loadImageModels = async () => {
      try {
        const data = await fetchModels();
        const available = filterImageModels(Array.isArray(data.data) ? data.data : []);
        if (cancelled || available.length === 0) {
          return;
        }
        setImageModels(available);
        const storedModel = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) : null;
        setImageModel((current) => {
          if (available.includes(current)) {
            return current;
          }
          return normalizeStoredImageModel(storedModel, available);
        });
      } catch {
        if (!cancelled) {
          setImageModels(["gpt-image-2"]);
        }
      }
    };

    void loadImageModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuota = useCallback(async () => {
    if (!isAdmin) {
      setAvailableQuota("--");
      return;
    }
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((prev) => (prev === "加载中..." ? "--" : prev));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const handleFocus = () => {
      void loadQuota();
    };

    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAdmin, loadQuota]);

  // 切换会话时保存旧会话滚动位置，并隐藏容器防止闪烁
  useLayoutEffect(() => {
    if (!selectedConversation) {
      lastConversationIdRef.current = null;
      shouldStickToBottomRef.current = true;
      const btn = scrollToLatestBtnRef.current;
      if (btn) btn.style.display = "none";
      return;
    }
    if (!selectedConversation.pagination) return;

    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    const didSwitchConversation = lastConversationIdRef.current !== selectedConversation.id;

    if (didSwitchConversation) {
      keepReadingPositionRef.current = false;
      // 递增 generation，使之前未完成的 rAF 回调失效
      scrollRestoreGenerationRef.current += 1;

      // 更新为新会话 ID
      lastConversationIdRef.current = selectedConversation.id;

      // 如果有保存的滚动位置，隐藏容器防止用户看到 scrollTop=0 的内容
      const savedScrollTop = scrollPositionsRef.current.get(selectedConversation.id);
      if (savedScrollTop != null && savedScrollTop > 0) {
        element.style.visibility = "hidden";
        isRestoringScrollRef.current = true;
      }
    }
  }, [selectedConversation?.id, selectedConversation?.pagination?.offset]);

  useLayoutEffect(() => {
    const target = navigationTarget;
    const root = resultsViewportRef.current;
    if (!target || !root) return;
    const element = [...root.querySelectorAll<HTMLElement>(target.image_id ? "[data-image-id]" : "[data-turn-id]")]
      .find((node) => target.image_id ? node.dataset.imageId === target.image_id : node.dataset.turnId === target.turn_id);
    if (!element) return;
    scrollRestoreGenerationRef.current += 1;
    isRestoringScrollRef.current = false;
    root.style.visibility = "";
    const alignTarget = () => {
      root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - (target.top ?? 0);
      return root.scrollTop;
    };
    let anchoredScrollTop = alignTarget();
    if (target.top === undefined) element.focus({ preventScroll: true });
    shouldStickToBottomRef.current = false;
    const observer = new ResizeObserver(() => {
      // Stop holding the target once the user scrolls away from the applied position.
      if (!element.isConnected || root.scrollTop !== anchoredScrollTop) {
        observer.disconnect();
        return;
      }
      anchoredScrollTop = alignTarget();
    });
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    return () => observer.disconnect();
  }, [selectedConversation?.id, selectedConversation?.pagination?.offset, navigationTarget]);

  // 恢复滚动位置或跟随最新内容
  useEffect(() => {
    if (pendingTargetRef.current) {
      pendingTargetRef.current = null;
      return;
    }
    if (!selectedConversation?.pagination) {
      return;
    }

    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    const savedScrollTop = scrollPositionsRef.current.get(selectedConversation.id);

    if (savedScrollTop != null && savedScrollTop > 0) {
      // 捕获当前 generation，用于检测是否已被新的切换取代
      const generation = scrollRestoreGenerationRef.current;
      // 容器已在 useLayoutEffect 中设为 visibility:hidden，用户看不到滚动过程
      requestAnimationFrame(() => {
        // 如果 generation 已变，说明用户又切换了，放弃本次恢复
        if (scrollRestoreGenerationRef.current !== generation) return;
        element.scrollTop = savedScrollTop;
        // 再等一帧确保 scrollTop 生效后再显示容器
        requestAnimationFrame(() => {
          // 再次检查 generation
          if (scrollRestoreGenerationRef.current !== generation) return;
          const isAwayFromLatest = getDistanceFromLatest(element) > SCROLL_TO_LATEST_THRESHOLD;
          shouldStickToBottomRef.current = !keepReadingPositionRef.current && !isAwayFromLatest;
          const btn = scrollToLatestBtnRef.current;
          if (btn) btn.style.display = isAwayFromLatest ? "" : "none";
          // 显示容器 — 用户直接看到正确位置的内容
          element.style.visibility = "";
          isRestoringScrollRef.current = false;
        });
      });
      // 恢复后清除保存的位置，下次内容更新时走正常的 shouldFollowLatest 逻辑
      scrollPositionsRef.current.delete(selectedConversation.id);
      return;
    }

    // 无保存位置，按正常逻辑处理
    isRestoringScrollRef.current = false;
    element.style.visibility = "";
    const shouldFollowLatest = !keepReadingPositionRef.current && shouldStickToBottomRef.current;

    if (shouldFollowLatest) {
      const generation = scrollRestoreGenerationRef.current;
      requestAnimationFrame(() => {
        if (generation === scrollRestoreGenerationRef.current) scrollResultsToLatest("smooth");
      });
      return;
    }

    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "";
  }, [selectedConversation?.id, selectedConversation?.updatedAt, selectedConversation?.turns.length, selectedConversation?.pagination?.offset, selectedConversation?.target, scrollResultsToLatest, getDistanceFromLatest]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_RATIO_STORAGE_KEY, imageRatio);
    window.localStorage.setItem(IMAGE_TIER_STORAGE_KEY, imageTier);
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, imageQuality);
    window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, imageModel);
  }, [imageRatio, imageTier, imageQuality, imageModel]);

  useEffect(() => {
    try {
      const storedCount = window.localStorage.getItem(IMAGE_COUNT_STORAGE_KEY);
      if (storedCount !== null && parseImageCount(storedCount) !== null) {
        setImageCount(storedCount);
      }
    } catch {
      // Preferences are optional when browser storage is unavailable.
    }
  }, []);

  const handleImageCountChange = useCallback((value: string) => {
    setImageCount(value);
    if (parseImageCount(value) !== null) {
      try {
        window.localStorage.setItem(IMAGE_COUNT_STORAGE_KEY, value);
      } catch {
        // Keep the current selection usable even when it cannot be persisted.
      }
    }
  }, []);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const refreshHistory = useCallback(async (followLatest = true) => {
    const readVersion = ++historyReadVersionRef.current;
    const history = await fetchImageHistory(authKey);
    let id = followLatest ? history.current_conversation_id : selectedIdRef.current;
    let detail = id ? await fetchExistingImageConversation(authKey, id) : null;
    if (id && !detail) {
      id = history.current_conversation_id === id ? null : history.current_conversation_id;
      detail = id ? await fetchExistingImageConversation(authKey, id) : null;
    }
    if (!loadCancelledRef.current && !deletionRequestsRef.current && readVersion === historyReadVersionRef.current) {
      const root = resultsViewportRef.current;
      if (id === selectedIdRef.current && detail && root && (keepReadingPositionRef.current || !shouldStickToBottomRef.current)) {
        const viewport = root.getBoundingClientRect();
        const anchor = [...root.querySelectorAll<HTMLElement>("[data-result-anchor]")]
          .filter(node => node.getBoundingClientRect().bottom > viewport.top && node.getBoundingClientRect().top < viewport.bottom)
          .sort((a, b) => Math.abs(a.getBoundingClientRect().top - viewport.top) - Math.abs(b.getBoundingClientRect().top - viewport.top))[0];
        if (anchor) {
          const target = { turn_id: anchor.closest<HTMLElement>("[data-turn-id]")!.dataset.turnId!, image_id: anchor.dataset.imageId, top: anchor.getBoundingClientRect().top - viewport.top };
          pendingTargetRef.current = target;
          setNavigationTarget(target);
          scrollPositionsRef.current.delete(id!);
        }
      }
      const freshIds = new Set(history.items.map((item) => item.id));
      const firstPageChanged = history.pagination.total !== historyTotalRef.current ||
        freshIds.size !== firstPageIdsRef.current.size || [...freshIds].some((id) => !firstPageIdsRef.current.has(id));
      historyTotalRef.current = history.pagination.total;
      const previous = conversationsRef.current.filter((item) => !firstPageChanged && history.pagination.next_offset !== null &&
        !freshIds.has(item.id) && item.id !== detail?.id)
        .map((item) => ({ ...item, turns: [], pagination: undefined, sourceEntries: undefined }));
      firstPageIdsRef.current = freshIds;
      conversationsRef.current = sortImageConversations([...previous, ...history.items.filter((item) => item.id !== detail?.id), ...(detail ? [detail] : [])]);
      setConversations(conversationsRef.current);
      if (selectedIdRef.current !== id) {
        setSelectedConversationId(id);
        setLightboxOpen(false);
        setLightboxImages([]);
      }
      if (followLatest) {
        if (id) {
          scrollPositionsRef.current.delete(id);
        }
        setSelectedConversationId(id);
      }
      setActiveTaskCount(history.stats.queued + history.stats.running);
      setIsLoadingPage(false);
      if (firstPageChanged || history.pagination.next_offset === null) setHistoryNextOffset(history.pagination.next_offset);
    }
    return history;
  }, [authKey]);

  const acceptSubmission = useCallback(async (saved: ImageConversation, from: string | null, submittedDraft?: string) => {
    if (loadCancelledRef.current) return false;
    const follow = (selectedIdRef.current ?? draftIdRef.current) === (from ?? submittedDraft) || selectedIdRef.current === saved.id;
    if (follow) {
      const existing = conversationsRef.current.find(item => item.id === saved.id);
      const known = new Set(existing?.turns.map(turn => turn.id));
      const reused = saved.turns.some(turn => !known.has(turn.id) && (turn.sourceOrdinal ?? 1) > 1);
      keepReadingPositionRef.current = reused;
      const detail = existing?.pagination ? existing : saved;
      conversationsRef.current = sortImageConversations([...conversationsRef.current.filter((item) => item.id !== saved.id), detail]);
      setConversations(conversationsRef.current);
      selectedIdRef.current = saved.id;
      setSelectedConversationId(saved.id);
      shouldStickToBottomRef.current = !reused;
      if (submittedDraft && draftIdRef.current === submittedDraft) {
        draftIdRef.current = createId();
        setDraftId(draftIdRef.current);
      }
    }
    await refreshHistory(false);
    return follow && selectedIdRef.current === saved.id;
  }, [refreshHistory]);

  const loadConversation = useCallback(async (id: string, restorePosition = false, target?: ResultTarget) => {
    const visible = conversationsRef.current.find((item) => item.id === id);
    if (target && visible?.turns.some((turn) => turn.id === target.turn_id && !(turn.promptDeleted && turn.resultsDeleted)
      && (!target.image_id || turn.images.some((image) => image.id === target.image_id)))) {
      pendingTargetRef.current = target;
      setNavigationTarget({ ...target });
      return true;
    }
    const readVersion = ++historyReadVersionRef.current;
    pendingTargetRef.current = null;
    setNavigationTarget(null);
    scrollRestoreGenerationRef.current += 1;
    setIsLoadingPage(true);
    setLightboxOpen(false);
    setLightboxImages([]);
    try {
      const detail = await fetchImageConversation(authKey, id, target);
      if (loadCancelledRef.current || deletionRequestsRef.current || readVersion !== historyReadVersionRef.current) return;
      if (target) {
          pendingTargetRef.current = target;
        setNavigationTarget(target);
      }
      if (!restorePosition) {
        scrollPositionsRef.current.delete(id);
        saveScrollPositions(scrollPositionsRef.current);
        shouldStickToBottomRef.current = !target;
      }
      conversationsRef.current = sortImageConversations([
        ...conversationsRef.current.filter((item) => item.id !== id)
          .map((item) => ({ ...item, turns: [], pagination: undefined, sourceEntries: undefined })), detail,
      ]);
      setConversations(conversationsRef.current);
      if (!restorePosition && resultsViewportRef.current) resultsViewportRef.current.scrollTop = 0;
      return true;
    } catch (error) {
      if (loadCancelledRef.current || readVersion !== historyReadVersionRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "读取结果失败");
    } finally {
      if (readVersion === historyReadVersionRef.current) setIsLoadingPage(false);
    }
  }, [authKey]);

  useEffect(() => {
    if (selectedConversationId && !conversationsRef.current.find((item) => item.id === selectedConversationId)?.pagination) {
      void loadConversation(selectedConversationId, true);
    }
  }, [selectedConversationId, loadConversation]);

  const loadMoreHistory = async () => {
    if (historyNextOffset === null || isLoadingMoreHistory) return;
    setIsLoadingMoreHistory(true);
    const version = historyReadVersionRef.current;
    try {
      const history = await fetchImageHistory(authKey, historyNextOffset);
      if (loadCancelledRef.current || deletionRequestsRef.current || version !== historyReadVersionRef.current) return;
      const known = new Set(conversationsRef.current.map((item) => item.id));
      conversationsRef.current = sortImageConversations([...conversationsRef.current, ...history.items.filter((item) => !known.has(item.id))]);
      setConversations(conversationsRef.current);
      setHistoryNextOffset(history.pagination.next_offset);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "读取历史失败");
    } finally {
      setIsLoadingMoreHistory(false);
    }
  };

  useEffect(() => {
    if (isLoadingHistory) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState === "visible" && !isLoadingPage && !deletionRequestsRef.current) {
          const version = historyReadVersionRef.current;
          const selected = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
          const active = selected?.turns.flatMap((turn) => turn.images) ?? [];
          const [history, changes, metadata] = await Promise.all([
            fetchImageHistory(authKey),
            active.length ? fetchImageTasks(active.map((image) => image.id), authKey,
              Object.fromEntries(active.map((image) => [image.id, image.updatedAt ?? ""]))) : Promise.resolve({ items: [] }),
            selected ? fetchImageConversationMetadata(authKey, selected.id) : Promise.resolve(null),
          ]);
          if (cancelled || loadCancelledRef.current || deletionRequestsRef.current || version !== historyReadVersionRef.current) return;
          if (selected && !metadata || metadata && metadata.updatedAt !== selected?.updatedAt || history.pagination.total !== historyTotalRef.current || changes.items.some((task) => task.result_deleted)) {
            await refreshHistory(false);
          } else {
            const changed = new Map(changes.items.map((task) => [task.id, task]));
            const next = conversationsRef.current.map((conversation) => {
              const summary = metadata?.id === conversation.id ? metadata : history.items.find((item) => item.id === conversation.id);
              const turns = conversation.turns.map((turn) => {
                const errors = new Set<string>();
                const images = turn.images.map((image): StoredImage => {
                  const task = changed.get(image.id);
                  if (!task) return image;
                  if (task.status === "error") errors.add(task.error_code || "image_task_failed");
                  return { ...image, ...task.data?.[0], status: task.status === "queued" || task.status === "running" ? "loading" : task.status,
                    taskStatus: task.status === "queued" || task.status === "running" ? task.status : undefined,
                    updatedAt: task.updated_at, progress: task.progress, elapsedSecs: task.elapsed_secs, elapsedUpdatedAt: Date.now(),
                    durationMs: task.duration_ms, error: task.error, errorCode: task.error_code, errorDetail: task.error_detail,
                    canResume: task.can_resume, retryable: task.retryable, dispatchState: task.dispatch_state, waiting: task.waiting };
                });
                for (const code of errors) {
                  const failed = images.filter((image) => image.status === "error" && (image.errorCode || "image_task_failed") === code);
                  toast.error(`${failed.length} 张图片失败：${failed[0]?.error || "生成失败"}`, { id: `${turn.id}:${code}` });
                }
                return changed.size ? { ...turn, images, status: images.some((image) => image.status === "loading") ? "generating" as const : images.some((image) => image.status === "error") ? "error" as const : "success" as const } : turn;
              });
              return { ...conversation, ...(summary ? { stats: summary.stats } : {}), turns };
            });
            if (JSON.stringify(next) !== JSON.stringify(conversationsRef.current)) {
              conversationsRef.current = next;
              setConversations(next);
            }
            setActiveTaskCount(history.stats.queued + history.stats.running);
          }
        }
      } catch {
        // A later read can recover without resubmitting accepted work.
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [authKey, isLoadingHistory, isLoadingPage, refreshHistory]);

  const clearComposerInputs = useCallback(() => {
    setReuseSource(null);
    setImagePrompt("");
    releaseInputs(referenceImagesRef.current);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [releaseInputs, setReferenceImages]);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    ++historyReadVersionRef.current;
    ++scrollRestoreGenerationRef.current;
    const id = createId();
    draftIdRef.current = id;
    setDraftId(id);
    selectedIdRef.current = null;
    setSelectedConversationId(null);
    setIsLoadingPage(false);
    setIsHistoryOpen(false);
    setLightboxOpen(false);
    setLightboxImages([]);
    shouldStickToBottomRef.current = true;
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleSelectConversation = async (id: string) => {
    if (selectedConversationId && resultsViewportRef.current) {
      scrollPositionsRef.current.set(selectedConversationId, resultsViewportRef.current.scrollTop);
      saveScrollPositions(scrollPositionsRef.current);
    }
    if (id !== selectedConversationId) {
      isRestoringScrollRef.current = true;
      ++scrollRestoreGenerationRef.current;
    }
    ++historyReadVersionRef.current;
    setLightboxOpen(false);
    setLightboxImages([]);
    setIsLoadingPage(false);
    setSelectedConversationId(id);
    if (conversationsRef.current.find((item) => item.id === id)?.pagination) void loadConversation(id, true);
    try {
      await selectImageConversation(authKey, id);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "切换对话失败");
    }
  };

  const handleDeleteConversation = async (id: string) => {
    ++historyReadVersionRef.current;
    ++deletionRequestsRef.current;
    setLightboxOpen(false);
    setLightboxImages([]);
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      selectedIdRef.current = pickFallbackConversationId(nextConversations);
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
    }

    try {
      await deleteImageConversation(authKey, id);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
    } finally {
      --deletionRequestsRef.current;
      ++historyReadVersionRef.current;
      if (!loadCancelledRef.current) await refreshHistory(false);
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    ++historyReadVersionRef.current;
    ++deletionRequestsRef.current;
    if (part === "results") {
      setLightboxOpen(false);
      setLightboxImages([]);
    }
    conversationsRef.current = conversationsRef.current.map((conversation) => conversation.id !== conversationId ? conversation : {
      ...conversation, turns: conversation.turns.map((turn) => turn.id !== turnId ? turn : {
        ...turn, ...(part === "prompt" ? { promptDeleted: true, prompt: "" } : { resultsDeleted: true, images: [] }),
      }),
    });
    setConversations(conversationsRef.current);
    try {
      await updateTurnVisibility(authKey, conversationId, turnId, part === "prompt" ? { promptDeleted: true } : { resultsDeleted: true });
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "更新记录失败");
    } finally {
      --deletionRequestsRef.current;
      ++historyReadVersionRef.current;
      if (!loadCancelledRef.current) await refreshHistory(false);
    }
  };

  const handleClearHistory = async () => {
    ++historyReadVersionRef.current;
    ++deletionRequestsRef.current;
    selectedIdRef.current = null;
    conversationsRef.current = [];
    setConversations([]);
    setSelectedConversationId(null);
    setLightboxOpen(false);
    setLightboxImages([]);
    try {
      await clearImageConversations(authKey);
      ++historyReadVersionRef.current;
      scrollPositionsRef.current.clear();
      saveScrollPositions(scrollPositionsRef.current);
      setHistoryNextOffset(null);
      setActiveTaskCount(0);
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      toast.success("已删除当前身份的历史，文件正在后台清理");
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    } finally {
      --deletionRequestsRef.current;
      ++historyReadVersionRef.current;
      if (!loadCancelledRef.current) await refreshHistory(false);
    }
  };

  const handleRenameConversation = async (id: string, title: string) => {
    const nextConversations = conversations.map((item) =>
      item.id === id ? { ...item, title, updatedAt: new Date().toISOString() } : item,
    );
    conversationsRef.current = sortImageConversations(nextConversations);
    setConversations(conversationsRef.current);
    try {
      await renameImageConversation(authKey, id, title);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "重命名失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openDeletePromptConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "prompt", conversationId, turnId });
  };

  const openDeleteResultsConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "results", conversationId, turnId });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleDeleteImage = async (conversationId: string, turnId: string, imageId: string, ordinal: number) => {
    ++historyReadVersionRef.current;
    setDeletedResults((current) => ({ ...current, [imageId]: { id: imageId, ordinal, state: "pending" } }));
    const remaining = lightboxImages.filter((image) => image.id !== imageId);
    setLightboxImages(remaining);
    setLightboxIndex((index) => Math.max(0, Math.min(index, remaining.length - 1)));
    if (!remaining.length) setLightboxOpen(false);
    try {
      await deleteImageResult(authKey, conversationId, turnId, imageId);
      if (!loadCancelledRef.current) await refreshHistory(false);
    } catch (error) {
      if (loadCancelledRef.current) return;
      const message = error instanceof Error ? error.message : "删除未能确认，请重试";
      setDeletedResults((current) => ({ ...current, [imageId]: { id: imageId, ordinal, state: "error", error: message } }));
    }
  };

  const hasPendingResultCleanup = selectedConversation?.turns.some((turn) => turn.resultCleanups?.some((item) => item.state === "pending"));
  useEffect(() => {
    if (!hasPendingResultCleanup) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { await refreshHistory(false); } catch { /* The visible retry action remains available. */ }
      if (!cancelled) timer = setTimeout(refresh, 1500);
    };
    timer = setTimeout(refresh, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hasPendingResultCleanup, refreshHistory]);

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    if (target.type === "image") {
      await handleDeleteImage(target.conversationId, target.turnId, target.imageId, target.ordinal);
      return;
    }
    if (target.type === "prompt" || target.type === "results") {
      await handleDeleteTurnPart(target.conversationId, target.turnId, target.type);
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const uploadDraftReference = useCallback(async (draft: DraftReferenceImage) => {
    if (!draft.file) {
      toast.error("请移除未完成的上传并重新选择文件");
      return;
    }
    setReferenceImages((current) => current.map((image) => image.id === draft.id ? { ...image, uploading: true, error: undefined } : image));
    try {
      const saved = await uploadReferenceImage(authKey, draft.file, draft.id, (progress) => {
        setReferenceImages((current) => current.map((image) => image.id === draft.id && !image.releasing ? { ...image, progress } : image));
      });
      setReferenceImages((current) => current.map((image) => image.id === draft.id && !image.releasing ? saved : image));
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "上传参考图失败";
      if (!referenceImagesRef.current.some((image) => image.id === draft.id && !image.releasing)) return;
      setReferenceImages((current) => current.map((image) => image.id === draft.id && !image.releasing ? { ...image, uploading: false, error: message } : image));
      toast.error(message);
    }
  }, [authKey, setReferenceImages]);

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (loadCancelledRef.current) return;
    try { await identityAuth(authKey); } catch { return; }
    if (loadCancelledRef.current) return;
    const drafts = files.map((file) => ({ id: createId(), name: file.name, type: file.type,
      size: file.size, url: URL.createObjectURL(file), file, uploading: true }));
    setReferenceImages((current) => [...current, ...drafts]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    for (const draft of drafts) {
      if (referenceImagesRef.current.some((image) => image.id === draft.id)) await uploadDraftReference(draft);
    }
  }, [setReferenceImages, uploadDraftReference]);

  const handleReferenceImageChange = appendReferenceImages;

  const handleRemoveReferenceImage = useCallback((index: number) => {
    const image = referenceImagesRef.current[index];
    if (image) releaseInputs([image]);
    setReferenceImages((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }, [releaseInputs, setReferenceImages]);

  const handleContinueEdit = useCallback(async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
    try {
      setReuseSource(null);
      setSelectedConversationId(conversationId);
      if ("name" in image) {
        const retained = await retainReferenceImage(authKey, image.id);
        setReferenceImages((current) => current.some((item) => item.id === retained.id)
          ? current.map((item) => item.id === retained.id ? retained : item) : [...current, retained]);
      } else {
        const source = image.b64_json ? `data:image/png;base64,${image.b64_json}` : image.url;
        if (!source) return;
        await appendReferenceImages([await fetchImageAsFile(authKey, source, `conversation-${conversationId}-${Date.now()}.png`)]);
      }
      setImagePrompt("");
      textareaRef.current?.focus();
      toast.success("已加入当前参考图，继续输入描述即可编辑");
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "读取结果图失败");
    }
  }, [appendReferenceImages, setReferenceImages]);

  const handleReuseTurnConfig = useCallback(async (conversationId: string, turnId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const turn = conversation?.turns.find((item) => item.id === turnId);
    if (!conversation || !turn || !turn.prompt.trim()) {
      return;
    }

    if (reusingRef.current) return;
    reusingRef.current = true;
    const previousInputs = referenceImagesRef.current;
    const previousConversation = selectedIdRef.current;
    try {
      const results = await Promise.allSettled(turn.referenceImages.map((image) => retainReferenceImage(authKey, image.id)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed || loadCancelledRef.current || previousInputs !== referenceImagesRef.current || previousConversation !== selectedIdRef.current) {
        // Release every newly attempted hold, including a retain whose response was lost.
        releaseInputs(turn.referenceImages.filter((image) => !referenceImagesRef.current.some((item) => item.id === image.id)));
        if (failed?.status === "rejected") throw failed.reason;
        return;
      }
      const retained = results.map((result) => (result as PromiseFulfilledResult<StoredReferenceImage>).value);
      releaseInputs(previousInputs.filter((image) => !retained.some((item) => item.id === image.id)));
      setReferenceImages(retained);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "恢复参考图失败");
      return;
    } finally {
      reusingRef.current = false;
    }
    setSelectedConversationId(conversationId);
    setReuseSource({ conversationId, turnId });
    setImagePrompt(turn.prompt);
    handleImageCountChange(String(Math.max(1, turn.count || turn.images.length || 1)));
    setImageRatio(turn.ratio);
    setImageTier(turn.tier);
    const parsedSize = parseImageSize(turn.size);
    setImageWidth(parsedSize.width);
    setImageHeight(parsedSize.height);
    setImageQuality(turn.quality);
    setImageModel(turn.model);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, [authKey, handleImageCountChange, releaseInputs, setReferenceImages]);

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  const handleRegenerateTurn = useCallback(async (conversationId: string, turnId: string, count?: number, imageId?: string) => {
    const source = conversationsRef.current.find((item) => item.id === conversationId)?.turns.find((turn) => turn.id === turnId);
    if (!source || !source.prompt.trim()) return;
    if (parseImageCount(String(count ?? source.count)) === null) {
      toast.error("生成数量必须为 1–100 的纯数字整数");
      return;
    }
    const key = JSON.stringify([conversationId, turnId, count, imageId]);
    const pending = pendingRegenerationsRef.current.get(key) ?? { ...source, id: createId(), count: count ?? source.count, sourceTurnId: source.id, rerun: true };
    pendingRegenerationsRef.current.set(key, pending);
    try {
      await submitImageTurn(authKey, pending, conversationId);
      keepReadingPositionRef.current = true;
      shouldStickToBottomRef.current = false;
      await refreshHistory(false);
      if (pendingRegenerationsRef.current.get(key) === pending) pendingRegenerationsRef.current.delete(key);
      toast.success("已保存新轮次并开始处理");
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "提交失败");
    }
  }, [authKey, refreshHistory]);

  const handleRetryImage = useCallback(async (conversationId: string, turnId: string, imageId: string) => {
    await handleRegenerateTurn(conversationId, turnId, 1, imageId);
  }, [handleRegenerateTurn]);

  const handleTimeoutRetryContinue = useCallback(async (taskId: string) => {
    try {
      await resumeImagePoll(taskId, imageTimeoutRetrySecs, authKey);
      await refreshHistory();
      toast.info(`已继续等待 ${imageTimeoutRetrySecs} 秒`);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "续轮询失败");
    }
  }, [refreshHistory, imageTimeoutRetrySecs]);

  const handleDismissErrors = useCallback(async (conversationId: string, turnId: string) => {
    const turn = conversationsRef.current.find((item) => item.id === conversationId)?.turns.find((turn) => turn.id === turnId);
    if (!turn) return;
    try {
      await updateTurnVisibility(authKey, conversationId, turnId, { dismissedImageIds: turn.images.filter((image) => image.status === "error").map((image) => image.id) });
      await refreshHistory();
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "更新记录失败");
    }
  }, [authKey, refreshHistory]);

  const handleSubmit = async () => {
    if (parsedCount === null) {
      toast.error("生成数量必须为 1–100 的纯数字整数");
      return;
    }
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    if (referenceImages.some((image) => image.file || image.error)) {
      toast.error("请等待参考图上传完成，失败的图片请重试或移除");
      return;
    }
    const effectiveImageMode: ImageConversationMode = referenceImages.length > 0 ? "edit" : "generate";

    const conversationId = selectedConversationId;
    const draftTurn: ImageTurn = {
      id: createId(), prompt, model: imageModel, mode: effectiveImageMode,
      sourceTurnId: reuseSource?.conversationId === conversationId ? reuseSource.turnId : undefined,
      referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
      count: parsedCount, size: `${imageWidth || 1024}x${imageHeight || 1024}`,
      ratio: imageRatio, tier: imageTier, quality: imageQuality,
      images: [], createdAt: "", status: "queued",
    };
    const submissionDraftId = conversationId ? undefined : draftIdRef.current;
    const signature = JSON.stringify({ ...draftTurn, id: "", conversationId, draftId: submissionDraftId });
    if (pendingSubmissionRef.current?.signature !== signature) {
      pendingSubmissionRef.current = { signature, turn: draftTurn, conversationId, draftId: submissionDraftId };
    }
    const pending = pendingSubmissionRef.current;
    for (const image of pending.turn.referenceImages) {
      activeSubmissionReferences.current.set(image.id, (activeSubmissionReferences.current.get(image.id) ?? 0) + 1);
    }
    try {
      const saved = await submitImageTurn(authKey, pending.turn, pending.conversationId, pending.draftId);
      const follow = await acceptSubmission(saved, pending.conversationId, pending.draftId);
      if (pendingSubmissionRef.current === pending) pendingSubmissionRef.current = null;
      if (!follow || selectedIdRef.current !== saved.id) return;
      setImagePrompt((current) => current.trim() === prompt ? "" : current);
      // Remove only the submitted references; files added while submitting stay in the composer.
      const submittedIds = new Set(referenceImages.map((image) => image.id));
      setReferenceImages((current) => current.filter((image) => !submittedIds.has(image.id)));
      if (pendingSubmissionRef.current === pending) pendingSubmissionRef.current = null;
      setReuseSource((current) => current === reuseSource ? null : current);
      releaseInputs(referenceImages);
      toast.success("已保存并提交生成");
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "保存并提交失败");
    } finally {
      for (const image of pending.turn.referenceImages) {
        const remaining = (activeSubmissionReferences.current.get(image.id) ?? 1) - 1;
        if (remaining) activeSubmissionReferences.current.set(image.id, remaining);
        else {
          activeSubmissionReferences.current.delete(image.id);
          const released = deferredReleases.current.get(image.id);
          deferredReleases.current.delete(image.id);
          if (released && !referenceImagesRef.current.some((item) => item.id === image.id)) releaseInputs([released]);
        }
      }
    }
  };

  return (
    <>
      <ImageImportDialog open={isImportsOpen} onOpenChange={setIsImportsOpen} authKey={authKey}
        conversationId={selectedConversationId} draftId={selectedConversationId ? undefined : draftId} model={imageModel} quality={imageQuality}
        count={imageCount} onCountChange={handleImageCountChange}
        onAccepted={async (saved, submittedFrom, submittedDraft) => { await acceptSubmission(saved, submittedFrom, submittedDraft); }} />
      <section className="mx-auto grid h-[calc(100dvh-6.5rem)] min-h-0 w-full max-w-[1600px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5.25rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_208px]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            hasMore={historyNextOffset !== null}
            isLoadingMore={isLoadingMoreHistory}
            onLoadMore={() => void loadMoreHistory()}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={(id) => void handleSelectConversation(id)}
            onDeleteConversation={openDeleteConversationConfirm}
            onRenameConversation={handleRenameConversation}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
                conversations={conversations}
                hasMore={historyNextOffset !== null}
                isLoadingMore={isLoadingMoreHistory}
                onLoadMore={() => void loadMoreHistory()}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  void handleSelectConversation(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                onRenameConversation={handleRenameConversation}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="image-workspace flex min-h-0 flex-col gap-2 sm:gap-4">
          <div className="flex shrink-0 items-center justify-end gap-2">
            <ImageCleanups authKey={authKey} />
          </div>
          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-2xl border-stone-200 bg-white/90 text-stone-700 shadow-sm"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-2 size-4" />
              历史记录 ({conversations.length})
            </Button>
            <Button
              className="h-10 rounded-2xl bg-stone-950 text-white shadow-sm"
              onClick={handleCreateDraft}
            >
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-2xl border-stone-200 bg-white/85 px-3 text-stone-600 shadow-sm"
              onClick={openClearHistoryConfirm}
              aria-label="清空当前身份全部历史"
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          {selectedConversation && (
            <div className={cn("flex items-center justify-center gap-2 text-xs text-stone-500", !isLoadingPage && "xl:hidden")}>
              <Button variant="outline" size="sm" className="xl:hidden" onClick={() => setIsNavigationOpen(true)}><ListTree className="size-4" />定位</Button>
              {isLoadingPage && <LoaderCircle className="size-4 animate-spin" />}
            </div>
          )}
          <div className="image-result-panel relative min-h-0 flex-1">
            <div
              ref={resultsViewportRef}
              onScroll={handleResultsScroll}
              className="hide-scrollbar h-full overscroll-contain overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
              style={{ contain: "layout style paint", overflowAnchor: "none" }}
            >
              <ImageResults
                key={selectedConversation?.id}
                selectedConversation={selectedConversation}
                imageDimensions={imageDimensionsRef.current}
                onOpenLightbox={openLightbox}
                onContinueEdit={handleContinueEdit}
                onDeletePrompt={openDeletePromptConfirm}
                onDeleteResults={openDeleteResultsConfirm}
                onDeleteImage={(conversationId, turnId, imageId, ordinal) => setDeleteConfirm({ type: "image", conversationId, turnId, imageId, ordinal })}
                onRetryDeleteImage={handleDeleteImage}
                onReuseTurnConfig={handleReuseTurnConfig}
                onRegenerateTurn={handleRegenerateTurn}
                onRetryImage={handleRetryImage}
                onTimeoutRetryContinue={handleTimeoutRetryContinue}
                onDismissErrors={handleDismissErrors}
                formatConversationTime={formatConversationTime}
              />
            </div>

            <button
              ref={scrollToLatestBtnRef}
              type="button"
              aria-label="滚动到最新消息"
              title="滚动到最新消息"
              onClick={() => scrollResultsToLatest("smooth")}
              className="absolute bottom-4 left-1/2 z-20 inline-flex size-11 -translate-x-1/2 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-700 shadow-lg shadow-stone-200/60 backdrop-blur transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:border-white/10 dark:bg-stone-800/95 dark:text-stone-100 dark:shadow-black/40 dark:hover:bg-stone-700"
              style={{ display: "none" }}
            >
              <ArrowDown className="size-5" />
            </button>
          </div>

          {reuseSource && reuseSource.conversationId === selectedConversationId && (
            <div className="flex items-center justify-center gap-3 py-1 text-xs text-stone-500">
              <span>提交将新增原条目的轮次</span>
              <button type="button" className="underline" onClick={() => setReuseSource(null)}>改为新条目</button>
            </div>
          )}
          <ImageComposer
            prompt={imagePrompt}
            imageCount={imageCount}
            isImageCountValid={parsedCount !== null}
            imageRatio={imageRatio}
            imageTier={imageTier}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            imageQuality={imageQuality}
            imageModel={imageModel}
            imageModels={imageModels}
            availableQuota={availableQuota}
            activeTaskCount={activeTaskCount}
            referenceImages={referenceImages}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onPromptChange={setImagePrompt}
            onImageCountChange={handleImageCountChange}
            onImageRatioChange={setImageRatio}
            onImageTierChange={setImageTier}
            onImageWidthChange={setImageWidth}
            onImageHeightChange={setImageHeight}
            onImageQualityChange={setImageQuality}
            onImageModelChange={setImageModel}
            onSubmit={handleSubmit}
            onPickReferenceImage={() => fileInputRef.current?.click()}
            onOpenImports={() => setIsImportsOpen(true)}
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
            onRetryReferenceImage={(index) => void uploadDraftReference(referenceImagesRef.current[index])}
          />
        </div>
        <ImageNavigation authKey={authKey} conversation={selectedConversation} viewport={resultsViewportRef}
          open={isNavigationOpen} onOpenChange={setIsNavigationOpen}
          onLocate={async (target) => !!selectedConversationId && (await loadConversation(selectedConversationId, false, target)) === true} />
      </section>

      <ImageLightbox
        images={lightboxImages}
        roundImages={lightboxImages[lightboxIndex]?.turnId ? selectedConversation?.turns
          .filter(turn => turn.id === lightboxImages[lightboxIndex].turnId && !turn.resultsDeleted)
          .flatMap(turn => turn.images.flatMap((image, index) => image.status === "success" && getStoredImageSrc(image)
            ? [{ id: image.id, src: getStoredImageSrc(image), filename: resultFilename(turn, image, index) }] : [])) : undefined}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={(open) => {
          if (!open && deleteConfirm?.type === "image") setDeleteConfirm(null);
          else setLightboxOpen(open);
        }}
        onIndexChange={setLightboxIndex}
        onDelete={lightboxImages[lightboxIndex]?.turnId ? () => {
          const image = lightboxImages[lightboxIndex];
          setDeleteConfirm({ type: "image", conversationId: image.conversationId!, turnId: image.turnId!, imageId: image.id, ordinal: image.ordinal! });
        } : undefined}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6" onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void handleConfirmDelete(); }
          }}>
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}


    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent key={session.subjectId} isAdmin={session.role === "admin"} authKey={session.key} />;
}
