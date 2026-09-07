"use client";

import { getStoredAuthKey } from "@/store/auth";
import { httpRequest } from "@/lib/request";

export class IdentityChanged extends Error {
  constructor() { super("登录身份已变更，请刷新页面后继续"); }
}

export async function identityAuth(authKey: string) {
  if (!authKey || await getStoredAuthKey() !== authKey) throw new IdentityChanged();
  return { headers: { Authorization: `Bearer ${authKey}` }, redirectOnUnauthorized: false };
}

export async function identityRequest<T>(authKey: string, path: string, options: Parameters<typeof httpRequest>[1] = {}) {
  const result = await httpRequest<T>(path, { ...options, ...await identityAuth(authKey) });
  await identityAuth(authKey);
  return result;
}
