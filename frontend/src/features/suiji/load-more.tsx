import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Button } from "../../components/ui/button";

type LoadMoreOptions = {
  active: boolean;
  disabled: boolean;
  loading: boolean;
  cursor: string | null;
  load: (more?: boolean) => Promise<void>;
};

export function useLoadMore({
  active,
  disabled,
  loading,
  cursor,
  load,
}: LoadMoreOptions) {
  const scrollContainer = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const requestedCursor = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = scrollContainer.current;
    const target = trigger.current;
    if (!active || disabled || loading || !cursor || failed || !root || !target)
      return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        observer.disconnect();
        void load(true);
      }
    }, { root, rootMargin: "0px 0px 200px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active, disabled, loading, cursor, failed, scrollContainer, trigger, load]);

  return {
    failed,
    scrollContainer,
    trigger,
    begin: (more: boolean, currentCursor: string | null, isLoading: boolean) => {
      if (
        more &&
        (!currentCursor || isLoading || requestedCursor.current === currentCursor)
      ) return false;
      requestedCursor.current = more ? currentCursor : null;
      setFailed(false);
      return true;
    },
    fail: (more: boolean) => {
      if (more) {
        requestedCursor.current = null;
        setFailed(true);
      }
    },
  };
}

export function LoadMoreTrigger({
  cursor,
  failed,
  loading,
  trigger,
  onRetry,
}: {
  cursor: string | null;
  failed: boolean;
  loading: boolean;
  trigger: RefObject<HTMLDivElement | null>;
  onRetry: () => void;
}) {
  return (
    <div ref={trigger} className="flex min-h-px justify-center gap-3">
      {cursor && failed ? (
        <Button variant="outline" disabled={loading} onClick={onRetry}>
          重试加载
        </Button>
      ) : null}
    </div>
  );
}
