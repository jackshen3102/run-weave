"""Read-only Zhihu HTTP transport. Credentials remain in a private local file."""
import contextlib
import datetime as dt
from html.parser import HTMLParser
import http.client
import json
import re
import signal
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import suiji

ME = "https://www.zhihu.com/api/v4/me"
HISTORY = "https://api.zhihu.com/unify-consumption/read_history?offset=0&limit=20"
ALLOWED = re.compile(r"https://(?:api\.zhihu\.com/unify-consumption/read_history(?:\?[^#]*)?|www\.zhihu\.com/api/v4/(?:me|answers/\d+)(?:\?[^#]*)?|zhuanlan\.zhihu\.com/api/articles/\d+)")


def require(ok, code):
    if not ok:
        raise suiji.Failure(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


@contextlib.contextmanager
def request_timeout(seconds):
    # The macOS/POSIX collector runs requests on its main thread. A socket's
    # idle timeout alone cannot bound slow headers or a continuously read body.
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()

    def expired(signum, frame):
        raise TimeoutError("HTTP_REQUEST_TIMEOUT")

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, min(seconds, previous_timer[0]) if previous_timer[0] else seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, value):
        self.parts.append(value)

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("p", "div", "li", "h1", "h2", "h3", "blockquote"):
            self.parts.append("\n")


def plain(html):
    safe = re.sub(r"<(script|style|iframe|object|embed|video|audio)[\s\S]*?</\1\s*>", "", html, flags=re.I)
    safe = re.sub(r"<(img|source|link|meta)\b[^>]*>", "", safe, flags=re.I)
    parser = Text()
    parser.feed(safe)
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()


class Session:
    def __init__(self, auth, config):
        require(auth.get("schemaVersion") == 1, "INVALID_HTTP_SESSION")
        require(all(auth.get(k) == config[k] for k in ("machine", "profile", "externalAccountId")), "HTTP_SESSION_BINDING_CHANGED")
        require(config["machine"] == socket.gethostname(), "MACHINE_OR_ACCOUNT_BINDING_MISMATCH")
        require(isinstance(auth.get("cookies"), list) and isinstance(auth.get("userAgent"), str), "INVALID_HTTP_SESSION")
        self.auth = auth
        self.opener = urllib.request.build_opener(NoRedirect())
        self.deadline = time.monotonic() + 20 * 60
        self.requests = 0

    def request(self, url):
        require(isinstance(url, str) and ALLOWED.fullmatch(url), "UNTRUSTED_API_URL")
        require(time.monotonic() < self.deadline, "RUN_BUDGET_EXCEEDED")
        parsed = urllib.parse.urlsplit(url)
        cookies = []
        for cookie in self.auth["cookies"]:
            domain, path = cookie.get("domain", ""), cookie.get("path", "/")
            host_matches = parsed.hostname == domain or (domain.startswith(".") and (parsed.hostname == domain[1:] or parsed.hostname.endswith(domain)))
            path_matches = parsed.path == path or (parsed.path.startswith(path) and (path.endswith("/") or parsed.path[len(path):].startswith("/")))
            if host_matches and path_matches and (cookie.get("expires", -1) < 0 or cookie["expires"] > time.time()):
                cookies.append(cookie)
        require(any(c.get("name") == "z_c0" for c in cookies), "NEEDS_LOGIN")
        headers = {"Cookie": "; ".join(c["name"] + "=" + c["value"] for c in cookies), "User-Agent": self.auth["userAgent"],
                   "Accept": "application/json", "Referer": "https://www.zhihu.com/", "Origin": "https://www.zhihu.com"}
        for attempt in range(3):
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, "RUN_BUDGET_EXCEEDED")
            self.requests += 1
            try:
                with request_timeout(min(15, remaining)):
                    try:
                        response = self.opener.open(urllib.request.Request(url, headers=headers, method="GET"), timeout=min(15, remaining))
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        raw = response.read(10 * 1024 * 1024 + 1)
                        status = response.status
                    require(len(raw) <= 10 * 1024 * 1024, "API_RESPONSE_TOO_LARGE")
                    try:
                        data = json.loads(raw)
                    except (ValueError, UnicodeError):
                        data = None
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
                status, data = 0, None
            require(time.monotonic() <= self.deadline, "RUN_BUDGET_EXCEEDED")
            if (status == 0 or status == 429 or status >= 500) and attempt < 2:
                time.sleep(min(0.5 * (attempt + 1), max(0, self.deadline - time.monotonic())))
                continue
            return {"status": status, "data": data}

    def identity(self):
        result = self.request(ME)
        value = result["data"]
        require(result["status"] == 200 and isinstance(value, dict) and isinstance(value.get("id"), str) and value["id"],
                "NEEDS_LOGIN" if result["status"] in (401, 403) else "IDENTITY_UNAVAILABLE")
        return value["id"]

    def history(self, url):
        result = self.request(url)
        value = result["data"]
        require(result["status"] == 200 and isinstance(value, dict) and isinstance(value.get("data"), list)
                and isinstance(value.get("paging"), dict) and type(value["paging"].get("is_end")) is bool,
                "NEEDS_LOGIN" if result["status"] in (401, 403) else "HISTORY_UNAVAILABLE_OR_PARSE_FAILED")
        return value


