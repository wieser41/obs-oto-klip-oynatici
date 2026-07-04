# Kick Clip Voter — OBS Browser Source

## Problem Statement (verbatim)
Kick klip oynatıcı: OBS tarayıcı kaynağı açıldığında karanlıkta "Yeni tur hazırlanıyor..." göstersin, Kick API'den 3 rastgele taze klibi çekip görsel oylama ekranı sunsun. Kick canlı sohbetini WS ile dinleyip chatte "1", "2", "3" yazanları saysın (aynı user tekrar oy veremez), süre bitince en çok oyu alan klibi tam ekran+sesli otomatik oynatsın. Video bitince kendini sıfırlayıp sonsuz döngü kursun. Siyah, yarı şeffaf, modern, neon (yeşil/mor) tema.

## User Choices
- Kick API: undocumented public endpoints
- Klip seçimi: tamamen rastgele 3
- Oylama süresi: **8 saniye** (URL: `?duration=N`)
- Klip tekrar filtresi: hayır
- Renk teması: yeşil+mor dengeli

## Architecture
- **Frontend** (React): single-page player at `/`. URL params: `?channel=<slug>&duration=<sec>`. Direct WebSocket to Kick Pusher (`ws-us2.pusher.com`) for live chat. HLS playback via `hls.js`. Fonts: Chakra Petch + JetBrains Mono.
- **Backend** (FastAPI): 
  - `GET /api/kick/channel/{channel}` → chatroom_id, user_id, slug
  - `GET /api/kick/clips/{channel}?count=3` → 3 random clips from top-viewed
  - Uses `curl_cffi` (chrome123 impersonation) + warm-up session to bypass Kick's Cloudflare.
  - TTL cache (20s clips / 60s channel) protects against OBS re-request storms.
- No MongoDB writes (stateless clip player).

## Loop
1. **WAKING**: dark screen + spinning neon loader + "Yeni tur hazırlanıyor" (pulse text)
2. **VOTING**: 3 vertical neon vote bars (left) + 3 numbered clip cards with thumbnails (right) + countdown ring/bar
3. **PLAYING**: full-screen autoplay of winner clip, KAZANAN banner top, neon progress bar bottom
4. **onended** → resetRound() → back to step 1 (infinite)

## Implemented Feb 4, 2026
- Kick API proxy w/ Cloudflare bypass (curl_cffi + warm-up)
- Pusher chat WebSocket + regex `^[123]$` vote parser + unique-voter set per round
- HLS (`.m3u8`) playback via hls.js with unmuted → muted autoplay fallback
- Neon green/purple theme, grain overlay, glassmorphism panels, animated countdown
- Auto retry on Kick API failure (6s)

## Deferred / Backlog
- P1: Winner reveal 3-2-1 flash animation before playing
- P1: On-screen live chat overlay (visual only) during voting
- P2: Persist round history to Mongo for post-stream stats
- P2: Multi-language (currently TR-only labels)
