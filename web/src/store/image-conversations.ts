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
};

export type ImageConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
  sourceEntries?: Array<{ id: string; name: string }>;
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

export function fetchImageConversation(authKey: string, id: string, options: { offset?: number; limit?: number; turn_id?: string; image_id?: string } = {}) {
  const params = new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  return identityRequest<ImageConversation>(authKey, `/api/image-conversations/${encodeURIComponent(id)}?${params}`);
}

export function fetchImageConversationMetadata(authKey: string, id: string) {
  return identityRequest<ImageConversation>(authKey, `/api/image-conversations/${encodeURIComponent(id)}/metadata`);
}

export function fetchImageNavigation(authKey: string, id: string, offset = 0) {
  return identityRequest<Pick<ImageConversation, "id" | "sourceEntries" | "pagination"> & {
    turns: Array<Pick<ImageTurn, "id" | "sourceEntryId" | "createdAt" | "count" | "status" | "promptDeleted" | "resultsDeleted"> & { images: StoredImage[] }>;
  }>(authKey, `/api/image-conversations/${encodeURIComponent(id)}?navigation=true&offset=${offset}&limit=10`);
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

export function submitImageTurn(authKey: string, turn: ImageTurn, conversationId: string | null) {
  return identityRequest<ImageConversation>(authKey, "/api/image-conversations/turns", {
    method: "POST",
    body: {
      request_id: turn.id,
      conversation_id: conversationId,
      source_entry_id: turn.sourceEntryId,
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

export function useImageSource(src: string | undefined) {
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
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, managed]);
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
