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
_session = None
_last_warm = 0.0
WARM_TTL = 300  # re-warm every 5 min


def _get_session():
    """Lazy-init and periodically re-warm a curl_cffi Session so Kick trusts us."""
    global _session, _last_warm
    now = time.time()
    if _session is None or (now - _last_warm) > WARM_TTL:
        s = cffi_requests.Session(impersonate="chrome123")
        s.headers.update({
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://kick.com",
            "Referer": "https://kick.com/",
        })
        try:
            s.get("https://kick.com/", timeout=15, headers={"Accept": "text/html"})
        except Exception as e:
            logger.warning(f"warm-up failed: {e}")
        _session = s
        _last_warm = now
    return _session


def _fetch_json(path: str, referer: str | None = None) -> dict:
    s = _get_session()
    headers = {"Accept": "application/json"}
    if referer:
        headers["Referer"] = referer
    r = s.get(f"https://kick.com{path}", timeout=20, headers=headers)
    if r.status_code != 200:
        # force fresh session next time
        global _last_warm
        _last_warm = 0
        raise HTTPException(status_code=r.status_code, detail=f"Kick returned {r.status_code}")
    try:
        return r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Invalid JSON from Kick")


# ---------- In-memory TTL cache (light protection against OBS re-request spam) ----------
_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL_CHANNEL = 60
CACHE_TTL_CLIPS = 20  # short, so refreshes bring variety


def _cached(key: str, ttl: int, fetcher):
    now = time.time()
    if key in _cache:
        ts, val = _cache[key]
        if now - ts < ttl:
            return val
    val = fetcher()
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
        return _fetch_json(
            f"/api/v2/channels/{channel}/clips?cursor=0&sort=view&time=all",
            referer=f"https://kick.com/{channel}",
        )

    try:
        data = await asyncio.to_thread(_cached, f"clips:{channel}", CACHE_TTL_CLIPS, fetch)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    raw = data.get("clips") or []
    if not raw:
        raise HTTPException(status_code=404, detail="No clips found")

    # Random selection from the top-viewed pool
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
    return {"channel": channel, "clips": out}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
