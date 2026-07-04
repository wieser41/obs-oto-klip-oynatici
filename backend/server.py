from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
import random
import time
import asyncio
from pathlib import Path
from curl_cffi import requests as cffi_requests


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

app = FastAPI()
api_router = APIRouter(prefix="/api")

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ---------- Kick HTTP client (bypasses Cloudflare via TLS impersonation) ----------
# Kick fingerprints certain chrome versions aggressively. Rotate across a pool
# of impersonations that empirically pass its bot check.
_IMPERSONATE_POOL = [
    "chrome120", "chrome110", "chrome116", "chrome99",
    "safari17_0", "safari15_5", "edge99",
]
_session = None
_current_imp = None
_last_warm = 0.0
WARM_TTL = 300  # re-warm every 5 min


def _make_session(imp: str):
    s = cffi_requests.Session(impersonate=imp)
    s.headers.update({
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://kick.com",
        "Referer": "https://kick.com/",
    })
    try:
        s.get("https://kick.com/", timeout=15, headers={"Accept": "text/html"})
    except Exception as e:
        logger.warning(f"warm-up failed for {imp}: {e}")
    return s


def _get_session():
    """Lazy-init and periodically re-warm a curl_cffi Session so Kick trusts us."""
    global _session, _last_warm, _current_imp
    now = time.time()
    if _session is None or (now - _last_warm) > WARM_TTL:
        _current_imp = random.choice(_IMPERSONATE_POOL)
        _session = _make_session(_current_imp)
        _last_warm = now
        logger.info(f"kick session initialized as {_current_imp}")
    return _session


def _fetch_json(path: str, referer: str | None = None, retries: int = 3) -> dict:
    global _last_warm, _session, _current_imp
    headers = {"Accept": "application/json"}
    if referer:
        headers["Referer"] = referer

    last_status = None
    last_body = ""
    tried_imps: set[str] = set()

    for attempt in range(retries + 1):
        s = _get_session()
        tried_imps.add(_current_imp)
        try:
            r = s.get(f"https://kick.com{path}", timeout=20, headers=headers)
        except Exception as e:
            logger.warning(f"kick request error (attempt {attempt}, imp={_current_imp}): {e}")
            _last_warm = 0
            _session = None
            continue

        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                raise HTTPException(status_code=502, detail="Invalid JSON from Kick")

        last_status = r.status_code
        last_body = (r.text or "")[:200]
        logger.warning(f"kick {r.status_code} on {path} (imp={_current_imp}, attempt={attempt})")

        # 403/429 => rotate to a *different* impersonation next time
        if r.status_code in (403, 429):
            remaining = [i for i in _IMPERSONATE_POOL if i not in tried_imps]
            _last_warm = 0
            _session = None
            if remaining:
                _current_imp = random.choice(remaining)
                # Pre-build so _get_session picks it up as-is
                _session = _make_session(_current_imp)
                _last_warm = time.time()
                logger.info(f"rotated kick session to {_current_imp}")
            time.sleep(0.4 * (attempt + 1))
            continue

        break  # non-retryable status

    raise HTTPException(
        status_code=last_status or 502,
        detail=f"Kick returned {last_status}: {last_body}",
    )


# ---------- In-memory TTL cache (light protection against OBS re-request spam) ----------
_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL_CHANNEL = 60
CACHE_TTL_CLIPS = 20  # short, so refreshes bring variety


def _cached(key: str, ttl: int, fetcher, keep_predicate=None):
    now = time.time()
    if key in _cache:
        ts, val = _cache[key]
        if now - ts < ttl:
            return val
    val = fetcher()
    if keep_predicate is None or keep_predicate(val):
        _cache[key] = (now, val)
    return val


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Kick Clip Voter API", "status": "online"}


@api_router.get("/kick/channel/{channel}")
async def get_channel(channel: str):
    channel = channel.lower().strip()

    def fetch():
        return _fetch_json(f"/api/v2/channels/{channel}", referer=f"https://kick.com/{channel}")

    try:
        data = await asyncio.to_thread(_cached, f"ch:{channel}", CACHE_TTL_CHANNEL, fetch)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    chatroom = data.get("chatroom") or {}
    user = data.get("user") or {}
    return {
        "slug": data.get("slug") or channel,
        "user_id": data.get("user_id"),
        "username": user.get("username") or channel,
        "chatroom_id": chatroom.get("id"),
        "channel_id": chatroom.get("channel_id"),
        "profile_pic": user.get("profile_pic"),
    }


@api_router.get("/kick/clips/{channel}")
async def get_clips(channel: str, count: int = 3):
    channel = channel.lower().strip()

    def fetch():
        # Kick's clips endpoint sometimes returns few results for a single sort/time.
        # Merge multiple sort×time buckets to build a larger pool -> better randomness
        # and resilience for channels with limited "top viewed all-time" clips.
        referer = f"https://kick.com/{channel}"
        combos = [
            ("view", "all"),
            ("view", "month"),
            ("view", "week"),
            ("date", "all"),
            ("date", "month"),
        ]
        pool: dict[str, dict] = {}
        last_error = None
        for sort, timeframe in combos:
            for cursor in (0, 20):
                try:
                    d = _fetch_json(
                        f"/api/v2/channels/{channel}/clips?cursor={cursor}&sort={sort}&time={timeframe}",
                        referer=referer,
                    )
                except HTTPException as e:
                    last_error = e
                    continue
                for c in (d.get("clips") or []):
                    cid = c.get("id")
                    if cid and cid not in pool:
                        pool[cid] = c
                if len(pool) >= 60:
                    break
            if len(pool) >= 60:
                break
        if not pool:
            if last_error:
                raise last_error
            raise HTTPException(status_code=404, detail="No clips found")
        return {"clips": list(pool.values())}

    try:
        data = await asyncio.to_thread(
            _cached, f"clips:{channel}", CACHE_TTL_CLIPS, fetch,
            lambda v: bool(v.get("clips")),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    raw = data.get("clips") or []
    if not raw:
        raise HTTPException(status_code=404, detail="No clips found")

    picked = random.sample(raw, k=min(count, len(raw)))
    out = []
    for c in picked:
        out.append({
            "id": c.get("id"),
            "title": c.get("title") or "Untitled",
            "video_url": c.get("video_url"),
            "clip_url": c.get("clip_url"),
            "thumbnail_url": c.get("thumbnail_url"),
            "duration": c.get("duration"),
            "view_count": c.get("view_count") or c.get("views") or 0,
            "created_at": c.get("created_at"),
            "creator": (c.get("creator") or {}).get("username"),
            "category": (c.get("category") or {}).get("name"),
        })
    return {"channel": channel, "clips": out, "pool_size": len(raw)}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
