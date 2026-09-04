interface TerminalBrowserErrorBannersProps {
  errors: Array<string | null | undefined>;
}

export function TerminalBrowserErrorBanners({
  errors,
}: TerminalBrowserErrorBannersProps) {
  return (
    <>
      {errors.map((error, index) =>
        error ? (
          <div
            key={`${index}-${error}`}
            className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300"
          >
            {error}
          </div>
        ) : null,
      )}
    </>
  );
}
