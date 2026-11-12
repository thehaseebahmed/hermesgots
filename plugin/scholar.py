"""The scholarly index a literature review searches (``research.py``): OpenAlex, over HTTPS.

It answers metadata and open-access links and nothing else: a paper's title, authors, year, venue,
DOI, type, the abstract the index holds and where an open copy of its text lives. No model is in
this step, which is what lets a review's reference list be the index's words and never a model's.

Checked against the live API on 2026-11-12: a work carries ``display_name``, ``doi`` (a full
``https://doi.org/`` address), ``publication_year``, ``type`` (``article``, ``preprint``, ...),
``authorships[].author.display_name``, ``primary_location`` and ``best_oa_location`` (each with
``is_oa``, ``landing_page_url``, ``pdf_url`` and ``source.display_name``) and the abstract only as
``abstract_inverted_index``, a map of each word to the positions it stands at. A request with no key
is charged to a small daily budget shared by everyone behind the caller's IP address and refused
with a 429 once that is spent, so a key is optional and its absence is named when it bites.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

NAME = "OpenAlex"
ENDPOINT = "https://api.openalex.org/works"
KEY_ENV = "OPENALEX_API_KEY"
TIMEOUT_S = 20
MAX_BYTES = 6 * 1024 * 1024
PER_QUERY = 25
MAX_AUTHORS = 30
MAX_ABSTRACT = 6000
SELECT = (
    "id,doi,display_name,publication_year,type,is_retracted,authorships,primary_location,"
    "best_oa_location,abstract_inverted_index"
)
# What a review reads: journal and conference papers and reviews, and preprints where they are let in.
TYPES = ("article", "review")
PREPRINT = "preprint"


class IndexError_(Exception):
    """The index couldn't be searched, in words a mission can show."""


def api_key() -> Optional[str]:
    """The profile's own index key, read the way every credential the plugin reads is: through
    Hermes's helper, never the process environment, so one profile's key never serves another."""
    try:
        from agent.credential_pool import get_env_prefer_dotenv
    except Exception:
        return None
    try:
        value = get_env_prefer_dotenv(KEY_ENV)
    except Exception:
        logger.debug("gots: couldn't read %s", KEY_ENV, exc_info=True)
        return None
    return value.strip() if isinstance(value, str) and value.strip() else None


def abstract_text(index: Any) -> str:
    """The abstract as text, rebuilt from the index's word-to-positions map."""
    if not isinstance(index, dict):
        return ""
    placed: List[Tuple[int, str]] = []
    for word, positions in index.items():
        if isinstance(word, str) and isinstance(positions, list):
            placed.extend((at, word) for at in positions if isinstance(at, int) and not isinstance(at, bool))
    placed.sort(key=lambda item: item[0])
    return " ".join(word for _at, word in placed)[:MAX_ABSTRACT]


def _http(url: Any) -> Optional[str]:
    if not isinstance(url, str):
        return None
    parsed = urllib.parse.urlparse(url)
    return url if parsed.scheme in ("http", "https") and parsed.netloc else None


