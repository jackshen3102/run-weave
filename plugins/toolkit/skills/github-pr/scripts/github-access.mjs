// Keep command output private: gh and proxy errors can contain credentials.
function result(value, timeout = "check_timeout") {
  let reason = value.error;
  const message = value.stderr;
  if (reason === "timeout") reason = timeout;
  else if (reason === "ENOENT") reason = "cli_unavailable";
  else if (/rate limit/i.test(message)) reason = "rate_limited";
  else if (/HTTP 401|Bad credentials|token.*(?:invalid|expired)/i.test(message))
    reason = "authentication_rejected";
  else if (/407|proxy authentication/i.test(message))
    reason = "proxy_authentication_rejected";
  else if (/HTTP 403/i.test(message)) reason = "access_denied";
  else if (/HTTP 404|Could not resolve to a Repository/i.test(message))
    reason = "repository_unavailable";
  else if (/HTTP 5\d\d/i.test(message)) reason = "api_unavailable";
  else if (/not logged/i.test(message)) reason = "account_unconfigured";
  else if (/no oauth token|no token/i.test(message))
    reason = "credential_missing";
  else if (/resolve host|no such host|ENOTFOUND/i.test(message))
    reason = "dns_failure";
  else if (/certificate|TLS handshake|SSL/i.test(message))
    reason = "tls_failure";
  else if (/timeout|timed out|context deadline/i.test(message))
    reason = timeout;
  else if (/connect|connection|network|proxy/i.test(message))
    reason = "connection_failure";
  else if (value.status === "failed" && /^\d+$/.test(reason ?? ""))
    reason = "command_failed";
  return { status: value.status, exitCode: value.exitCode, error: reason };
}

function proxyEnvironment(proxy) {
  if (!proxy) return null;
  let url;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(
      "Fallback proxy must be an HTTP(S) URL without credentials.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Fallback proxy must be an HTTP(S) URL without credentials.",
    );
  return {
    HTTP_PROXY: url.href,
    HTTPS_PROXY: url.href,
    http_proxy: url.href,
    https_proxy: url.href,
    NO_PROXY: "",
    no_proxy: "",
  };
}

async function network(run, env, gitHttps) {
  const values = await Promise.all(
    (gitHttps ? ["api.github.com", "github.com"] : ["api.github.com"]).map(
      async (host) => {
        const probe = await run(
          "curl",
          [
            "--disable",
            "--silent",
            "--show-error",
            "--head",
            "--connect-timeout",
            "5",
            "--max-time",
            "8",
            "--write-out",
            "\n%{http_code}",
            `https://${host}/`,
          ],
          [0],
          { env, timeout: 10_000 },
        );
        const value = result(probe, "network_timeout");
        // A real HTTP response proves connectivity, even when the server rejects HEAD.
        const httpStatus = Number(probe.stdout.trim().split("\n").at(-1));
        if (probe.exitCode === 28) value.error = "network_timeout";
        if (probe.exitCode === 5 || probe.exitCode === 6)
          value.error = "dns_failure";
        if (probe.exitCode === 35 || probe.exitCode === 60)
          value.error = "tls_failure";
        if (probe.exitCode === 0 && httpStatus >= 100 && httpStatus <= 599)
          value.httpStatus = httpStatus;
        else if (value.status === "ok") {
          value.status = "failed";
          value.error = "invalid_http_response";
        }
        if (value.error === "cli_unavailable") value.status = "skipped";
        return [host, value];
      },
    ),
  );
  const hosts = Object.fromEntries(values);
  const failed = values.find(([, value]) => value.status === "failed");
  return {
    status: failed
      ? "failed"
      : values.every(([, value]) => value.status === "skipped")
        ? "skipped"
        : "ok",
    error: failed?.[1].error ?? null,
    hosts,
  };
}

async function accountChecks(run, env, repository) {
  const [auth, account, access] = await Promise.all([
    run("gh", ["auth", "status", "--active", "--hostname", "github.com"], [0], {
      env,
    }),
    run(
      "gh",
      ["api", "--hostname", "github.com", "user", "--jq", ".login"],
      [0],
      { env },
    ),
    run(
      "gh",
      [
        "repo",
        "view",
        repository,
        "--json",
        "nameWithOwner,viewerPermission,defaultBranchRef",
      ],
      [0],
      { env },
    ),
  ]);
  const checks = {
    auth: result(auth),
    account: {
      ...result(account, "api_timeout"),
      login: account.status === "ok" ? account.stdout : null,
    },
    repositoryAccess: result(access, "api_timeout"),
  };
  // gh auth status can label a token invalid when its validation cannot connect.
  if (
    checks.auth.error === "authentication_rejected" &&
    checks.account.status === "failed" &&
    (retryable.has(checks.account.error) ||
      ["dns_failure", "tls_failure"].includes(checks.account.error))
  )
    checks.auth.error = checks.account.error;
  if (access.status === "ok") {
    try {
      checks.repositoryAccess.details = JSON.parse(access.stdout);
    } catch {
      checks.repositoryAccess.status = "failed";
      checks.repositoryAccess.error = "invalid_json";
    }
  }
  return checks;
}

