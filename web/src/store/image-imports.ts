"use client";

import { httpRequest, request } from "@/lib/request";
import type { StoredReferenceImage } from "@/store/image-conversations";
import { getStoredAuthKey } from "@/store/auth";
import type { AxiosProgressEvent } from "axios";

export type ImportReference = {
  request_id: string;
  name: string;
  size: number;
  reference: StoredReferenceImage | null;
  error?: string;
};
export type ImportMutation = { request_id: string; version: number };
export type ImportCleanup = ImportMutation & { upload_ids: string[]; clear: boolean };
export type ImportCandidateConfig = {
  document_id: string;
  name: string;
  prompt: string;
  size: string;
  output_name: string | null;
  reference_names: string[] | null;
};
export type ImportCandidate = {
  key: string;
  config: ImportCandidateConfig;
  skipped: boolean;
  status: "ready" | "pending" | "error";
  errors: { field: string; code: string; message: string }[];
  matches: { name: string; status: "ready" | "pending" | "error"; upload_id: string | null; reference: StoredReferenceImage | null }[];
};
export type CandidateChanges = Partial<ImportCandidateConfig & { skipped: boolean }>;
export type ImageImports = {
  version: number;
  revision: number;
  md_version: number;
  candidates: ImportCandidate[];
  md: { name: string; content: string; size: number } | null;
  references: ImportReference[];
  pending: ImportCleanup | null;
  updated_at: string | null;
};

export class ImportIdentityChanged extends Error {
  constructor() { super("登录身份已变更，请刷新页面后继续"); }
}

async function importAuth(authKey: string) {
  if (!authKey || await getStoredAuthKey() !== authKey) throw new ImportIdentityChanged();
  // Bind the validated key even if another tab logs in between this check and dispatch.
  return { headers: { Authorization: `Bearer ${authKey}` }, redirectOnUnauthorized: false };
}

export const fetchImageImports = async (authKey: string) => httpRequest<ImageImports>("/api/image-imports", await importAuth(authKey));
export const correctImportCandidate = async (authKey: string, key: string, mutation: ImportMutation & { md_version: number }, changes: CandidateChanges) =>
  httpRequest<ImageImports>(`/api/image-imports/candidates/${encodeURIComponent(key)}`, {
    ...await importAuth(authKey), method: "PATCH", body: { ...mutation, changes },
  });
export const reserveImportReference = async (authKey: string, file: File, mutation: ImportMutation) =>
  httpRequest<ImageImports>("/api/image-imports/references", {
    ...await importAuth(authKey), method: "POST", body: { ...mutation, name: file.name, size: file.size },
  });

export async function uploadImportFile(authKey: string, file: File, kind: "md" | "reference", mutation: ImportMutation, progress: (value: number) => void) {
  const body = new FormData();
  body.append("file", file);
  if (kind === "md") {
    body.append("request_id", mutation.request_id);
    body.append("version", String(mutation.version));
  }
  const config = {
    ...await importAuth(authKey),
    onUploadProgress: (event: AxiosProgressEvent) => progress(Math.round(100 * event.loaded / (event.total || file.size || 1))),
  };
  return (await request.put<ImageImports>(kind === "md" ? "/api/image-imports/md" : `/api/image-imports/references/${encodeURIComponent(mutation.request_id)}`, body, config)).data;
}

export async function cleanupImageImports(authKey: string, cleanup: ImportCleanup) {
  const { clear, upload_ids, ...mutation } = cleanup;
  return httpRequest<ImageImports>(clear ? "/api/image-imports" : `/api/image-imports/references/${encodeURIComponent(upload_ids[0])}`, {
    ...await importAuth(authKey), method: "DELETE", body: clear ? { ...mutation, upload_ids } : mutation,
  });
}