def parse(card):
    require(isinstance(card, dict) and card.get("card_type") == "single_card" and isinstance(card.get("data"), dict), "UNKNOWN_HISTORY_STRUCTURE")
    value = card["data"]
    extra = value.get("extra")
    require(isinstance(extra, dict) and isinstance(extra.get("content_token"), str) and isinstance(extra.get("content_type"), str)
            and type(extra.get("read_time")) in (int, float), "UNKNOWN_HISTORY_STRUCTURE")
    stamp = extra["read_time"]
    occurred = dt.datetime.fromtimestamp(stamp / 1000 if stamp > 1e12 else stamp, dt.timezone.utc)
    title = value.get("header", {}).get("title") if isinstance(value.get("header"), dict) else None
    return {"type": extra["content_type"], "id": extra["content_token"], "occurredAt": occurred.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "day": occurred.astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat(), "questionId": extra.get("question_token"),
            "title": title if isinstance(title, str) else "知乎浏览内容"}


def signature(value):
    return [(item["type"], item["id"], item["occurredAt"]) for item in map(parse, value["data"])]


def content(session, item):
    supported = item["type"] in ("answer", "article") and re.fullmatch(r"[0-9]+", item["id"])
    if not supported:
        return "", "metadata-only", "unsupported-content-type"
    url = (f'https://www.zhihu.com/api/v4/answers/{item["id"]}?include=content,paid_info' if item["type"] == "answer"
           else f'https://zhuanlan.zhihu.com/api/articles/{item["id"]}')
    try:
        result = session.request(url)
        value = result["data"]
        if result["status"] == 200 and isinstance(value, dict) and str(value.get("id")) == item["id"] and isinstance(value.get("content"), str):
            body = plain(value["content"])
            if value.get("is_paid") is True and (value.get("paid_info") or {}).get("has_purchased") is not True:
                return body, "metadata-only", "paid-content-limited"
            return body, "available" if body else "metadata-only", None if body else "empty-content"
        return "", "metadata-only", "forbidden" if result["status"] == 403 else "not-found" if result["status"] == 404 else "content-unavailable-or-id-mismatch"
    except Exception:
        return "", "metadata-only", "content-timeout-or-parse-failed"


