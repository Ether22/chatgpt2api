"use client";

import { useEffect, useState } from "react";
import type { ImageModel } from "@/lib/api";
import { request } from "@/lib/request";

import { identityAuth, identityRequest } from "@/lib/identity-request";
import { getStoredAuthKey } from "@/store/auth";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
};

export type DraftReferenceImage = StoredReferenceImage & {
  file?: File;
  uploading?: boolean;
  progress?: number;
  error?: string;
  releasing?: boolean;
};

export async function uploadReferenceImage(authKey: string, file: File, requestId: string, onProgress: (percent: number) => void) {
  const body = new FormData();
  body.append("file", file);
  body.append("request_id", requestId);
  const saved = (await request.post<StoredReferenceImage>("/api/image-references", body, {
    ...await identityAuth(authKey),
    onUploadProgress: (event) => onProgress(Math.round(100 * event.loaded / (event.total || file.size || 1))),
  })).data;
  await identityAuth(authKey);
  return saved;
}

const referenceOperations = new Map<string, Promise<unknown>>();

function referenceOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const pending = (referenceOperations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
  referenceOperations.set(id, pending);
  void pending.finally(() => {
    if (referenceOperations.get(id) === pending) referenceOperations.delete(id);
  }).catch(() => {});
  return pending;
}

export function cancelReferenceUpload(authKey: string, requestId: string) {
  return identityRequest(authKey, `/api/image-references/uploads/${encodeURIComponent(requestId)}`, { method: "DELETE" });
}

