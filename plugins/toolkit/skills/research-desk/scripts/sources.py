"""Bounded discovery and complete primary-text collection, without browser credentials."""
import datetime as dt
from email.utils import parsedate_to_datetime
import io
import itertools
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from storage import ResearchError, digest, encoded, freeze, now

ATOM = {"a": "http://www.w3.org/2005/Atom"}
MAX_BYTES = 30 * 1024 * 1024


def fetch(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ResearchError("来源须为不含凭据的HTTP(S) URL")
    request = urllib.request.Request(url, headers={"User-Agent": "RunweaveResearchDesk/1.0"})
    with urllib.request.urlopen(request, timeout=40) as response:
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ResearchError("来源超过30MiB读取上限")
        return raw, response.geturl(), response.headers.get("Content-Type", "")


def paper_id(url):
    match = re.match(r"^https?://(?:export\.)?arxiv\.org/(?:abs|html|pdf)/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)(?:\.pdf)?(?:[?#].*)?$", url)
    return match[1] if match else None


def canonical(url):
    ident = paper_id(url)
    if ident:
        return "https://arxiv.org/abs/" + re.sub(r"v\d+$", "", ident)
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(parts.query)
                                   if not k.startswith("utm_") and k not in {"ref", "from"}])
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), query, ""))


def date(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (ValueError, TypeError):
            return None
    return parsed.replace(tzinfo=parsed.tzinfo or dt.timezone.utc).astimezone(dt.timezone.utc)


def matches(config, text):
    return any(word.casefold() in text.casefold() for word in config["keywords"])


def discover(config, run, window):
    start, end = date(window["start"]), date(window["end"])
    queues, coverage = [], []
    for index, source in enumerate(config["sources"]):
        rows = []
        try:
            kind = source["kind"]
            if kind == "url":
                rows = [{"url": source["url"], "title": source.get("title", source["url"]),
                         "published_at": None, "date_basis": "explicit_user_source"}]
                raw = encoded(rows)
            else:
                url = source["url"] if kind != "arxiv" else "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({
                    "search_query": "(" + " OR ".join('all:"' + word.replace('"', '') + '"' for word in config["keywords"]) + ") AND submittedDate:[" + start.strftime("%Y%m%d%H%M") + " TO " + end.strftime("%Y%m%d%H%M") + "]",
                    "start": 0, "max_results": config["candidate_limit"], "sortBy": "submittedDate", "sortOrder": "descending"})
                raw, _, _ = fetch(url)
                xml = ET.fromstring(raw)
                if kind == "arxiv":
                    for entry in xml.findall("a:entry", ATOM):
                        rows.append({"url": entry.findtext("a:id", "", ATOM).replace("http:", "https:"),
                                     "title": " ".join(entry.findtext("a:title", "", ATOM).split()),
                                     "abstract": entry.findtext("a:summary", "", ATOM),
                                     "published_at": entry.findtext("a:published", "", ATOM),
                                     "doi": entry.findtext("{http://arxiv.org/schemas/atom}doi"), "date_basis": "publication"})
                elif kind == "rss":
                    for entry in xml.findall(".//item") + xml.findall("a:entry", ATOM):
                        fields = {child.tag.split("}")[-1]: child.text for child in entry}
                        link = fields.get("link") or fields.get("id")
                        atom_link = entry.find("a:link", ATOM)
                        if atom_link is not None:
                            link = atom_link.get("href")
                        if link:
                            rows.append({"url": link, "title": fields.get("title") or link,
                                         "abstract": fields.get("description") or fields.get("summary") or "",
                                         "published_at": fields.get("pubDate") or fields.get("published") or fields.get("date"),
                                         "date_basis": "publication"})
                else:
                    # One sitemap only; sitemap indexes are disclosed, never recursively crawled.
                    for entry in xml.findall("{*}url"):
                        loc = entry.findtext("{*}loc", "")
                        if matches(config, loc.replace("-", " ").replace("_", " ")):
                            rows.append({"url": loc, "title": loc, "published_at": None,
                                         "date_basis": "unverified_sitemap", "last_modified": entry.findtext("{*}lastmod")})
            freeze(run / "discovery" / (str(index) + "-" + digest(raw) + ".raw"), raw)
            qualified = []
            for row in rows:
                published = date(row["published_at"])
                if row["date_basis"] == "publication" and (not published or not start <= published <= end):
                    continue
                if kind not in {"url", "sitemap"} and not matches(config, row["title"] + " " + row.get("abstract", "")):
                    continue
                row["canonical_url"] = canonical(row["url"])
                row["discovery_source"] = source
                qualified.append(row)
            qualified.sort(key=lambda row: row.get("published_at") or "", reverse=True)
            queues.append(qualified)
            coverage.append({"source": source, "returned": len(rows), "qualified": len(qualified),
                             "status": "read", "limit": "API/feed/sitemap返回范围，不代表全量覆盖；站点地图修改日不作发表日。"})
        except (OSError, ValueError, ET.ParseError, ResearchError) as error:
            coverage.append({"source": source, "status": "unavailable", "reason": str(error)})
    candidates, urls, dois = [], set(), set()
    for group in itertools.zip_longest(*queues):
        for row in group:
            if row is None or row["canonical_url"] in urls or (row.get("doi") and row["doi"] in dois):
                continue
            urls.add(row["canonical_url"])
            if row.get("doi"):
                dois.add(row["doi"])
            candidates.append(row)
            if len(candidates) == config["candidate_limit"]:
                return {"start": start.isoformat(), "end": end.isoformat(), "coverage": coverage, "candidates": candidates}
    return {"start": start.isoformat(), "end": end.isoformat(), "coverage": coverage, "candidates": candidates}


