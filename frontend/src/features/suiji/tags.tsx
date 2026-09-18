import { useState } from "react";
import { normalizeSuijiTags } from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const colors = [
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  "bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-200",
  "bg-pink-100 text-pink-900 dark:bg-pink-950 dark:text-pink-200",
  "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
];
function tagColor(tag: string) {
  let hash = 0;
  for (const scalar of tag)
    hash = (hash * 31 + scalar.codePointAt(0)!) % colors.length;
  return colors[hash];
}
export function RecordTags({
  tags = [],
  onSelect,
}: {
  tags?: string[];
  onSelect?: (tag: string) => void;
}) {
  return tags.length ? (
    <div className="relative flex flex-wrap gap-2">
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag}
            type="button"
            className={`rounded-full px-2.5 py-1 text-xs break-all ${tagColor(tag)}`}
            aria-label={`筛选标签：${tag}`}
            onClick={() => onSelect(tag)}
          >
            {tag}
          </button>
        ) : (
          <span
            key={tag}
            className={`rounded-full px-2.5 py-1 text-xs break-all ${tagColor(tag)}`}
          >
            {tag}
          </span>
        ),
      )}
    </div>
  ) : null;
}

export function TagEditor({
  selected = [],
  available,
  onChange,
}: {
  selected?: string[];
  available: string[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const add = (name: string) => {
    try {
      onChange(normalizeSuijiTags([...selected, name]));
      setQuery("");
      setError("");
      setOpen(false);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-label={`移除标签：${tag}`}
            className={`rounded-full px-2.5 py-1 text-sm break-all ${tagColor(tag)}`}
            onClick={() => {
              onChange(selected.filter((item) => item !== tag));
              setError("");
            }}
          >
            {tag} ×
          </button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selected.length >= 2}
          onClick={() => setOpen(!open)}
        >
          ＋标签
        </Button>
        {selected.length >= 2 ? (
          <span className="text-xs text-muted-foreground">最多 2 个标签</span>
        ) : null}
      </div>
      {open && selected.length < 2 ? (
        <div className="flex flex-col gap-2 rounded-xl border p-3">
          <Input
            aria-label="标签名称"
            placeholder="搜索或创建标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                add(query);
              }
            }}
          />
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {available
              .filter(
                (tag) => !selected.includes(tag) && tag.includes(query.trim()),
              )
              .map((tag) => (
                <Button
                  type="button"
                  key={tag}
                  variant="outline"
                  size="sm"
                  onClick={() => add(tag)}
                >
                  {tag}
                </Button>
              ))}
          </div>
          {query.trim() && !available.includes(query.trim()) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => add(query)}
            >
              创建「{query.trim()}」
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TagFilter({
  available,
  selected,
  onSelect,
}: {
  available: string[];
  selected: string;
  onSelect: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const recent = available.slice(0, 5);
  if (selected && !recent.includes(selected)) recent.push(selected);
  if (!recent.length) return null;
  const choose = (tag: string) => {
    onSelect(tag === selected ? "" : tag);
    setOpen(false);
    setQuery("");
  };
  return (
    <div className="mb-4 flex flex-col gap-2" aria-label="标签筛选">
      <div className="flex flex-wrap gap-2">
        {recent.map((tag) => (
          <Button
            key={tag}
            type="button"
            size="sm"
            variant={selected === tag ? "default" : "outline"}
            aria-pressed={selected === tag}
            onClick={() => choose(tag)}
          >
            {tag}
            {selected === tag ? " ×" : ""}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          更多标签
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-2 rounded-xl border p-3">
          <Input
            aria-label="搜索标签"
            placeholder="搜索已有标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
            {available
              .filter((tag) => tag.includes(query.trim()))
              .map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  size="sm"
                  variant={selected === tag ? "default" : "outline"}
                  onClick={() => choose(tag)}
                >
                  {tag}
                </Button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