function skipped(reason) {
  return Object.fromEntries(
    ["auth", "account", "repositoryAccess"].map((key) => [
      key,
      { status: "skipped", reason },
    ]),
  );
}

const retryable = new Set([
  "network_timeout",
  "api_timeout",
  "check_timeout",
  "connection_failure",
  "api_unavailable",
]);

export async function githubAccess(
  run,
  env,
  repository,
  fallbackProxy,
  gitHttps,
) {
  // Validate before starting subprocesses, and never print a rejected proxy URL.
  const fallback = proxyEnvironment(fallbackProxy);
  const credentialProbe = run(
    "gh",
    ["auth", "token", "--hostname", "github.com"],
    [0],
    { timeout: 8_000 },
  ).then((token) => {
    const credential = result(token, "credential_read_timeout");
    credential.readable = token.status === "ok" && Boolean(token.stdout.trim());
    if (credential.status === "ok" && !credential.readable) {
      credential.status = "failed";
      credential.error = "credential_missing";
    }
    return credential;
  });
  let connectionEnvironment = {};
  let checks;
  const attempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptEnv = { ...env, ...connectionEnvironment };
    const [connectivity, credential] = await Promise.all([
      network(run, attemptEnv, gitHttps),
      credentialProbe,
    ]);
    checks = {
      credential,
      // curl has its own TLS/proxy configuration; only gh checks can block gh access.
      network: {
        ...connectivity,
        status:
          connectivity.status === "failed" ? "warning" : connectivity.status,
      },
      ...(credential.status === "failed"
        ? skipped("credential_unavailable")
        : await accountChecks(run, attemptEnv, repository)),
    };
    attempts.push({
      route: Object.keys(connectionEnvironment).length
        ? "fallback_proxy"
        : "current",
      checks,
    });
    const failures = Object.values(checks).filter(
      (value) => value.status === "failed",
    );
    if (failures.length === 0 || credential.status === "failed") break;
    // Authentication/permission rejection must never cause proxy or account switching.
    if (
      failures.some((value) =>
        [
          "authentication_rejected",
          "access_denied",
          "repository_unavailable",
          "rate_limited",
          "proxy_authentication_rejected",
        ].includes(value.error),
      )
    )
      break;
    const connectivityFailure = failures.some(
      (value) =>
        retryable.has(value.error) ||
        ["dns_failure", "tls_failure"].includes(value.error),
    );
    if (!connectivityFailure || attempt === 2) break;
    if (fallback && Object.keys(connectionEnvironment).length === 0)
      connectionEnvironment = fallback;
    else if (!failures.every((value) => retryable.has(value.error))) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const failedCheck = Object.values(checks).find(
    (value) => value.status === "failed",
  );
  const failure =
    checks.credential.status === "failed"
      ? "credential_unavailable"
      : retryable.has(failedCheck?.error) ||
          ["dns_failure", "tls_failure"].includes(failedCheck?.error)
        ? "network_unavailable"
        : (failedCheck?.error ?? null);
  return {
    checks,
    recovery: {
      attempts,
      connectionEnvironment,
      gitTransport: gitHttps ? "https" : "ssh",
    },
    diagnosis: {
      cause: failure,
      guidance:
        failure === "network_unavailable"
          ? "GitHub connectivity failed. Credential readability is reported separately; a timeout does not prove missing credentials or a keyring failure. Use a configured working route for both git and gh."
          : failure === "credential_unavailable"
            ? "The local credential probe failed. Its error identifies missing credentials versus a read timeout; do not infer either from an API timeout."
            : failure
              ? "Inspect the classified failing checks; do not change accounts or request a new token solely because a check timed out."
              : "GitHub checks passed. Apply recovery.connectionEnvironment to subsequent git and gh commands when nonempty; it contains no GitHub token.",
    },
  };
}
