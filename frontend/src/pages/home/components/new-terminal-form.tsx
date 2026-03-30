import { Button } from "../../../components/ui/button";

interface NewTerminalFormProps {
  command: string;
  args: string;
  cwd: string;
  loading: boolean;
  error: string | null;
  onCommandChange: (value: string) => void;
  onArgsChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onSubmit: () => void;
}

export function NewTerminalForm({
  command,
  args,
  cwd,
  loading,
  error,
  onCommandChange,
  onArgsChange,
  onCwdChange,
  onSubmit,
}: NewTerminalFormProps) {
  return (
    <section className="rounded-[1.5rem] border border-border/60 bg-background/65 p-4 backdrop-blur-xl sm:p-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
          New Terminal
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3">
          <label className="block text-sm font-medium text-foreground" htmlFor="terminal-command">
            Terminal command
          </label>
          <input
            id="terminal-command"
            aria-label="Terminal command"
            value={command}
            onChange={(event) => onCommandChange(event.target.value)}
            disabled={loading}
            className="mt-3 h-10 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 text-sm outline-none placeholder:text-muted-foreground/55"
            placeholder="Leave empty for default shell"
          />
        </div>

        <div className="rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3">
          <label className="block text-sm font-medium text-foreground" htmlFor="terminal-args">
            Terminal args
          </label>
          <input
            id="terminal-args"
            aria-label="Terminal args"
            value={args}
            onChange={(event) => onArgsChange(event.target.value)}
            disabled={loading}
            className="mt-3 h-10 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 text-sm outline-none placeholder:text-muted-foreground/55"
            placeholder="-l"
          />
        </div>

        <div className="rounded-[1rem] border border-border/60 bg-card/75 px-3 py-3">
          <label className="block text-sm font-medium text-foreground" htmlFor="terminal-cwd">
            Terminal cwd
          </label>
          <input
            id="terminal-cwd"
            aria-label="Terminal cwd"
            value={cwd}
            onChange={(event) => onCwdChange(event.target.value)}
            disabled={loading}
            className="mt-3 h-10 w-full rounded-[0.9rem] border border-border/60 bg-background/70 px-3 text-sm outline-none placeholder:text-muted-foreground/55"
            placeholder="Leave empty for user home"
          />
        </div>

        <Button
          className="h-10 w-full rounded-full text-[13px] font-medium"
          onClick={onSubmit}
          disabled={loading}
        >
          {loading ? "Opening..." : "Open Terminal"}
        </Button>

        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