def extract(config, candidate, topic, window):
    url = candidate["url"]
    ident = paper_id(url)
    extraction = "full_main_text"
    if ident:
        url = "https://arxiv.org/html/" + ident
    try:
        raw, fetched_url, content_type = fetch(url)
        soup = BeautifulSoup(raw, "html.parser")
        node = soup.select_one("article.ltx_document") if ident else (
            soup.select_one(".text-rich-text-v2-blog-post") or soup.find("article") or soup.find("main"))
        if node is None:
            raise ResearchError("未找到完整正文容器，不将摘要或页面壳当作全文")
        if not ident:
            published = None
            for script in soup.select('script[type="application/ld+json"]'):
                try:
                    import json
                    obj = json.loads(script.string or script.get_text())
                    for entry in obj if isinstance(obj, list) else [obj]:
                        if isinstance(entry, dict) and date(entry.get("datePublished")) is not None:
                            published = entry["datePublished"]
                except ValueError:
                    continue
            published = published or candidate.get("published_at")
            stamp = date(published)
            if candidate["date_basis"] != "explicit_user_source" and (not stamp or not date(window["start"]) <= stamp <= date(window["end"])):
                raise ResearchError("无法确认窗口内发表日期；未使用lastmod替代")
            candidate = dict(candidate, published_at=published if stamp else None)
        title = soup.find("h1")
        title = title.get_text(" ", strip=True) if title else candidate["title"]
        for child in node.select("script, style, nav, footer, .ltx_page_footer"):
            child.decompose()
        for math in node.select("math"):
            tex = math.find("annotation", attrs={"encoding": "application/x-tex"})
            if tex:
                math.replace_with(" $" + tex.get_text(" ", strip=True) + "$ ")
        for table in node.select("table"):
            rows = [" | ".join(cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"], recursive=False)) for row in table.select("tr")]
            table.replace_with("\n" + "\n".join(rows) + "\n")
        text = node.get_text("\n", strip=True)
        suffix = ".html"
    except (OSError, ResearchError) as error:
        if not ident:
            raise
        raw, fetched_url, content_type = fetch("https://arxiv.org/pdf/" + ident)
        try:
            reader = PdfReader(io.BytesIO(raw))
            text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        except PdfReadError as error:
            raise ResearchError("官方PDF无法完整抽取: " + str(error)) from error
        title, suffix, extraction = candidate["title"], ".pdf", "full_pdf_text"
    text = text.strip() + "\n"
    if not 1000 <= len(text) <= config["max_source_chars"]:
        raise ResearchError("完整正文过短或超过上限，跳过而不截断: " + str(len(text)))
    key = digest(raw + b"\n" + text.encode())
    base = topic / "collection" / key
    raw_sha = freeze(base / ("original" + suffix), raw)
    text_sha = freeze(base / "original.md", text.encode())
    result = dict(candidate, title=title, text_sha256=text_sha, raw_sha256=raw_sha,
                  raw_path=str((base / ("original" + suffix)).relative_to(topic)),
                  text_path=str((base / "original.md").relative_to(topic)), collected_at=now(),
                  fetched_url=fetched_url, coverage=extraction,
                  limits="完整文字抽取，不含图像像素；抽取不等于独立复现实验。")
    return result
