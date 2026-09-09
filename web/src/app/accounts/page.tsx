"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Copy,
  Download,
  Eye,
  GripVertical,
  Link2,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchAccounts,
  deleteAccounts,
  exportAccounts,
  fetchModels,
  fetchRefreshProgress,
  fetchReLoginProgress,
  reLoginAccounts,
  refreshAccounts,
  moveAccount,
  testProxy,
  updateAccount,
  type Account,
  type AccountRefreshResponse,
  type AccountStatus,
  type AccountUsageMode,
  type Model,
  type RefreshProgressResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { formatBeijingDateTime } from "@/lib/business-time";
import { cn } from "@/lib/utils";

import { AccountImportDialog } from "./components/account-import-dialog";

const accountStatusOptions: { label: string; value: AccountStatus | AccountUsageMode | "inflight" | "all" }[] = [
  { label: "全部状态", value: "all" },
  { label: "正常", value: "正常" },
  { label: "限流", value: "限流" },
  { label: "异常", value: "异常" },
  { label: "在途", value: "inflight" },
  { label: "仅监控", value: "monitor" },
  { label: "禁用", value: "disabled" },
];

const usageModeOptions: { label: string; value: AccountUsageMode }[] = [
  { label: "正常使用", value: "normal" },
  { label: "仅监控", value: "monitor" },
  { label: "禁用", value: "disabled" },
];

const ACCOUNT_PAGE_SIZE_KEY = "chatgpt2api.accounts.page-size";

const statusMeta: Record<
  AccountStatus,
  {
    icon: typeof CheckCircle2;
    badge: ComponentProps<typeof Badge>["variant"];
  }
> = {
  正常: { icon: CheckCircle2, badge: "success" },
  限流: { icon: CircleAlert, badge: "warning" },
  异常: { icon: CircleOff, badge: "danger" },
};

const metricCards = [
  { key: "total", label: "账户总数", color: "text-stone-900", icon: UserRound },
  { key: "active", label: "正常账户", color: "text-emerald-600", icon: CheckCircle2 },
  { key: "limited", label: "限流账户", color: "text-orange-500", icon: CircleAlert },
  { key: "abnormal", label: "异常账户", color: "text-rose-500", icon: CircleOff },
  { key: "disabled", label: "禁用账户", color: "text-stone-500", icon: Ban },
  { key: "quota", label: "可用剩余额度", color: "text-blue-500", icon: RefreshCw },
] as const;

function formatCompact(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatQuota(account: Account) {
  return String(Math.max(0, account.quota));
}

function formatRestoreAt(value?: string | null) {
  const absolute = formatBeijingDateTime(value);
  if (!value || absolute === value) return { absolute, relative: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: value, relative: "" };
  }

  const diffMs = Math.max(0, date.getTime() - Date.now());
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const relative = diffMs > 0 ? `剩余 ${days}d ${hours}h` : "已到恢复时间";

  return { absolute, relative };
}