def collect(config, options):
    auth = json.loads(suiji.private_read(config["sessionFile"]))
    session = Session(auth, config)
    before = session.identity()
    require(before == config["externalAccountId"], "ACCOUNT_CHANGED")
    captured = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    observed, baseline_pages, errors = {}, {}, []
    pages, stable, baseline = 0, False, None
    for round_number in range(3):
        baseline_pages = {}
        next_url, first, complete, seen = HISTORY, None, False, set()
        for index in range(100):
            if next_url in seen:
                errors.append("PAGINATION_LOOP")
                break
            seen.add(next_url)
            try:
                value = session.history(next_url)
                current = signature(value)
            except Exception as error:
                if isinstance(error, suiji.Failure) and str(error) == "NEEDS_LOGIN":
                    raise
                errors.append(str(error) if isinstance(error, suiji.Failure) else "UNKNOWN_HISTORY_STRUCTURE")
                break
            baseline_pages[next_url] = current
            pages += 1
            if index == 0:
                first = current
                if baseline is None:
                    baseline = first
            if len(value["data"]) > 20:
                errors.append("PAGE_LIMIT_EXCEEDED")
                break
            for card in value["data"]:
                item = parse(card)
                if options["from"] <= item["day"] <= options["to"]:
                    observed[(item["type"], item["id"], item["occurredAt"])] = item
            if value["paging"]["is_end"]:
                complete = True
                break
            next_url = value["paging"].get("next")
            parsed = urllib.parse.urlsplit(next_url) if isinstance(next_url, str) else None
            if not parsed or not ALLOWED.fullmatch(next_url) or parsed.netloc != "api.zhihu.com" or urllib.parse.parse_qs(parsed.query).get("limit") != ["20"]:
                errors.append("UNTRUSTED_PAGINATION")
                break
            if index == 99:
                errors.append("PAGE_CAP_REACHED")
        try:
            if first is not None and signature(session.history(HISTORY)) == first:
                stable = complete
                break
        except Exception:
            errors.append("HOMEPAGE_RECHECK_FAILED")
            break
        if round_number == 2:
            errors.append("HISTORY_UNSTABLE")
    bodies, items = {}, []
    for item in observed.values():
        key = item["type"], item["id"]
        if key not in bodies:
            bodies[key] = content(session, item)
        body, state, reason = bodies[key]
        if reason not in (None, "unsupported-content-type", "paid-content-limited"):
            errors.append("CONTENT_" + reason.upper().replace("-", "_"))
        question = str(item.get("questionId") or "")
        url = (f'https://www.zhihu.com/question/{question}/answer/{item["id"]}' if item["type"] == "answer" and re.fullmatch(r"[0-9]+", question)
               else f'https://zhuanlan.zhihu.com/p/{item["id"]}' if item["type"] == "article" else None)
        items.append({"observation": {"contentType": item["type"], "contentId": item["id"], "readTime": item["occurredAt"], "observedAt": captured},
                      "entry": {"captureId": str(uuid.uuid4()), "browseDate": item["day"], "occurredAt": item["occurredAt"], "capturedAt": captured,
                                "title": item["title"], "body": body, "userNote": "", "source": {"provider": "zhihu", "displayName": "知乎", "connectionId": config["connectionId"]},
                                "contentType": item["type"], "captureMethod": "connector", "sourceUrl": url, "contentState": {"state": state, "reason": reason}, "attachmentIds": []}})
    after = session.identity()
    require(after == before, "ACCOUNT_CHANGED_DURING_RUN")
    unchanged = False
    try:
        unchanged = baseline == signature(session.history(HISTORY))
    except Exception:
        errors.append("HISTORY_RECHECK_FAILED")
    for url, previous in baseline_pages.items():
        try:
            if signature(session.history(url)) != previous:
                unchanged = False
        except Exception:
            unchanged = False
            errors.append("HISTORY_RECHECK_FAILED")
    if not unchanged:
        errors.append("HISTORY_CHANGED_DURING_CONTENT_READ")
    return {"identityBefore": before, "identityAfter": after, "items": items, "historyUnchanged": unchanged,
            "coverage": {"state": "complete" if stable and not errors else "partial", "pages": pages, "metadata": len(items),
                         "content": sum(i["entry"]["contentState"]["state"] == "available" for i in items), "errors": list(dict.fromkeys(errors))[:200]}}