export function releaseReferenceImage(authKey: string, id: string) {
  return referenceOperation(`${authKey}:${id}`, () => identityRequest(authKey, `/api/image-references/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export function retainReferenceImage(authKey: string, id: string) {
  return referenceOperation(`${authKey}:${id}`, () => identityRequest<StoredReferenceImage>(authKey, `/api/image-references/${encodeURIComponent(id)}/retain`, { method: "POST" }));
}

export function fetchReferenceImages(authKey: string) {
  return identityRequest<{ items: DraftReferenceImage[] }>(authKey, "/api/image-references");
}

export type StoredImage = {
  id: string;
  ordinal?: number;
  taskId?: string;
  updatedAt?: string;
  errorCode?: string;
  errorDetail?: string;
  retryable?: boolean;
  canResume?: boolean;
  dispatchState?: string;
  waiting?: { reason: string; message: string; restore_at?: string } | null;
  status?: "loading" | "success" | "error";
  taskStatus?: "queued" | "running";
  progress?: string;
  b64_json?: string;
  file_size?: number;
  url?: string;
  revised_prompt?: string;
  error?: string;
  startTime?: number;
  elapsedSecs?: number;
  elapsedUpdatedAt?: number;
  durationMs?: number;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error";

export type ImageTurn = {
  id: string;
  sourceEntryId?: string;
  sourceOrdinal?: number;
  sourceTurnId?: string;
  rerun?: boolean;
  md?: {
    document_id: string; name: string; document_name: string; output_name: string | null;
    reference_names: string[]; upload_ids: string[]; md_version: number; candidate_key: string;
  };
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  count: number;
  size: string;
  ratio: string;
  tier: string;
  quality: string;
  images: StoredImage[];
  createdAt: string;
  status: ImageTurnStatus;
  error?: string;
  promptDeleted?: boolean;
  resultsDeleted?: boolean;
  resultCleanups?: ResultCleanup[];
};

export type ResultCleanup = {
  id: string;
  ordinal: number;
  state: "pending" | "complete" | "retained" | "error";
  error?: string;
};

export type ImageCleanupPage = {
  stats: Record<ResultCleanup["state"], number>;
  pagination: ImagePagination;
  items: Array<ResultCleanup & { conversation_id: string; turn_id: string; conversation_title: string; turn_number: number }>;
};

export function fetchImageCleanups(authKey: string, offset = 0) {
  return identityRequest<ImageCleanupPage>(authKey, `/api/image-cleanups?offset=${offset}&limit=50`);
}

export function retryImageCleanup(authKey: string, taskId: string) {
  return identityRequest(authKey, `/api/image-cleanups/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
}

export function retryAllImageCleanups(authKey: string) {
  return identityRequest<{ accepted: number; running: boolean }>(authKey, "/api/image-cleanups/retry-failed", { method: "POST" });
}

export function deleteImageResult(authKey: string, conversationId: string, turnId: string, imageId: string) {
  return identityRequest<Omit<ResultCleanup, "ordinal">>(authKey, `/api/image-conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/images/${encodeURIComponent(imageId)}`, {
    method: "DELETE",
  });
}

export type ImageConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
  sourceEntries?: Array<{ id: string; name: string; documentId?: string }>;
  turnCount?: number;
  stats?: ImageConversationStats;
  pagination?: ImagePagination;
  target?: { turn_id: string; image_id: string | null };
};

export type ImagePagination = {
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
  previous_offset: number | null;
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

export type ImageHistory = {
  items: ImageConversation[];
  current_conversation_id: string | null;
  pagination: ImagePagination;
  stats: ImageConversationStats;
};

export function fetchImageHistory(authKey: string, offset = 0) {
  return identityRequest<ImageHistory>(authKey, `/api/image-conversations?offset=${offset}&limit=30`);
}

export async function fetchImageConversation(authKey: string, id: string, target: { turn_id?: string; image_id?: string } = {}) {
  const conversation = await fetchExistingImageConversation(authKey, id);
  if (!conversation) throw new Error("会话不存在或已删除");
  if (target.turn_id || target.image_id) {
    const turn = conversation.turns.find((turn) => !(turn.promptDeleted && turn.resultsDeleted)
      && (!target.turn_id || turn.id === target.turn_id)
      && (!target.image_id || turn.images.some((image) => image.id === target.image_id)));
    if (!turn) throw new Error("结果不存在或已删除");
    conversation.target = { turn_id: turn.id, image_id: target.image_id ?? null };
  }
  return conversation;
}

export function fetchImageConversationMetadata(authKey: string, id: string) {
  return fetchExistingConversation(authKey, `/api/image-conversations/${encodeURIComponent(id)}/metadata`);
}

async function fetchExistingConversation(authKey: string, url: string) {
  const response = await request.get<ImageConversation>(url, {
    ...await identityAuth(authKey), validateStatus: (status) => status === 200 || status === 404,
  });
  await identityAuth(authKey);
  return response.status === 404 ? null : response.data;
}

export async function fetchExistingImageConversation(authKey: string, id: string) {
  let offset: number | null = 0;
  let first: ImageConversation | null = null;
  const turns = new Map<string, ImageTurn>();
  const sources = new Map<string, NonNullable<ImageConversation["sourceEntries"]>[number]>();
  while (offset !== null) {
    const page = await fetchExistingConversation(authKey, `/api/image-conversations/${encodeURIComponent(id)}?offset=${offset}&limit=10`);
    if (!page) return null;
    first ??= page;
    page.turns.forEach((turn) => turns.set(turn.id, turn));
    page.sourceEntries?.forEach((source) => sources.set(source.id, source));
    offset = page.pagination?.next_offset ?? null;
  }
  return first ? { ...first, turns: [...turns.values()], sourceEntries: [...sources.values()],
    pagination: { offset: 0, limit: turns.size, total: turns.size, next_offset: null, previous_offset: null } } : null;
}

export type ImageNavigationPage = Pick<ImageConversation, "id" | "sourceEntries" | "pagination"> & {
  turns: Array<Pick<ImageTurn, "id" | "sourceEntryId" | "sourceOrdinal" | "createdAt" | "count" | "status" | "promptDeleted" | "resultsDeleted"> & { images: Pick<StoredImage, "id" | "ordinal" | "status">[] }>;
};

export function fetchImageNavigation(authKey: string, id: string, offset = 0) {
  return identityRequest<ImageNavigationPage>(authKey, `/api/image-conversations/${encodeURIComponent(id)}?navigation=true&offset=${offset}&limit=10`);
}

export async function listImageConversations(authKey: string): Promise<ImageConversation[]> {
  return (await fetchImageHistory(authKey)).items;
}

export function createImageConversation(authKey: string, requestId: string) {
  return identityRequest<ImageConversation>(authKey, "/api/image-conversations", {
    method: "POST", body: { request_id: requestId },
  });
}

export function selectImageConversation(authKey: string, id: string) {
  return identityRequest(authKey, "/api/image-conversations/current", {
    method: "PUT", body: { conversation_id: id },
  });
}

export function submitImageTurn(authKey: string, turn: ImageTurn, conversationId: string | null, draftId?: string) {
  return identityRequest<ImageConversation>(authKey, "/api/image-conversations/turns", {
    method: "POST",
    body: {
      request_id: turn.id,
      conversation_id: conversationId,
      draft_id: conversationId ? undefined : draftId,
      source_entry_id: turn.sourceEntryId,
      source_turn_id: turn.sourceTurnId,
      rerun: turn.rerun ?? false,
      prompt: turn.prompt,
      model: turn.model,
      size: turn.size,
      ratio: turn.ratio,
      tier: turn.tier,
      quality: turn.quality,
      count: turn.count,
      referenceImages: turn.referenceImages.map(({ id }) => ({ id })),
    },
  });
}

export function updateTurnVisibility(authKey: string, conversationId: string, turnId: string, flags: { promptDeleted?: boolean; resultsDeleted?: boolean; dismissedImageIds?: string[] }) {
  return identityRequest<ImageConversation>(authKey, `/api/image-conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH", body: { turns: [{ id: turnId, ...flags }] },
  });
}

export async function renameImageConversation(authKey: string, id: string, title: string): Promise<void> {
  await identityRequest(authKey, `/api/image-conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: { title } });
}

export async function deleteImageConversation(authKey: string, id: string): Promise<void> {
  await identityRequest(authKey, `/api/image-conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearImageConversations(authKey: string): Promise<void> {
  await identityRequest(authKey, "/api/image-conversations", { method: "DELETE" });
}

function managedImagePath(src: string) {
  const path = new URL(src, window.location.origin).pathname;
  return /^\/(images|image-thumbnails)\/managed\//i.test(path) ? path : null;
}

export async function fetchStoredImageBlob(src: string, signal?: AbortSignal, authKey?: string): Promise<Blob> {
  const path = managedImagePath(src);
  if (path) {
    // Resolve against the configured API, never forward the identity key to a result URL's host.
    const key = authKey ?? await getStoredAuthKey();
    const blob = (await request.get<Blob>(path, { responseType: "blob", signal, ...await identityAuth(key) })).data;
    await identityAuth(key);
    return blob;
  }
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`读取图片失败 (${response.status})`);
  return response.blob();
}

export async function downloadStoredImage(src: string, filename: string, signal?: AbortSignal, authKey?: string) {
  const key = authKey ?? await getStoredAuthKey();
  const blob = await fetchStoredImageBlob(src, signal, key);
  // Result URLs may end in .png even when the upstream returned JPEG or GIF.
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...header);
  const extension = signature.startsWith("\x89PNG\r\n\x1a\n") ? "png"
    : header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? "jpg"
    : signature.startsWith("GIF87a") || signature.startsWith("GIF89a") ? "gif"
    : signature.startsWith("RIFF") && signature.slice(8) === "WEBP" ? "webp" : undefined;
  await identityAuth(key);
  signal?.throwIfAborted();
  if (!extension) throw new Error("无法识别原图格式，未下载");
  const name = `${filename.replace(/\.[^.]+$/, "")}.${extension}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to take ownership before releasing the original bytes.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export function useImageSource(src: string | undefined, attempt = 0, onError?: () => void) {
  const [loaded, setLoaded] = useState<{ source: string; url: string } | null>(null);
  const managed = src && typeof window !== "undefined" ? managedImagePath(src) : null;
  useEffect(() => {
    setLoaded(null);
    if (!src || !managed) return;
    const controller = new AbortController();
    let objectUrl = "";
    void fetchStoredImageBlob(src, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ source: src, url: objectUrl });
    }).catch(() => {
      // A revoked identity or failed image read must never fall back to an unauthenticated URL.
      if (!controller.signal.aborted) onError?.();
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, managed, attempt, onError]);
  return managed ? (loaded && loaded.source === src ? loaded.url : undefined) : src;
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (conversation?.stats) return conversation.stats;
  return (conversation?.turns || []).reduce((stats, turn) => {
    if (!turn.resultsDeleted) {
      if (turn.status === "queued") stats.queued += 1;
      if (turn.status === "generating") stats.running += 1;
    }
    return stats;
  }, { queued: 0, running: 0 });
}