def _doi(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", value.strip(), flags=re.I).lower()


def paper(work: Any) -> Optional[Dict[str, Any]]:
    """One work as the review keeps it, or None for a row with no title to cite it by."""
    if not isinstance(work, dict):
        return None
    title = work.get("display_name")
    if not isinstance(title, str) or not title.strip():
        return None
    primary = work.get("primary_location") if isinstance(work.get("primary_location"), dict) else {}
    best = work.get("best_oa_location") if isinstance(work.get("best_oa_location"), dict) else {}
    source = primary.get("source") if isinstance(primary.get("source"), dict) else {}
    authors = []
    for authorship in work.get("authorships") or []:
        author = authorship.get("author") if isinstance(authorship, dict) else None
        name = author.get("display_name") if isinstance(author, dict) else None
        if isinstance(name, str) and name.strip():
            authors.append(name.strip())
    year = work.get("publication_year")
    doi = _doi(work.get("doi"))
    open_copy = best.get("is_oa") is True
    # Where the paper is cited to: its DOI, else its page, else the index's own record of it.
    url = (f"https://doi.org/{doi}" if doi else None) or _http(primary.get("landing_page_url")) or _http(work.get("id"))
    if not url:
        return None
    return {
        "title": " ".join(title.split())[:300],
        "authors": authors[:MAX_AUTHORS],
        "more_authors": max(0, len(authors) - MAX_AUTHORS),
        "year": year if isinstance(year, int) and not isinstance(year, bool) else None,
        "venue": source.get("display_name").strip() if isinstance(source.get("display_name"), str) else "",
        "doi": doi,
        "url": url,
        "preprint": work.get("type") == PREPRINT,
        "abstract": abstract_text(work.get("abstract_inverted_index")),
        # Only a copy the index itself calls open is ever fetched: its page first, a PDF otherwise.
        "text_urls": [u for u in (_http(best.get("landing_page_url")), _http(best.get("pdf_url"))) if u] if open_copy else [],
    }


def search_url(query: str, from_year: Optional[int], to_year: Optional[int], preprints: bool) -> str:
    types = [*TYPES, *([PREPRINT] if preprints else [])]
    filters = [f"type:{'|'.join(types)}", "is_retracted:false"]
    if from_year:
        filters.append(f"from_publication_date:{from_year}-01-01")
    if to_year:
        filters.append(f"to_publication_date:{to_year}-12-31")
    params = {"search": query, "filter": ",".join(filters), "per-page": str(PER_QUERY), "select": SELECT}
    return f"{ENDPOINT}?{urllib.parse.urlencode(params)}"


def search(query: str, from_year: Optional[int] = None, to_year: Optional[int] = None,
           preprints: bool = True, key: Optional[str] = None) -> List[Dict[str, Any]]:
    """The index's best matches for one query, in its own order of relevance."""
    headers = {"Accept": "application/json", "User-Agent": "Gots research"}
    if key:
        # A header rather than the query, so the key is never part of an address that gets logged.
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(search_url(query, from_year, to_year, preprints), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            raw = response.read(MAX_BYTES)
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise IndexError_(
                f"{NAME}'s free daily budget for this network is used up. Add a free key as {KEY_ENV} "
                f"in the profile's .env, or try again after midnight UTC."
                if not key
                else f"{NAME} says this key's daily budget is used up. Try again after midnight UTC."
            ) from None
        if error.code in (401, 403):
            raise IndexError_(f"{NAME} refused the key in {KEY_ENV}. Check it, or remove it.") from None
        raise IndexError_(f"{NAME} answered {error.code} to the search.") from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise IndexError_(f"{NAME} couldn't be reached: {getattr(error, 'reason', error)}") from None
    try:
        body = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        raise IndexError_(f"{NAME} answered something that isn't JSON.") from None
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        raise IndexError_(f"{NAME} answered without a list of results.")
    return [found for found in (paper(work) for work in results) if found]


def _title_key(title: str) -> str:
    return " ".join(re.findall(r"\w+", title.casefold()))


def merge(lists: List[List[Dict[str, Any]]], limit: Optional[int] = None) -> Tuple[List[Dict[str, Any]], int]:
    """Every query's papers as one list and how many repeats were folded away: taken a rank at a
    time across the queries, so each query's best come first, and a paper seen before (by its DOI,
    else by its title's words) is one paper. A repeat gives the kept row whatever it lacked."""
    merged: List[Dict[str, Any]] = []
    by_doi: Dict[str, Dict[str, Any]] = {}
    by_title: Dict[str, Dict[str, Any]] = {}
    duplicates = 0
    for rank in range(max((len(found) for found in lists), default=0)):
        for found in lists:
            if rank >= len(found):
                continue
            item = found[rank]
            title = _title_key(item["title"])
            kept = (by_doi.get(item["doi"]) if item["doi"] else None) or by_title.get(title)
            if kept is not None:
                duplicates += 1
                for field in ("abstract", "venue", "doi", "year"):
                    if not kept.get(field) and item.get(field):
                        kept[field] = item[field]
                if not kept["text_urls"]:
                    kept["text_urls"] = item["text_urls"]
                if kept["doi"]:
                    by_doi.setdefault(kept["doi"], kept)
                continue
            kept = dict(item)
            merged.append(kept)
            if kept["doi"]:
                by_doi[kept["doi"]] = kept
            if title:
                by_title[title] = kept
    if limit is not None:
        merged = merged[:limit]
    return merged, duplicates


def reference(source: Dict[str, Any]) -> str:
    """A paper's reference line, from the index's metadata alone."""
    authors = list(source.get("authors") or [])
    if len(authors) > 6 or source.get("more_authors"):
        names = ", ".join(authors[:6]) + ", et al."
    else:
        names = ", ".join(authors)
    year = f" ({source['year']})" if source.get("year") else ""
    lead = f"{names}{year}. " if names else (f"{year.strip()}. " if year else "")
    title = (source.get("title") or "").rstrip(".")
    venue = f" {source['venue']}." if source.get("venue") else ""
    note = " Preprint." if source.get("preprint") else ""
    return f"{lead}{title}.{venue}{note} {source.get('url') or ''}".strip()