function formatQuotaSummary(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status === "正常" && account.usage_mode === "normal");
  return formatCompact(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function maskToken(token?: string) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 16)}...${token.slice(-8)}`;
}

function downloadTokens(accounts: Account[]) {
  const content = `${accounts.map((account) => account.access_token).join("\n")}\n`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `accounts-${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function displayAccountType(account: Account) {
  return account.type || "Free";
}

function displayAccountSource(account: Account) {
  const source = String(account.source_type || "").trim().toLowerCase();
  if (!source) {
    return "web";
  }
  if (source === "web") {
    return "web";
  }
  return source;
}

function SortableAccountRow({ account, disabled, selected, onSelect, onStart, onEnd, onMove, children }: {
  account: Account; disabled: boolean; selected: boolean; onSelect: (selected: boolean) => void;
  onStart: () => void; onEnd: () => void; onMove: (direction: number) => Promise<void>; children: ReactNode;
}) {
  const controls = useDragControls();
  const handleRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  return (
    <Reorder.Item as="tr" value={account.access_token} dragListener={false} dragControls={controls}
      onDragStart={onStart} onDragEnd={onEnd} style={{ position: "relative" }}
      transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 38 }}
      whileDrag={{ zIndex: 1, boxShadow: "0 8px 24px #0002" }}
      className={cn("border-b border-stone-100/80 bg-white text-sm text-stone-600 hover:bg-stone-50", account.usage_mode === "monitor" && "bg-amber-50 hover:bg-amber-100")}
    >
      <td className={cn("px-4 py-3", account.usage_mode === "monitor" && "border-l-4 border-l-amber-400")}>
        <button ref={handleRef} type="button" disabled={disabled} aria-label={`排序 ${account.email || maskToken(account.access_token)}`}
          aria-describedby="account-order-help"
          className="mb-2 block touch-none cursor-grab rounded p-1 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-500 active:cursor-grabbing disabled:cursor-wait"
          onPointerDown={(event) => { if (!disabled) controls.start(event); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            void onMove(event.key === "ArrowUp" ? -1 : 1).then(() => {
              requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
            });
          }}
        ><GripVertical className="size-4" /></button>
        <Checkbox checked={selected} onCheckedChange={(checked) => onSelect(Boolean(checked))} />
      </td>
      {children}
    </Reorder.Item>
  );
}

