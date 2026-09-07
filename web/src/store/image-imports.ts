"use client";

import { httpRequest, request } from "@/lib/request";
import type { StoredReferenceImage } from "@/store/image-conversations";

export type ImportReference = {
  request_id: string;
  name: string;
  size: number;
  reference: StoredReferenceImage | null;
  error?: string;
};
export type ImportMutation = { request_id: string; version: number };
export type ImportCleanup = ImportMutation & { upload_ids: string[]; clear: boolean };
export type ImageImports = {
  version: number;
  revision: number;
  md: { name: string; content: string; size: number } | null;
  references: ImportReference[];
  pending: ImportCleanup | null;
  updated_at: string | null;
};

export const fetchImageImports = () => httpRequest<ImageImports>("/api/image-imports");
export const reserveImportReference = (file: File, mutation: ImportMutation) =>
  httpRequest<ImageImports>("/api/image-imports/references", {
    method: "POST", body: { ...mutation, name: file.name, size: file.size },
  });

export async function uploadImportFile(file: File, kind: "md" | "reference", mutation: ImportMutation, progress: (value: number) => void) {
  const body = new FormData();
  body.append("file", file);
  if (kind === "md") {
    body.append("request_id", mutation.request_id);
    body.append("version", String(mutation.version));
  }
  return (await request.put<ImageImports>(kind === "md" ? "/api/image-imports/md" : `/api/image-imports/references/${encodeURIComponent(mutation.request_id)}`, body, {
    onUploadProgress: (event) => progress(Math.round(100 * event.loaded / (event.total || file.size || 1))),
  })).data;
}

export function cleanupImageImports(cleanup: ImportCleanup) {
  const { clear, upload_ids, ...mutation } = cleanup;
  return httpRequest<ImageImports>(clear ? "/api/image-imports" : `/api/image-imports/references/${encodeURIComponent(upload_ids[0])}`, {
    method: "DELETE", body: clear ? { ...mutation, upload_ids } : mutation,
  });
}
