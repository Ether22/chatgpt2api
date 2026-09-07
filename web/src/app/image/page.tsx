"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
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
  fetchModels,
  resumeImagePoll,
  type Account,
  type ImageModel,
  type Model,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useSettingsStore } from "@/app/settings/store";
import {
  clearImageConversations,
  createImageConversation,
  fetchImageHistory,
  fetchStoredImageBlob,
  selectImageConversation,
  submitImageTurn,
  updateTurnVisibility,
  deleteImageConversation,
  getImageConversationStats,
  listImageConversations,
  renameImageConversation,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const IMAGE_RATIO_STORAGE_KEY = "chatgpt2api:image_last_ratio";
const IMAGE_TIER_STORAGE_KEY = "chatgpt2api:image_last_tier";
const IMAGE_QUALITY_STORAGE_KEY = "chatgpt2api:image_last_quality";
const IMAGE_MODEL_STORAGE_KEY = "chatgpt2api:image_last_model";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const SCROLL_POSITIONS_STORAGE_KEY = "chatgpt2api:image_scroll_positions";
const SCROLL_TO_LATEST_THRESHOLD = 160;

function loadScrollPositions(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveScrollPositions(positions: Map<string, number>) {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, number> = {};
    positions.forEach((value, key) => { obj[key] = value; });
    window.sessionStorage.setItem(SCROLL_POSITIONS_STORAGE_KEY, JSON.stringify(obj));
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

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status === "正常" && account.usage_mode === "normal");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
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

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const blob = await fetchStoredImageBlob(url);
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function ImagePageContent({ isAdmin }: { isAdmin: boolean }) {
  const didLoadQuotaRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const historyReadVersionRef = useRef(0);
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
  const [imageCount, setImageCount] = useState("4");
  const [imageRatio, setImageRatio] = useState("auto");
  const [imageTier, setImageTier] = useState("1k");
  const [imageWidth, setImageWidth] = useState("1024");
  const [imageHeight, setImageHeight] = useState("1024");
  const [imageQuality, setImageQuality] = useState("auto");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-2");
  const [imageModels, setImageModels] = useState<ImageModel[]>(["gpt-image-2"]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [availableQuota, setAvailableQuota] = useState("加载中...");
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const scrollToLatestBtnRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "one"; id: string }
    | { type: "prompt"; conversationId: string; turnId: string }
    | { type: "results"; conversationId: string; turnId: string }
    | { type: "all" }
    | null
  >(null);
  const parsedCount = parseImageCount(imageCount);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle =
    deleteConfirm?.type === "all"
      ? "清空历史记录"
      : deleteConfirm?.type === "prompt"
        ? "删除提示词记录"
        : deleteConfirm?.type === "results"
          ? "删除生成结果"
          : deleteConfirm?.type === "one"
            ? "删除对话"
            : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
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
      if (isRestoringScrollRef.current) {
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
      const history = await fetchImageHistory();
      const normalizedItems = history.items;
      if (loadCancelledRef.current || readVersion !== historyReadVersionRef.current) {
        return;
      }

      conversationsRef.current = normalizedItems;
      setConversations(normalizedItems);
      const nextSelectedConversationId = history.current_conversation_id ?? pickFallbackConversationId(normalizedItems);
      setSelectedConversationId(nextSelectedConversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取会话记录失败";
      toast.error(message);
    } finally {
      if (!loadCancelledRef.current) {
        setIsLoadingHistory(false);
      }
    }
  }, [
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

    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    const didSwitchConversation = lastConversationIdRef.current !== selectedConversation.id;

    if (didSwitchConversation) {
      // 递增 generation，使之前未完成的 rAF 回调失效
      scrollRestoreGenerationRef.current += 1;

      // 先保存旧会话的滚动位置（lastConversationIdRef 还是旧值）
      const oldConvId = lastConversationIdRef.current;
      if (oldConvId) {
        scrollPositionsRef.current.set(oldConvId, element.scrollTop);
        saveScrollPositions(scrollPositionsRef.current);
      }
      // 更新为新会话 ID
      lastConversationIdRef.current = selectedConversation.id;

      // 如果有保存的滚动位置，隐藏容器防止用户看到 scrollTop=0 的内容
      const savedScrollTop = scrollPositionsRef.current.get(selectedConversation.id);
      if (savedScrollTop != null && savedScrollTop > 0) {
        element.style.visibility = "hidden";
        isRestoringScrollRef.current = true;
      }
    }
  }, [selectedConversation?.id]);

  // 恢复滚动位置或跟随最新内容
  useEffect(() => {
    if (!selectedConversation) {
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
    const shouldFollowLatest =
      shouldStickToBottomRef.current ||
      getResultsDistanceFromBottom(element) <= SCROLL_TO_LATEST_THRESHOLD;

    if (shouldFollowLatest) {
      requestAnimationFrame(() => scrollResultsToLatest("smooth"));
      return;
    }

    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "";
  }, [selectedConversation?.id, selectedConversation?.updatedAt, selectedConversation?.turns.length, scrollResultsToLatest]);

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

  const refreshHistory = useCallback(async () => {
    const readVersion = ++historyReadVersionRef.current;
    const history = await fetchImageHistory();
    if (!loadCancelledRef.current && readVersion === historyReadVersionRef.current) {
      conversationsRef.current = history.items;
      setConversations(history.items);
    }
    return history;
  }, []);

  useEffect(() => {
    if (isLoadingHistory) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState === "visible") await refreshHistory();
      } catch {
        // Keep the last server state visible; a later read can recover without resubmitting work.
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isLoadingHistory, refreshHistory]);

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = async () => {
    const requestId = pendingDraftRef.current ?? createId();
    pendingDraftRef.current = requestId;
    try {
      const conversation = await createImageConversation(requestId);
      await refreshHistory();
      setSelectedConversationId(conversation.id);
      if (pendingDraftRef.current === requestId) pendingDraftRef.current = null;
      shouldStickToBottomRef.current = true;
      resetComposer();
      textareaRef.current?.focus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新建对话失败");
    }
  };

  const handleSelectConversation = async (id: string) => {
    setSelectedConversationId(id);
    try {
      await selectImageConversation(id);
    } catch (error) {
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
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    try {
      await updateTurnVisibility(conversationId, turnId, part === "prompt" ? { promptDeleted: true } : { resultsDeleted: true });
      await refreshHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新记录失败");
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
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
      await renameImageConversation(id, title);
    } catch (error) {
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
    if (target.type === "prompt" || target.type === "results") {
      await handleDeleteTurnPart(target.conversationId, target.turnId, target.type);
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImageFiles((prev) => [...prev, ...files]);
      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImageFiles((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
                file: dataUrlToFile(image.dataUrl, image.name, image.type),
              }
            : await buildReferenceImageFromStoredImage(image, `conversation-${conversationId}-${Date.now()}.png`);
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);

        setReferenceImages((prev) => [...prev, nextReference.referenceImage]);
        setReferenceImageFiles((prev) => [...prev, nextReference.file]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [],
  );

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
    setReferenceImages(turn.referenceImages);
    setReferenceImageFiles(
      turn.referenceImages.map((image) => dataUrlToFile(image.dataUrl, image.name, image.type)),
    );
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, [handleImageCountChange]);

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
      await submitImageTurn(pending, conversationId);
      await refreshHistory();
      setSelectedConversationId(conversationId);
      if (pendingRegenerationsRef.current.get(key) === pending) pendingRegenerationsRef.current.delete(key);
      toast.success("已保存新轮次并开始处理");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败");
    }
  }, [refreshHistory]);

  const handleRetryImage = useCallback(async (conversationId: string, turnId: string, imageId: string) => {
    await handleRegenerateTurn(conversationId, turnId, 1, imageId);
  }, [handleRegenerateTurn]);

  const handleTimeoutRetryContinue = useCallback(async (taskId: string) => {
    try {
      await resumeImagePoll(taskId, imageTimeoutRetrySecs);
      await refreshHistory();
      toast.info(`已继续等待 ${imageTimeoutRetrySecs} 秒`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "续轮询失败");
    }
  }, [refreshHistory, imageTimeoutRetrySecs]);

  const handleDismissErrors = useCallback(async (conversationId: string, turnId: string) => {
    const turn = conversationsRef.current.find((item) => item.id === conversationId)?.turns.find((turn) => turn.id === turnId);
    if (!turn) return;
    try {
      await updateTurnVisibility(conversationId, turnId, { dismissedImageIds: turn.images.filter((image) => image.status === "error").map((image) => image.id) });
      await refreshHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新记录失败");
    }
  }, [refreshHistory]);

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

    const effectiveImageMode: ImageConversationMode = referenceImageFiles.length > 0 ? "edit" : "generate";

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
    try {
      const saved = await submitImageTurn(pending.turn, pending.conversationId);
      await refreshHistory();
      setSelectedConversationId(saved.id);
      shouldStickToBottomRef.current = true;
      setImagePrompt((current) => current.trim() === prompt ? "" : current);
      setReferenceImages((current) => current === referenceImages ? [] : current);
      setReferenceImageFiles((current) => current === referenceImageFiles ? [] : current);
      if (pendingSubmissionRef.current === pending) pendingSubmissionRef.current = null;
      toast.success("已保存并提交生成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存并提交失败");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-6.5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5.25rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
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

          <div className="relative min-h-0 flex-1">
            <div
              ref={resultsViewportRef}
              onScroll={handleResultsScroll}
              className="hide-scrollbar h-full overscroll-contain overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
              style={{ contain: "layout style paint" }}
            >
              <ImageResults
                selectedConversation={selectedConversation}
                onOpenLightbox={openLightbox}
                onContinueEdit={handleContinueEdit}
                onDeletePrompt={openDeletePromptConfirm}
                onDeleteResults={openDeleteResultsConfirm}
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
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
          />
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
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

  return <ImagePageContent isAdmin={session.role === "admin"} />;
}