function AccountsPageContent() {
  const didLoadRef = useRef(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<Account[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [liveStats, setLiveStats] = useState<RefreshProgressResponse["stats"]>();
  const dragRef = useRef<{ token: string; original: string[]; order: string[] } | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | AccountUsageMode | "inflight" | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ACCOUNT_PAGE_SIZE_KEY);
      if (saved && ["10", "20", "50", "100"].includes(saved)) setPageSize(saved);
    } catch { /* Keep the default when browser storage is unavailable. */ }
  }, []);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editUsageMode, setEditUsageMode] = useState<AccountUsageMode>("normal");
  const [editProxy, setEditProxy] = useState("");
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingTokens, setRefreshingTokens] = useState<Set<string>>(new Set());
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRelogining, setIsRelogining] = useState(false);
  const [progress, setProgress] = useState<{
    visible: boolean;
    current: number;
    total: number;
    message: string;
    email: string;
  }>({
    visible: false,
    current: 0,
    total: 0,
    message: "",
    email: "",
  });

  const loadAccounts = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchAccounts();
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载账户失败";
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const loadModels = async (refresh = false) => {
    setIsLoadingModels(true);
    try {
      const data = await fetchModels(refresh);
      setAvailableModels(Array.isArray(data.data) ? data.data : []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载模型列表失败";
      toast.error(message);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadAccounts();
    void loadModels();

  }, []);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return accounts.filter((account) => {
      const searchMatched =
        normalizedQuery.length === 0 || (account.email ?? "").toLowerCase().includes(normalizedQuery);
      const typeMatched = typeFilter === "all" || displayAccountType(account) === typeFilter;
      const statusMatched = statusFilter === "inflight" ? (account.image_inflight ?? 0) > 0
        : statusFilter === "all" || account.status === statusFilter || account.usage_mode === statusFilter;
      return searchMatched && typeMatched && statusMatched;
    }).sort((a, b) => Number(b.usage_mode === "monitor") - Number(a.usage_mode === "monitor") || (a.display_order ?? 0) - (b.display_order ?? 0));
  }, [accounts, query, statusFilter, typeFilter]);

  const handleDelete = async () => {
    if (isDeleting || !deleteTargets.length) return;
    setIsDeleting(true);
    try {
      const data = await deleteAccounts(deleteTargets.map((account) => account.access_token));
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((account) => account.access_token === id)));
      setDeleteTargets([]);
      toast.success(`已删除 ${data.removed} 个账号`);
      void loadModels();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除账号失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await exportAccounts();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `accounts-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出账号失败");
    } finally { setIsExporting(false); }
  };

  const handleMove = async (source: string, target: Account, position: "before" | "after") => {
    if (isMoving || source === target.access_token) return;
    const account = accounts.find((item) => item.access_token === source);
    if (!account || (account.usage_mode === "monitor") !== (target.usage_mode === "monitor")) {
      toast.error("只能在监控组或其余账号组内部排序");
      return;
    }
    setIsMoving(true);
    try {
      setAccounts((await moveAccount(source, target.access_token, position)).items);
      toast.success("组内顺序已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存顺序失败");
    } finally {
      setIsMoving(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const pageRows = filteredAccounts.slice(startIndex, startIndex + Number(pageSize));
  const currentRows = dragOrder ? [...pageRows].sort((a, b) => dragOrder.indexOf(a.access_token) - dragOrder.indexOf(b.access_token)) : pageRows;
  const finishDrag = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      if (!drag) return;
      const from = drag.original.indexOf(drag.token);
      const to = drag.order.indexOf(drag.token);
      if (from === to) return;
      const targetToken = drag.order[to + (to > from ? -1 : 1)];
      const target = accounts.find((item) => item.access_token === targetToken);
      if (target) await handleMove(drag.token, target, to > from ? "after" : "before");
    } finally { setDragOrder(null); }
  };
  const allCurrentSelected =
    currentRows.length > 0 && currentRows.every((row) => selectedIds.includes(row.access_token));

  const summary = useMemo(() => {
    if (liveStats && (isRefreshing || isRelogining)) {
      return { ...liveStats, quota: formatCompact(liveStats.total_quota) };
    }
    const total = accounts.length;
    const active = accounts.filter((item) => item.status === "正常" && item.usage_mode === "normal").length;
    const limited = accounts.filter((item) => item.status === "限流").length;
    const abnormal = accounts.filter((item) => item.status === "异常").length;
    const disabled = accounts.filter((item) => item.usage_mode === "disabled").length;
    const quota = formatQuotaSummary(accounts);

    return { total, active, limited, abnormal, disabled, quota };
  }, [accounts, liveStats, isRefreshing, isRelogining]);

  const accountTypeOptions = useMemo(
    () => [
      { label: "全部类型", value: "all" },
      ...Array.from(new Set(accounts.map(displayAccountType))).map((type) => ({ label: type, value: type })),
    ],
    [accounts],
  );

  const selectedTokens = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return accounts.filter((item) => selectedSet.has(item.access_token)).map((item) => item.access_token);
  }, [accounts, selectedIds]);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);

    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);

    return items;
  }, [pageCount, safePage]);

  const waitForRelogin = async (progressId: string) => {
    while (true) {
      const p = await fetchReLoginProgress(progressId);
      if (p.stats) setLiveStats(p.stats);
      setProgress({ visible: true, current: p.processed, total: p.total,
        message: p.done ? "恢复流程已完成" : "正在尝试恢复异常账号…", email: "" });
      if (p.error) throw new Error(p.error);
      if (p.done) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  const handleRefreshAccounts = async (accessTokens: string[]) => {
    if (!accessTokens.length || isRefreshing || isRelogining) return;
    setIsRefreshing(true);
    setRefreshingTokens(new Set(accessTokens));
    setProgress({ visible: true, current: 0, total: accessTokens.length, message: "正在刷新账号信息…", email: "" });
    try {
      const { progress_id } = await refreshAccounts(accessTokens);
      let data: AccountRefreshResponse;
      while (true) {
        const p = await fetchRefreshProgress(progress_id);
        if (p.stats) setLiveStats(p.stats);
        setProgress((prev) => ({ ...prev, current: p.processed }));
        if (p.error) throw new Error(p.error);
        if (p.done) {
          if (!p.result) throw new Error("刷新结果为空");
          data = p.result;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      if (data.relogin_progress_id) {
        await waitForRelogin(data.relogin_progress_id);
        await loadAccounts(true);
      }
      const errors = data.errors ?? [];
      await loadModels(true);
      if (errors.length) toast.error(`刷新成功 ${data.refreshed} 个，失败 ${errors.length} 个：${errors[0].error}`);
      else toast.success(`刷新完成，成功 ${data.refreshed} 个账户`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新账户失败");
    } finally {
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      setRefreshingTokens(new Set());
      setIsRefreshing(false);
      setLiveStats(undefined);
    }
  };

  const handleReLogin = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("请先选择要恢复的账户");
      return;
    }

    // 只处理异常账号，过滤非异常账号
    const abnormalTokens = accessTokens.filter((token) => {
      const account = accounts.find((a) => a.access_token === token);
      return account?.status === "异常";
    });

    if (abnormalTokens.length === 0) {
      toast.error("选中账号中没有异常账号");
      return;
    }

    if (abnormalTokens.length < accessTokens.length) {
      toast.info(`已过滤 ${accessTokens.length - abnormalTokens.length} 个非异常账号`);
    }

    setIsRelogining(true);

    // 显示进度条（真实进度）
    const total = abnormalTokens.length;
    setProgress({ visible: true, current: 0, total, message: "正在尝试恢复异常账号...", email: "" });

    try {
      const { progress_id } = await reLoginAccounts(abnormalTokens);

      await waitForRelogin(progress_id);
      await loadAccounts(true);

      setProgress({
        visible: true,
        current: total,
        total,
        message: "恢复完成",
        email: "",
      });
      setTimeout(() => setProgress({ visible: false, current: 0, total: 0, message: "", email: "" }), 800);

      toast.success(`恢复流程已全部完成`);
    } catch (error) {
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      const message = error instanceof Error ? error.message : "重新登录失败";
      toast.error(message);
    } finally {
      setIsRelogining(false);
      setLiveStats(undefined);
    }
  };

  const openEditDialog = (account: Account) => {
    setEditingAccount(account);
    setEditUsageMode(account.usage_mode);
    setEditProxy(account.proxy ?? "");
  };

  const handleTestAccountProxy = async () => {
    const candidate = editProxy.trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    try {
      const data = await testProxy(candidate);
      data.result.ok
        ? toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`)
        : toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleUpdateAccount = async () => {
    if (!editingAccount) {
      return;
    }

    setIsUpdating(true);
    try {
      const data = await updateAccount(editingAccount.access_token, {
        usage_mode: editUsageMode,
        proxy: editProxy.trim(),
      });
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      setEditingAccount(null);
      toast.success("账号信息已更新");
      void loadModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新账号失败";
      toast.error(message);
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.access_token)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.access_token === id)));
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
            Account Pool
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">号池管理</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadAccounts()}
            disabled={isLoading || isRefreshing}
          >
            <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void handleRefreshAccounts(accounts.map((item) => item.access_token))}
            disabled={isLoading || isRefreshing || accounts.length === 0}
          >
            <RefreshCw className={cn("size-4", isRefreshing ? "animate-spin" : "")} />
            一键刷新所有账号信息和额度
          </Button>
          <AccountImportDialog
            disabled={isLoading || isRefreshing}
            onImported={(items) => {
              setAccounts(items);
              setSelectedIds([]);
              setPage(1);
            }}
          />
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void handleExport()}
            disabled={accounts.length === 0 || isExporting}
          >
            {isExporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            导出全部账号（JSON）
          </Button>
          <Button variant="outline" className="h-10 rounded-xl" onClick={() => downloadTokens(accounts)} disabled={!accounts.length}>
            导出纯 Token（TXT）
          </Button>
        </div>
      </section>

      {/* 进度条 */}
      {progress.visible && (
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white/90 shadow-sm">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-stone-600">
                {progress.message}
                {progress.email && <span className="ml-1 font-medium text-stone-700">{progress.email}</span>}
              </span>
              <span className="font-medium text-stone-700">
                {progress.current}/{progress.total}
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-all duration-300 ease-out"
                style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      )}

      <Dialog open={deleteTargets.length > 0} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTargets([]); }}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>删除 {deleteTargets.length} 个账号</DialogTitle>
            <DialogDescription>将从号池移除以下账号及其登录凭据，删除后无法撤销。</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-stone-600">
            正常使用 {deleteTargets.filter((account) => account.usage_mode === "normal").length} · 仅监控 {deleteTargets.filter((account) => account.usage_mode === "monitor").length} · 禁用 {deleteTargets.filter((account) => account.usage_mode === "disabled").length}
          </p>
          <ul className="max-h-40 overflow-auto text-sm text-stone-500">
            {deleteTargets.slice(0, 20).map((account) => <li key={account.access_token}>{account.email || maskToken(account.access_token)}</li>)}
            {deleteTargets.length > 20 && <li>以及另外 {deleteTargets.length - 20} 个账号</li>}
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={isDeleting} onClick={() => setDeleteTargets([])}>取消</Button>
            <Button variant="destructive" disabled={isDeleting} onClick={() => void handleDelete()}>{isDeleting ? "正在删除…" : "确认删除"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingAccount)} onOpenChange={(open) => (!open ? setEditingAccount(null) : null)}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑账户</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              设置账号使用状态和专属代理。监控和禁用仍自动维护，但不参与消费。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="account-usage-mode" className="text-sm font-medium text-stone-700">使用状态</label>
              <Select value={editUsageMode} onValueChange={(value) => setEditUsageMode(value as AccountUsageMode)}>
                <SelectTrigger id="account-usage-mode" className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {usageModeOptions
                    .map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">账号代理</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={editProxy}
                  onChange={(event) => setEditProxy(event.target.value)}
                  placeholder="留空走全局代理，例如 http://127.0.0.1:7890"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
                <Button
                  variant="outline"
                  className="h-11 rounded-xl border-stone-200 bg-white px-4 text-stone-700 sm:w-24"
                  onClick={() => void handleTestAccountProxy()}
                  disabled={isTestingProxy}
                >
                  {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                  测试
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setEditingAccount(null)}
              disabled={isUpdating}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleUpdateAccount()}
              disabled={isUpdating}
            >
              {isUpdating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {metricCards.map((item) => {
            const Icon = item.icon;
            const value = summary[item.key];
            return (
              <Card key={item.key} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
                <CardContent className="p-4">
                  <div className="mb-4 flex items-start justify-between">
                    <span className="text-xs font-medium text-stone-400">{item.label}</span>
                    <Icon className="size-4 text-stone-400" />
                  </div>
                  <div className={cn("text-[1.75rem] font-semibold tracking-tight", item.color)}>
                    <span className={typeof value === "number" ? "" : "text-[1.1rem]"}>
                      {typeof value === "number" ? formatCompact(value) : value}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="p-4">
            <div className="mb-3 text-sm font-medium text-stone-700">
              系统可用模型
              <span className="ml-1 text-stone-400">({availableModels.length})</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableModels.length > 0 ? (
                availableModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className="inline-flex cursor-pointer items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-50"
                    onClick={() => {
                      void navigator.clipboard.writeText(model.id);
                      toast.success("模型名已复制");
                    }}
                    title={`点击复制 ${model.id}`}
                  >
                    <img
                      src="/openai.svg"
                      alt=""
                      aria-hidden="true"
                      className="mr-1.5 size-3.5 shrink-0"
                    />
                    {model.id}
                  </button>
                ))
              ) : isLoadingModels ? (
                <span className="text-sm text-stone-400">正在加载模型列表...</span>
              ) : (
                <span className="text-sm text-stone-400">当前暂无可用模型</span>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">账户列表</h2>
            <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
              {filteredAccounts.length}
            </Badge>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-[260px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索邮箱"
                className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) => {
                setTypeFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as AccountStatus | AccountUsageMode | "inflight" | "all");
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="账号状态筛选" className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && accounts.length === 0 ? (
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-stone-700">正在加载账户</p>
                <p className="text-sm text-stone-500">从后端同步账号列表和状态。</p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card
          className={cn(
            "overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm",
            isLoading && accounts.length === 0 ? "hidden" : "",
          )}
        >
          <CardContent className="space-y-0 p-0">
            <div className="flex flex-col gap-3 border-b border-stone-100 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm text-stone-500">
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-stone-500 hover:bg-stone-100"
                  onClick={() => void handleRefreshAccounts(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isRefreshing}
                >
                  {isRefreshing ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  刷新选中账号信息和额度
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                  onClick={() => void handleReLogin(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isRelogining}
                  title="尝试密码登录恢复账号"
                >
                  {isRelogining ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                  尝试恢复异常账号
                </Button>
                <Button variant="ghost" className="h-8 rounded-lg text-rose-600 hover:bg-rose-50" disabled={!selectedTokens.length || isDeleting || isMoving}
                  onClick={() => setDeleteTargets(accounts.filter((account) => selectedTokens.includes(account.access_token)))}>
                  <Trash2 className="size-4" />删除所选
                </Button>
                <Button variant="ghost" className="h-8 rounded-lg text-rose-600 hover:bg-rose-50" disabled={!accounts.some((account) => account.status === "异常") || isDeleting || isMoving}
                  onClick={() => setDeleteTargets(accounts.filter((account) => account.status === "异常"))}>
                  <Trash2 className="size-4" />移除异常账号
                </Button>
                {selectedIds.length > 0 ? (
                  <span className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                    已选择 {selectedIds.length} 项
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-stone-500">
              <span id="account-order-help">监控组始终在前。拖动排序柄调整同组顺序；聚焦排序柄后按 ↑ / ↓ 移动。</span>
              <span role="status">{isMoving ? "正在保存顺序…" : ""}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left">
                <thead className="border-b border-stone-100 text-[11px] text-stone-400 uppercase tracking-[0.18em]">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <Checkbox
                        checked={allCurrentSelected}
                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                      />
                    </th>
                    <th className="w-56 px-4 py-3">token</th>
                    <th className="w-28 px-4 py-3">类型</th>
                    <th className="w-24 px-4 py-3">来源</th>
                    <th className="w-24 px-4 py-3">状态</th>
                    <th className="w-56 px-4 py-3">账号信息</th>
                    <th className="w-32 px-4 py-3">创建时间</th>
                    <th className="w-24 px-4 py-3">额度</th>
                    <th className="w-40 px-4 py-3">恢复时间</th>
                    <th className="w-18 px-4 py-3">在途</th>
                    <th className="w-18 px-4 py-3">成功</th>
                    <th className="w-18 px-4 py-3">失败</th>
                    <th className="w-24 px-4 py-3">操作</th>
                  </tr>
                </thead>
                <Reorder.Group as="tbody" axis="y" values={currentRows.map((account) => account.access_token)}
                  onReorder={(order) => {
                    const drag = dragRef.current;
                    if (!drag || isMoving) return;
                    const modes = new Map(pageRows.map((account) => [account.access_token, account.usage_mode === "monitor"]));
                    if (order.some((token, index) => modes.get(token) !== modes.get(drag.original[index]))) return;
                    drag.order = order;
                    setDragOrder(order);
                  }}
                >
                  {currentRows.map((account) => {
                    const status = statusMeta[account.status];
                    const StatusIcon = status.icon;
                    return (
                      <SortableAccountRow key={account.access_token} account={account}
                        disabled={isMoving || isRefreshing || isRelogining || isDeleting || isUpdating}
                        selected={selectedIds.includes(account.access_token)}
                        onSelect={(checked) => setSelectedIds((prev) => checked ? Array.from(new Set([...prev, account.access_token])) : prev.filter((item) => item !== account.access_token))}
                        onStart={() => {
                          const order = pageRows.map((item) => item.access_token);
                          dragRef.current = { token: account.access_token, original: order, order };
                          setDragOrder(order);
                        }}
                        onEnd={() => void finishDrag()}
                        onMove={async (direction) => {
                          const group = filteredAccounts.filter((item) => (item.usage_mode === "monitor") === (account.usage_mode === "monitor"));
                          const target = group[group.indexOf(account) + direction];
                          if (target) await handleMove(account.access_token, target, direction < 0 ? "before" : "after");
                        }}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium tracking-tight text-stone-700">
                              {maskToken(account.access_token)}
                            </span>
                            <button
                              type="button"
                              className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => {
                                void navigator.clipboard.writeText(account.access_token);
                                toast.success("token 已复制");
                              }}
                            >
                              <Copy className="size-4" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="rounded-md bg-stone-100 text-stone-700">
                            {displayAccountType(account)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="rounded-md border-stone-200 text-stone-600">
                            {displayAccountSource(account)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={status.badge}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1"
                          >
                            <StatusIcon className="size-3.5" />
                            {account.status}
                          </Badge>
                          {account.usage_mode !== "normal" && (
                            <Badge variant="outline" className="mt-1 inline-flex items-center gap-1 whitespace-nowrap" title="继续刷新额度、监测和保活，不参与生图、文本或搜索消费">
                              {account.usage_mode === "monitor" ? <Eye className="size-3.5" /> : <Ban className="size-3.5" />}
                              {account.usage_mode === "monitor" ? "仅监控" : "禁用"}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-xs leading-5 text-stone-500">{account.email ?? "—"}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs leading-5 text-stone-500">
                          {formatBeijingDateTime(account.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="info" className="rounded-md">
                            {formatQuota(account)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs leading-5 text-stone-500">
                          {(() => {
                            const restore = formatRestoreAt(account.restore_at);
                            return (
                              <div className="space-y-0.5">
                                {restore.relative ? <div className="font-medium text-stone-700">{restore.relative}</div> : null}
                                <div className="whitespace-nowrap">{restore.absolute}</div>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const inflight = account.image_inflight ?? 0;
                            return (
                              <span
                                className={
                                  inflight > 0
                                    ? "font-semibold text-amber-600"
                                    : "text-stone-400"
                                }
                                title={
                                  inflight > 0
                                    ? "当前正在生成的图片数。号池空闲时此值持续 > 0，说明并发槽位泄漏、该账号已被静默排除出调度"
                                    : "当前无在途生图任务"
                                }
                              >
                                {inflight}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3 text-stone-500">{account.success}</td>
                        <td className="px-4 py-3 text-stone-500">{account.fail}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 text-stone-400">
                            <button
                              type="button"
                              aria-label="编辑账号"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => openEditDialog(account)}
                              disabled={isUpdating}
                            >
                              <Pencil className="size-4" />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => void handleRefreshAccounts([account.access_token])}
                              aria-label="刷新账号"
                              disabled={isRefreshing || refreshingTokens.has(account.access_token)}
                            >
                              <RefreshCw className={cn("size-4", (isRefreshing || refreshingTokens.has(account.access_token)) ? "animate-spin" : "")} />
                            </button>
                            <button
                              type="button"
                              aria-label="删除账号"
                              title="删除账号"
                              className="rounded-lg p-2 transition hover:bg-rose-50 hover:text-rose-600"
                              onClick={() => setDeleteTargets([account])}
                              disabled={isDeleting || isMoving}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        </td>
                      </SortableAccountRow>
                    );
                  })}
                </Reorder.Group>
              </table>

              {!isLoading && currentRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <Search className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">没有匹配的账户</p>
                    <p className="text-sm text-stone-500">调整筛选条件或搜索关键字后重试。</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                显示第 {filteredAccounts.length === 0 ? 0 : startIndex + 1} -{" "}
                {Math.min(startIndex + Number(pageSize), filteredAccounts.length)} 条，共{" "}
                {filteredAccounts.length} 条
                </div>

                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                    try { window.localStorage.setItem(ACCOUNT_PAGE_SIZE_KEY, value); }
                    catch { toast.error("每页条数已切换，但浏览器未能保存设置"); }
                  }}
                >
                  <SelectTrigger aria-label="账号每页条数" className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 / 页</SelectItem>
                    <SelectItem value="20">20 / 页</SelectItem>
                    <SelectItem value="50">50 / 页</SelectItem>
                    <SelectItem value="100">100 / 页</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-stone-400">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

export default function AccountsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <AccountsPageContent />;
}
