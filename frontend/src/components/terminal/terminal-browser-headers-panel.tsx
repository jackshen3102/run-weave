import { Braces, Check, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  TERMINAL_BROWSER_DEFAULT_HEADER_URL_PATTERN,
  TERMINAL_BROWSER_HEADER_RULE_LIMIT,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderRuleField,
  validateTerminalBrowserHeaderRule,
} from "@browser-viewer/shared";
import { Button } from "../ui/button";

type HeaderRuleErrors = Partial<Record<TerminalBrowserHeaderRuleField, string>>;

interface TerminalBrowserHeadersButtonProps {
  open: boolean;
  rules: TerminalBrowserHeaderRule[];
  onOpenChange: (open: boolean) => void;
}

interface TerminalBrowserHeadersPanelProps {
  open: boolean;
  rules: TerminalBrowserHeaderRule[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (rules: TerminalBrowserHeaderRule[]) => Promise<boolean>;
  onReload: () => void;
}

function createRule(): TerminalBrowserHeaderRule {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    enabled: true,
    operation: "set",
    name: "",
    value: "",
    urlPattern: TERMINAL_BROWSER_DEFAULT_HEADER_URL_PATTERN,
  };
}

function validateRules(
  rules: TerminalBrowserHeaderRule[],
): Record<string, HeaderRuleErrors> {
  const errors: Record<string, HeaderRuleErrors> = {};
  for (const rule of rules) {
    const result = validateTerminalBrowserHeaderRule(rule);
    if (!result.rule) {
      errors[rule.id] = result.fieldErrors;
    }
  }
  return errors;
}

function firstRuleError(errors: HeaderRuleErrors): string | null {
  return Object.values(errors)[0] ?? null;
}

export function TerminalBrowserHeadersButton({
  open,
  rules,
  onOpenChange,
}: TerminalBrowserHeadersButtonProps) {
  const enabledRuleCount = useMemo(
    () => rules.filter((rule) => rule.enabled).length,
    [rules],
  );

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={[
        "relative h-7 w-7 rounded-md px-0",
        open || enabledRuleCount > 0
          ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/20 hover:text-sky-200"
          : "",
      ].join(" ")}
      aria-label={
        open ? "Close browser headers panel" : "Open browser headers panel"
      }
      title={
        open ? "Close browser headers panel" : "Open browser headers panel"
      }
      onClick={() => onOpenChange(!open)}
    >
      <Braces className="h-4 w-4" />
      {enabledRuleCount > 0 ? (
        <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-sky-400 px-1 text-[9px] leading-none font-semibold text-slate-950">
          {enabledRuleCount}
        </span>
      ) : null}
    </Button>
  );
}

export function TerminalBrowserHeadersPanel({
  open,
  rules,
  saving,
  error,
  onClose,
  onSave,
  onReload,
}: TerminalBrowserHeadersPanelProps) {
  const [draftRules, setDraftRules] =
    useState<TerminalBrowserHeaderRule[]>(rules);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, HeaderRuleErrors>
  >({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraftRules(rules);
      setFieldErrors({});
      setSaved(false);
    }
  }, [open, rules]);

  const updateRule = (
    id: string,
    updates: Partial<TerminalBrowserHeaderRule>,
  ): void => {
    setSaved(false);
    setDraftRules((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...updates } : rule)),
    );
  };

  const addRule = (): void => {
    setSaved(false);
    setDraftRules((current) =>
      current.length >= TERMINAL_BROWSER_HEADER_RULE_LIMIT
        ? current
        : [...current, createRule()],
    );
  };

  const removeRule = (id: string): void => {
    setSaved(false);
    setDraftRules((current) => current.filter((rule) => rule.id !== id));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const saveRules = async (): Promise<void> => {
    const nextErrors = validateRules(draftRules);
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setSaved(false);
      return;
    }

    const didSave = await onSave(draftRules);
    setSaved(didSave);
  };

  if (!open) {
    return null;
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-10 flex w-[320px] flex-col border-l border-slate-800 bg-slate-950">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-slate-800 px-3">
        <p className="text-xs font-medium text-slate-200">Headers</p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 rounded-md px-2 text-xs"
            disabled={draftRules.length >= TERMINAL_BROWSER_HEADER_RULE_LIMIT}
            onClick={addRule}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 rounded-md px-0"
            aria-label="Close browser headers panel"
            title="Close browser headers panel"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {draftRules.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-700 px-3 py-5 text-center text-xs text-slate-500">
            No header rules
          </div>
        ) : null}
        {draftRules.map((rule, index) => {
          const ruleErrors = fieldErrors[rule.id] ?? {};
          return (
            <div
              key={rule.id}
              className="space-y-2 border-b border-slate-800 pb-3 last:border-b-0 last:pb-0"
            >
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900"
                    checked={rule.enabled}
                    onChange={(event) =>
                      updateRule(rule.id, { enabled: event.target.checked })
                    }
                  />
                  <span>#{index + 1}</span>
                </label>
                <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                  SET
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 w-7 rounded-md px-0 text-slate-400 hover:text-rose-300"
                  aria-label="Delete header rule"
                  title="Delete header rule"
                  onClick={() => removeRule(rule.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="space-y-2">
                <label className="space-y-1">
                  <span className="text-[10px] font-medium text-slate-500">
                    Header
                  </span>
                  <input
                    className={[
                      "h-8 w-full rounded-md border bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-500",
                      ruleErrors.name ? "border-rose-700" : "border-slate-800",
                    ].join(" ")}
                    value={rule.name}
                    onChange={(event) =>
                      updateRule(rule.id, { name: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] font-medium text-slate-500">
                    Value
                  </span>
                  <input
                    className={[
                      "h-8 w-full rounded-md border bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-500",
                      ruleErrors.value ? "border-rose-700" : "border-slate-800",
                    ].join(" ")}
                    value={rule.value}
                    onChange={(event) =>
                      updateRule(rule.id, { value: event.target.value })
                    }
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-[10px] font-medium text-slate-500">
                  URL pattern
                </span>
                <input
                  className={[
                    "h-8 w-full rounded-md border bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-500",
                    ruleErrors.urlPattern
                      ? "border-rose-700"
                      : "border-slate-800",
                  ].join(" ")}
                  value={rule.urlPattern}
                  onChange={(event) =>
                    updateRule(rule.id, { urlPattern: event.target.value })
                  }
                />
              </label>

              {firstRuleError(ruleErrors) ? (
                <p className="text-xs text-rose-400">
                  {firstRuleError(ruleErrors)}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 space-y-2 border-t border-slate-800 p-3">
        {error ? <p className="text-xs text-rose-400">{error}</p> : null}
        {saved && !error ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-2 py-1.5">
            <p className="text-xs text-emerald-300">Saved</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs"
              onClick={onReload}
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" />
              Reload
            </Button>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-md px-3 text-xs"
            onClick={() => setDraftRules(rules)}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-md px-3 text-xs"
            disabled={saving}
            onClick={() => void saveRules()}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>
    </aside>
  );
}
