#!/usr/bin/env python3
"""
GitHub repository news search.

Surfaces:
1. Trending repositories (daily / weekly / monthly), via the unofficial trending
   API mirror with a fallback to the official Search API sorted by stars.
2. Newly created repositories matching the user's research domains, via the
   GitHub Search API (created:>YYYY-MM-DD).

Auth:
- Optional `GITHUB_TOKEN` (or `GH_TOKEN`) env var lifts the search rate limit
  from 10 req/min (unauth) to 30 req/min (auth). Functional without a token.

Output JSON shape mirrors search_arxiv.py / search_huggingface.py so the
existing UI pipeline picks it up unchanged.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    import certifi
    CERTIFI_CA_BUNDLE = certifi.where()
except ImportError:
    CERTIFI_CA_BUNDLE = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scoring_utils import (
    SCORE_MAX,
    calculate_relevance_score,
    calculate_recency_score,
    calculate_quality_score,
    calculate_recommendation_score,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
GITHUB_API = "https://api.github.com"
TRENDING_MIRROR = "https://ghapi.huchen.dev/repositories"

# 1000+ stars on a freshly created repo is exceptional → max popularity score.
GH_STARS_FULL_SCORE = 1000


def get_token() -> Optional[str]:
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None


def build_ssl_context() -> ssl.SSLContext:
    if CERTIFI_CA_BUNDLE and os.path.exists(CERTIFI_CA_BUNDLE):
        return ssl.create_default_context(cafile=CERTIFI_CA_BUNDLE)
    return ssl.create_default_context()


def http_get_json(
    url: str,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 30,
):
    headers = headers or {}
    if HAS_REQUESTS:
        kwargs = {"headers": headers, "timeout": timeout}
        if CERTIFI_CA_BUNDLE and os.path.exists(CERTIFI_CA_BUNDLE):
            kwargs["verify"] = CERTIFI_CA_BUNDLE
        resp = requests.get(url, **kwargs)
        resp.raise_for_status()
        return resp.json()

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=build_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------------
def gh_search_repos(
    query: str,
    max_pages: int = 1,
    per_page: int = 25,
    sort: str = "stars",
) -> List[Dict]:
    """Search GitHub repositories via /search/repositories."""
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ResearchNews-GitHubFetcher/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = get_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    items: List[Dict] = []
    for page in range(1, max_pages + 1):
        params = urllib.parse.urlencode({
            "q": query,
            "sort": sort,
            "order": "desc",
            "per_page": per_page,
            "page": page,
        })
        url = f"{GITHUB_API}/search/repositories?{params}"
        try:
            data = http_get_json(url, headers=headers)
            page_items = data.get("items", []) or []
            items.extend(page_items)
            if len(page_items) < per_page:
                break
        except Exception as exc:
            logger.warning("[GH] search page %d failed: %s", page, exc)
            break
    return items


def fetch_trending(since: str = "weekly", language: Optional[str] = None) -> List[Dict]:
    """Fetch GitHub trending repos. Falls back to recent star-sorted search."""
    since = since if since in {"daily", "weekly", "monthly"} else "weekly"

    params = {"since": since}
    if language:
        params["language"] = language
    url = TRENDING_MIRROR + "?" + urllib.parse.urlencode(params)

    try:
        data = http_get_json(
            url,
            headers={"User-Agent": "ResearchNews-GitHubFetcher/1.0"},
            timeout=15,
        )
        if isinstance(data, list) and data:
            logger.info("[GH] trending mirror returned %d repos", len(data))
            return data
        logger.info("[GH] trending mirror returned empty payload, falling back to search")
    except Exception as exc:
        logger.info("[GH] trending mirror unavailable (%s), falling back to search", exc)

    days = {"daily": 2, "weekly": 7, "monthly": 30}.get(since, 7)
    since_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    fallback_query = f"created:>{since_date}"
    if language:
        fallback_query += f" language:{language}"
    return gh_search_repos(fallback_query, max_pages=1, per_page=25, sort="stars")


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def _parse_iso(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def normalize_search_repo(item: Dict) -> Dict:
    pushed_at = item.get("pushed_at") or item.get("created_at") or ""
    owner = item.get("owner") or {}
    license_obj = item.get("license") or {}
    return {
        "id": item.get("full_name") or item.get("name") or item.get("html_url") or "",
        "title": item.get("full_name") or item.get("name") or "",
        "summary": item.get("description") or "",
        "authors_str": owner.get("login", ""),
        "published": pushed_at,
        "published_date": _parse_iso(pushed_at),
        "stars": item.get("stargazers_count") or 0,
        "forks": item.get("forks_count") or 0,
        "watchers": item.get("watchers_count") or 0,
        "language": item.get("language") or "",
        "topics": item.get("topics") or [],
        "categories": item.get("topics") or [],
        "html_url": item.get("html_url") or "",
        "owner_avatar": owner.get("avatar_url") or "",
        "license": license_obj.get("spdx_id") or None,
        "mode": "search",
    }


def normalize_trending_repo(item: Dict) -> Dict:
    """Normalize a repo entry returned by the trending mirror."""
    if "stargazers_count" in item or "owner" in item:
        return normalize_search_repo(item)

    name = item.get("name") or ""
    author = item.get("author") or ""
    full_name = f"{author}/{name}" if author and name else (name or item.get("repo") or "")
    return {
        "id": full_name,
        "title": full_name,
        "summary": item.get("description") or "",
        "authors_str": author,
        "published": "",
        "published_date": None,
        "stars": item.get("stars") or item.get("currentPeriodStars") or 0,
        "forks": item.get("forks") or 0,
        "watchers": 0,
        "language": item.get("language") or "",
        "topics": [],
        "categories": [],
        "html_url": item.get("url") or item.get("html_url") or (
            f"https://github.com/{full_name}" if full_name else ""
        ),
        "owner_avatar": item.get("avatar") or "",
        "license": None,
        "mode": "trending",
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def calculate_popularity_stars(stars: int) -> float:
    """Logarithmic popularity from star count. 1000+ stars = max."""
    if stars <= 0:
        return 0.0
    if stars >= GH_STARS_FULL_SCORE:
        return SCORE_MAX
    # log-scale so 10/100/1000 map to ~0.33/0.66/1.0 of SCORE_MAX
    return min(
        math.log10(stars + 1) / math.log10(GH_STARS_FULL_SCORE) * SCORE_MAX,
        SCORE_MAX,
    )


def score_repos(
    repos: List[Dict],
    config: Optional[Dict],
) -> Tuple[List[Dict], int]:
    domains = (config or {}).get("research_domains", {})
    excluded = (config or {}).get("excluded_keywords", [])
    has_domains = bool(domains)

    scored: List[Dict] = []
    filtered = 0

    for repo in repos:
        if has_domains:
            relevance, matched_domain, matched_keywords = calculate_relevance_score(
                {
                    "title": repo["title"],
                    "summary": repo["summary"],
                    "categories": repo["categories"],
                },
                domains,
                excluded,
            )
            if relevance == 0:
                # Trending repos are interesting even if they don't match a
                # domain — keep them with a soft floor so they rank lower.
                if repo.get("mode") == "trending":
                    relevance = 0.5
                    matched_domain = "trending"
                    matched_keywords = []
                else:
                    filtered += 1
                    continue
        else:
            relevance = 1.5
            matched_domain = "trending" if repo.get("mode") == "trending" else "github"
            matched_keywords = []

        recency = calculate_recency_score(repo.get("published_date"))
        popularity = calculate_popularity_stars(repo.get("stars", 0))
        quality = calculate_quality_score(repo.get("summary", ""))

        # Light bonuses for curated metadata.
        if repo.get("topics"):
            quality = min(quality + 0.3, SCORE_MAX)
        if repo.get("license"):
            quality = min(quality + 0.2, SCORE_MAX)

        final_score = calculate_recommendation_score(
            relevance, recency, popularity, quality
        )

        scored.append({
            "id": repo["id"],
            "title": repo["title"],
            "authors": repo.get("authors_str", ""),
            "abstract": repo.get("summary", "") or "(no description)",
            "published": repo.get("published", ""),
            "categories": (repo.get("topics") or [])[:5],
            "relevance_score": round(relevance, 2),
            "recency_score": round(recency, 2),
            "popularity_score": round(popularity, 2),
            "quality_score": round(quality, 2),
            "final_score": final_score,
            "matched_domain": matched_domain,
            "matched_keywords": matched_keywords,
            "link": repo.get("html_url", ""),
            "source": "github",
            "engagement": {
                "likes": repo.get("stars", 0),
                "comments": repo.get("forks", 0),
            },
            # GitHub-specific extras (consumed by NewsItemCard's GH branch)
            "stars": repo.get("stars", 0),
            "forks": repo.get("forks", 0),
            "language": repo.get("language", ""),
            "license": repo.get("license"),
            "owner_avatar": repo.get("owner_avatar", ""),
            "mode": repo.get("mode", "search"),
        })

    scored.sort(key=lambda x: x["final_score"], reverse=True)
    return scored, filtered


# ---------------------------------------------------------------------------
# Query construction
# ---------------------------------------------------------------------------
def build_search_queries(config: Optional[Dict]) -> List[str]:
    """Build GitHub search queries from research_domains.

    Returns one query per domain. Each query OR-combines that domain's top
    keywords. Falls back to a sensible LLM/AI default when no domains exist.
    """
    if not config:
        return ["llm OR transformer OR foundation-model"]

    domains = config.get("research_domains") or {}
    queries: List[str] = []
    for _name, dom in domains.items():
        kws = dom.get("keywords") or []
        if not kws:
            continue
        # GitHub treats space-separated terms as AND; OR them explicitly.
        clauses = []
        for kw in kws[:4]:
            kw_clean = kw.strip()
            if not kw_clean:
                continue
            clauses.append(f'"{kw_clean}"' if " " in kw_clean else kw_clean)
        if clauses:
            queries.append(" OR ".join(clauses))
    if not queries:
        queries = ["llm OR transformer OR foundation-model"]
    return queries


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch and score trending / recent GitHub repositories."
    )
    parser.add_argument("--config", type=str, default=None,
                        help="Path to research interests JSON config")
    parser.add_argument("--output", type=str, required=True,
                        help="Output JSON file path")
    parser.add_argument("--top-n", type=int, default=10,
                        help="Number of top repos to return")
    parser.add_argument("--language", type=str, default="",
                        help="Optional language filter (e.g. python, typescript)")
    parser.add_argument("--time-window", type=str, default="weekly",
                        choices=["daily", "weekly", "monthly"],
                        help="Trending time window")
    parser.add_argument("--include-trending", type=str, default="true",
                        help="Whether to include trending repos (true/false)")
    parser.add_argument("--max-search-pages", type=int, default=1,
                        help="Pages of search results per query (≤3 recommended)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    config: Optional[Dict] = None
    if args.config:
        try:
            with open(args.config, "r", encoding="utf-8-sig") as f:
                config = json.load(f)
            logger.info("[GH] loaded config from %s", args.config)
        except Exception as exc:
            logger.warning("[GH] failed to load config %s: %s", args.config, exc)

    language = (args.language or (config or {}).get("language") or "").strip() or None
    time_window = args.time_window
    include_trending = (args.include_trending or "true").lower() in {"true", "1", "yes", "on"}

    if get_token():
        logger.info("[GH] using GITHUB_TOKEN for higher rate limits")
    else:
        logger.info("[GH] no GITHUB_TOKEN set — using unauthenticated rate limits")

    repos: List[Dict] = []
    seen_ids: set = set()

    # 1) Trending repos
    if include_trending:
        logger.info(
            "[GH] fetching trending (since=%s, language=%s)",
            time_window, language or "any",
        )
        trending_raw = fetch_trending(since=time_window, language=language)
        for entry in trending_raw:
            r = normalize_trending_repo(entry)
            if r["id"] and r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                repos.append(r)
        logger.info("[GH] trending: %d repos collected", len(repos))

    # 2) Per-domain search for newly created repos
    queries = build_search_queries(config)
    days_recent = 30
    since_date = (datetime.now(timezone.utc) - timedelta(days=days_recent)).strftime("%Y-%m-%d")

    for q in queries:
        full_q = q
        if language:
            full_q += f" language:{language}"
        full_q += f" created:>{since_date}"
        logger.info("[GH] search: %s", full_q)
        try:
            search_items = gh_search_repos(
                full_q,
                max_pages=max(1, args.max_search_pages),
                per_page=20,
                sort="stars",
            )
        except Exception as exc:
            logger.warning("[GH]   search failed: %s", exc)
            search_items = []
        added = 0
        for item in search_items:
            r = normalize_search_repo(item)
            if r["id"] and r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                repos.append(r)
                added += 1
        logger.info("[GH]   +%d new repos", added)
        # Be polite to the API, especially without a token.
        time.sleep(1.0 if not get_token() else 0.4)

    scored, filtered = score_repos(repos, config)
    logger.info(
        "[GH] scored %d repos (%d filtered out)", len(scored), filtered
    )
    top = scored[: args.top_n]

    output = {
        "top_papers": top,
        "total_found": len(repos),
        "total_filtered": filtered,
        "search_date": datetime.now().strftime("%Y-%m-%d"),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)

    logger.info("[GH] saved %d repos to %s", len(top), args.output)
    for i, r in enumerate(top, 1):
        logger.info(
            "  %d. %s ⭐%s (score %s)",
            i, r["title"][:60], r["stars"], r["final_score"],
        )

    print(json.dumps(output, ensure_ascii=True, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
