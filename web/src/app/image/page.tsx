"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageImportDialog } from "@/app/image/components/image-import-dialog";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
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
  createImageConversation,
  fetchImageHistory,
  fetchImageConversation,
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
const SCROLL_POSITIONS_STORAGE_KEY = "chatgpt2api:image_scroll_positions";
const PAGE_OFFSETS_STORAGE_KEY = "chatgpt2api:image_page_offsets";
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


function getResultsDistanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
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
  const selectedIdRef = useRef<string | null>(null);
  const pageOffsetRef = useRef<number | undefined>(undefined);
  const pageOffsetsRef = useRef<Map<string, number>>(loadScrollPositions(PAGE_OFFSETS_STORAGE_KEY));
  const firstPageIdsRef = useRef(new Set<string>());
  const historyTotalRef = useRef(0);
  const pendingSubmissionRef = useRef<{ signature: string; turn: ImageTurn; conversationId: string | null } | null>(null);
  const pendingDraftRef = useRef<string | null>(null);
  const pendingRegenerationsRef = useRef(new Map<string, ImageTurn>());
  const loadCancelledRef = useRef(false);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const lastConversationIdRef = useRef<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollPositionsRef = useRef<Map<string, number>>(loadScrollPositions());
  const isRestoringScrollRef = useRef(false);
  const scrollRestoreGenerationRef = useRef(0);

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
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "prompt"
        ? "确认删除这条提示词记录吗？对应生成结果会保留。"
        : deleteConfirm?.type === "results"
          ? "确认删除这条生成结果吗？对应提示词记录会保留。"
          : deleteConfirm?.type === "one"
            ? "确认删除这条图片对话吗？删除后无法恢复。"
            : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const scrollResultsToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    shouldStickToBottomRef.current = true;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
  }, []);

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

      const isAwayFromLatest = getResultsDistanceFromBottom(element) > SCROLL_TO_LATEST_THRESHOLD;
      shouldStickToBottomRef.current = !isAwayFromLatest;
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
  }, []);

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
      const offset = nextSelectedConversationId ? pageOffsetsRef.current.get(nextSelectedConversationId) : undefined;
      const detail = nextSelectedConversationId ? await fetchImageConversation(authKey, nextSelectedConversationId, { offset }) : null;
      const normalizedItems = detail ? [...history.items.filter((item) => item.id !== detail.id), detail] : history.items;
      if (loadCancelledRef.current || readVersion !== historyReadVersionRef.current) {
        return;
      }

      conversationsRef.current = sortImageConversations(normalizedItems);
      setConversations(conversationsRef.current);
      setHistoryNextOffset(history.pagination.next_offset);
      setActiveTaskCount(history.stats.queued + history.stats.running);
      firstPageIdsRef.current = new Set(history.items.map((item) => item.id));
      historyTotalRef.current = history.pagination.total;
      pageOffsetRef.current = offset;
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

  // 恢复滚动位置或跟随最新内容
  useEffect(() => {
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
          const isAwayFromLatest = getResultsDistanceFromBottom(element) > SCROLL_TO_LATEST_THRESHOLD;
          shouldStickToBottomRef.current = !isAwayFromLatest;
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
    const shouldFollowLatest =
      shouldStickToBottomRef.current ||
      getResultsDistanceFromBottom(element) <= SCROLL_TO_LATEST_THRESHOLD;

    if (shouldFollowLatest) {
      requestAnimationFrame(() => scrollResultsToLatest("smooth"));
      return;
    }

    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "";
  }, [selectedConversation?.id, selectedConversation?.updatedAt, selectedConversation?.turns.length, selectedConversation?.pagination?.offset, scrollResultsToLatest]);

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
    const id = (followLatest ? history.current_conversation_id : selectedIdRef.current) ?? history.current_conversation_id;
    const offset = followLatest ? undefined : pageOffsetRef.current;
    const detail = id ? await fetchImageConversation(authKey, id, { offset }) : null;
    if (!loadCancelledRef.current && readVersion === historyReadVersionRef.current) {
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
      if (followLatest) {
        pageOffsetRef.current = undefined;
        if (id) {
          pageOffsetsRef.current.delete(id);
          scrollPositionsRef.current.delete(id);
          saveScrollPositions(pageOffsetsRef.current, PAGE_OFFSETS_STORAGE_KEY);
        }
        setSelectedConversationId(id);
      }
      setActiveTaskCount(history.stats.queued + history.stats.running);
      setIsLoadingPage(false);
      if (firstPageChanged || history.pagination.next_offset === null) setHistoryNextOffset(history.pagination.next_offset);
    }
    return history;
  }, [authKey]);

  const loadConversationPage = useCallback(async (id: string, offset?: number, restorePosition = false) => {
    const readVersion = ++historyReadVersionRef.current;
    pageOffsetRef.current = offset;
    setIsLoadingPage(true);
    setLightboxOpen(false);
    setLightboxImages([]);
    try {
      const detail = await fetchImageConversation(authKey, id, { offset });
      if (loadCancelledRef.current || readVersion !== historyReadVersionRef.current) return;
      if (offset === undefined) pageOffsetsRef.current.delete(id);
      else pageOffsetsRef.current.set(id, offset);
      saveScrollPositions(pageOffsetsRef.current, PAGE_OFFSETS_STORAGE_KEY);
      if (!restorePosition) {
        scrollPositionsRef.current.delete(id);
        saveScrollPositions(scrollPositionsRef.current);
        shouldStickToBottomRef.current = offset === undefined;
      }
      conversationsRef.current = sortImageConversations([
        ...conversationsRef.current.filter((item) => item.id !== id)
          .map((item) => ({ ...item, turns: [], pagination: undefined, sourceEntries: undefined })), detail,
      ]);
      setConversations(conversationsRef.current);
      if (!restorePosition && resultsViewportRef.current) resultsViewportRef.current.scrollTop = 0;
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "读取结果失败");
    } finally {
      if (readVersion === historyReadVersionRef.current) setIsLoadingPage(false);
    }
  }, [authKey]);

  useEffect(() => {
    if (selectedConversationId && !conversationsRef.current.find((item) => item.id === selectedConversationId)?.pagination) {
      void loadConversationPage(selectedConversationId, pageOffsetsRef.current.get(selectedConversationId), true);
    }
  }, [selectedConversationId, loadConversationPage]);

  const loadMoreHistory = async () => {
    if (historyNextOffset === null || isLoadingMoreHistory) return;
    setIsLoadingMoreHistory(true);
    const version = historyReadVersionRef.current;
    try {
      const history = await fetchImageHistory(authKey, historyNextOffset);
      if (loadCancelledRef.current || version !== historyReadVersionRef.current) return;
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
        if (document.visibilityState === "visible" && !isLoadingPage) {
          const version = historyReadVersionRef.current;
          const selected = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
          const active = selected?.turns.flatMap((turn) => turn.images) ?? [];
          const [history, changes, metadata] = await Promise.all([
            fetchImageHistory(authKey),
            active.length ? fetchImageTasks(active.map((image) => image.id), authKey,
              Object.fromEntries(active.map((image) => [image.id, image.updatedAt ?? ""]))) : Promise.resolve({ items: [] }),
            selected ? fetchImageConversationMetadata(authKey, selected.id) : Promise.resolve(null),
          ]);
          if (cancelled || loadCancelledRef.current || version !== historyReadVersionRef.current) return;
          if (metadata && metadata.updatedAt !== selected?.updatedAt || history.pagination.total !== historyTotalRef.current || changes.items.some((task) => task.result_deleted)) {
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

  const handleCreateDraft = async () => {
    const requestId = pendingDraftRef.current ?? createId();
    pendingDraftRef.current = requestId;
    try {
      const conversation = await createImageConversation(authKey, requestId);
      await refreshHistory();
      setSelectedConversationId(conversation.id);
      if (pendingDraftRef.current === requestId) pendingDraftRef.current = null;
      shouldStickToBottomRef.current = true;
      resetComposer();
      textareaRef.current?.focus();
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "新建对话失败");
    }
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
    pageOffsetRef.current = pageOffsetsRef.current.get(id);
    setLightboxOpen(false);
    setLightboxImages([]);
    setIsLoadingPage(false);
    setSelectedConversationId(id);
    if (conversationsRef.current.find((item) => item.id === id)?.pagination) void loadConversationPage(id, pageOffsetRef.current, true);
    try {
      await selectImageConversation(authKey, id);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "切换对话失败");
    }
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(authKey, id);
      await refreshHistory(false);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      await refreshHistory(false);
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    try {
      await updateTurnVisibility(authKey, conversationId, turnId, part === "prompt" ? { promptDeleted: true } : { resultsDeleted: true });
      await refreshHistory(false);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "更新记录失败");
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations(authKey);
      ++historyReadVersionRef.current;
      pageOffsetsRef.current.clear();
      scrollPositionsRef.current.clear();
      saveScrollPositions(pageOffsetsRef.current, PAGE_OFFSETS_STORAGE_KEY);
      saveScrollPositions(scrollPositionsRef.current);
      setHistoryNextOffset(null);
      setActiveTaskCount(0);
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
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

    setSelectedConversationId(conversationId);
    setImagePrompt(turn.prompt);
    handleImageCountChange(String(Math.max(1, turn.count || turn.images.length || 1)));
    setImageRatio(turn.ratio);
    setImageTier(turn.tier);
    const parsedSize = parseImageSize(turn.size);
    setImageWidth(parsedSize.width);
    setImageHeight(parsedSize.height);
    setImageQuality(turn.quality);
    setImageModel(turn.model);
    try {
      const retained = await Promise.all(turn.referenceImages.map((image) => retainReferenceImage(authKey, image.id)));
      releaseInputs(referenceImagesRef.current.filter((image) => !retained.some((item) => item.id === image.id)));
      setReferenceImages(retained);
    } catch (error) {
      if (loadCancelledRef.current || error instanceof IdentityChanged) return;
      toast.error(error instanceof Error ? error.message : "恢复参考图失败");
      return;
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, [handleImageCountChange, releaseInputs, setReferenceImages]);

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
    const key = JSON.stringify([conversationId, turnId, count, imageId]);
    const pending = pendingRegenerationsRef.current.get(key) ?? { ...source, id: createId(), count: count ?? source.count };
    pendingRegenerationsRef.current.set(key, pending);
    try {
      await submitImageTurn(authKey, pending, conversationId);
      await refreshHistory();
      setSelectedConversationId(conversationId);
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
      referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
      count: parsedCount, size: `${imageWidth || 1024}x${imageHeight || 1024}`,
      ratio: imageRatio, tier: imageTier, quality: imageQuality,
      images: [], createdAt: "", status: "queued",
    };
    const signature = JSON.stringify({ ...draftTurn, id: "", conversationId });
    if (pendingSubmissionRef.current?.signature !== signature) {
      pendingSubmissionRef.current = { signature, turn: draftTurn, conversationId };
    }
    const pending = pendingSubmissionRef.current;
    for (const image of pending.turn.referenceImages) {
      activeSubmissionReferences.current.set(image.id, (activeSubmissionReferences.current.get(image.id) ?? 0) + 1);
    }
    try {
      const saved = await submitImageTurn(authKey, pending.turn, pending.conversationId);
      await refreshHistory();
      setSelectedConversationId(saved.id);
      shouldStickToBottomRef.current = true;
      setImagePrompt((current) => current.trim() === prompt ? "" : current);
      // Remove only the submitted references; files added while submitting stay in the composer.
      const submittedIds = new Set(referenceImages.map((image) => image.id));
      setReferenceImages((current) => current.filter((image) => !submittedIds.has(image.id)));
      if (pendingSubmissionRef.current === pending) pendingSubmissionRef.current = null;
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
        conversationId={selectedConversationId} model={imageModel} quality={imageQuality}
        count={imageCount} onCountChange={handleImageCountChange}
        onAccepted={async (id, submittedFrom) => {
          const follow = selectedIdRef.current === submittedFrom;
          await refreshHistory(follow);
          if (follow && !loadCancelledRef.current) setSelectedConversationId(id);
        }} />
      <section className="mx-auto grid h-[calc(100dvh-6.5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5.25rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
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

        <div className="flex min-h-0 flex-col gap-2 sm:gap-4">
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
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          {selectedConversation?.pagination && selectedConversation.pagination.total > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-stone-500" aria-label="结果分页">
              <Button variant="ghost" size="sm" disabled={isLoadingPage || selectedConversation.pagination.previous_offset === null}
                onClick={() => void loadConversationPage(selectedConversation.id, selectedConversation.pagination!.previous_offset!)}>较早结果</Button>
              <span>第 {selectedConversation.pagination.offset + 1}–{Math.min(selectedConversation.pagination.total, selectedConversation.pagination.offset + selectedConversation.pagination.limit)} / {selectedConversation.pagination.total} 轮</span>
              <Button variant="ghost" size="sm" disabled={isLoadingPage || selectedConversation.pagination.next_offset === null}
                onClick={() => void loadConversationPage(selectedConversation.id, selectedConversation.pagination!.next_offset!)}>较新结果</Button>
              <Button variant="ghost" size="sm" disabled={isLoadingPage || pageOffsetRef.current === undefined}
                onClick={() => void loadConversationPage(selectedConversation.id)}>最新结果</Button>
              {isLoadingPage && <LoaderCircle className="size-4 animate-spin" />}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <div
              ref={resultsViewportRef}
              onScroll={handleResultsScroll}
              className="hide-scrollbar h-full overscroll-contain overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
              style={{ contain: "layout style paint" }}
            >
              <ImageResults
                key={`${selectedConversation?.id}:${selectedConversation?.pagination?.offset}`}
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
      </section>

      <ImageLightbox
        images={lightboxImages}
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
