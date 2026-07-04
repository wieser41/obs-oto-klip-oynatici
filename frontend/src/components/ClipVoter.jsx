import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import axios from "axios";
import Hls from "hls.js";
import { Zap, Radio, Clock, Trophy, WifiOff } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// Kick uses Pusher (public creds — visible in kick.com bundle)
const PUSHER_APP_KEY = "32cbd69e4b950bf97679";
const PUSHER_CLUSTER = "us2";

const PHASE = {
  WAKING: "waking",
  VOTING: "voting",
  PLAYING: "playing",
  ERROR: "error",
};

function useQuery() {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      channel: (p.get("channel") || "").trim(),
      duration: Math.max(3, parseInt(p.get("duration") || "8", 10)),
    };
  }, []);
}

export default function ClipVoter() {
  const { channel, duration } = useQuery();
  const [phase, setPhase] = useState(PHASE.WAKING);
  const [errorMsg, setErrorMsg] = useState("");
  const [clips, setClips] = useState([]);
  const [votes, setVotes] = useState({ 1: 0, 2: 0, 3: 0 });
  const [remaining, setRemaining] = useState(duration);
  const [winnerIdx, setWinnerIdx] = useState(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [chatStatus, setChatStatus] = useState("connecting");

  const votersRef = useRef(new Set()); // unique voter ids per round
  const votesRef = useRef({ 1: 0, 2: 0, 3: 0 });
  const wsRef = useRef(null);
  const chatroomIdRef = useRef(null);
  const videoRef = useRef(null);
  const timerRef = useRef(null);

  // ---- Reset round state ----
  const resetRound = useCallback(() => {
    votersRef.current = new Set();
    votesRef.current = { 1: 0, 2: 0, 3: 0 };
    setVotes({ 1: 0, 2: 0, 3: 0 });
    setClips([]);
    setWinnerIdx(null);
    setRemaining(duration);
    setVideoProgress(0);
  }, [duration]);

  // ---- Fetch channel meta + clips ----
  const startNewRound = useCallback(async () => {
    if (!channel) {
      setErrorMsg("URL'e ?channel=kullanici_adi ekleyin.");
      setPhase(PHASE.ERROR);
      return;
    }
    resetRound();
    setPhase(PHASE.WAKING);
    try {
      const [chRes, clipRes] = await Promise.all([
        axios.get(`${API}/kick/channel/${channel}`),
        axios.get(`${API}/kick/clips/${channel}`, { params: { count: 3 } }),
      ]);
      chatroomIdRef.current = chRes.data.chatroom_id;
      const list = clipRes.data.clips || [];
      if (list.length < 1) throw new Error("Klip bulunamadı");
      // pad to 3 if channel has fewer
      while (list.length < 3) list.push({ ...list[0], id: `dup-${list.length}` });
      setClips(list.slice(0, 3));
      setPhase(PHASE.VOTING);
      setRemaining(duration);
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Bilinmeyen hata";
      setErrorMsg(`Kick'ten veri alınamadı: ${detail}`);
      setPhase(PHASE.ERROR);
      // auto retry after 6s
      setTimeout(() => startNewRound(), 6000);
    }
  }, [channel, duration, resetRound]);

  // ---- Pusher WebSocket for Kick chat ----
  useEffect(() => {
    if (phase !== PHASE.VOTING) return;
    const chatroomId = chatroomIdRef.current;
    if (!chatroomId) return;

    const url = `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setChatStatus("connecting");

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${chatroomId}.v2` },
      }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === "pusher:connection_established") setChatStatus("connected");
        if (msg.event === "pusher_internal:subscription_succeeded") setChatStatus("connected");
        if (msg.event === "App\\Events\\ChatMessageEvent") {
          const payload = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
          const text = (payload?.content || "").trim();
          const userId = payload?.sender?.id || payload?.sender?.username;
          if (!userId || !text) return;
          // Only count messages that are exactly 1, 2, or 3 (no leading exclamation)
          const m = text.match(/^([123])\s*$/);
          if (!m) return;
          if (votersRef.current.has(userId)) return;
          votersRef.current.add(userId);
          const n = parseInt(m[1], 10);
          votesRef.current = { ...votesRef.current, [n]: (votesRef.current[n] || 0) + 1 };
          setVotes({ ...votesRef.current });
        }
      } catch { /* ignore malformed frames */ }
    };

    ws.onerror = () => setChatStatus("error");
    ws.onclose = () => setChatStatus("disconnected");

    return () => {
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [phase]);

  // ---- Countdown timer ----
  useEffect(() => {
    if (phase !== PHASE.VOTING) return;
    setRemaining(duration);
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const passed = (Date.now() - start) / 1000;
      const left = Math.max(0, duration - passed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(timerRef.current);
        // pick winner
        const v = votesRef.current;
        let best = 1;
        if (v[2] > v[best]) best = 2;
        if (v[3] > v[best]) best = 3;
        // tie -> if all zero, random
        const allZero = v[1] === 0 && v[2] === 0 && v[3] === 0;
        const winner = allZero ? (1 + Math.floor(Math.random() * 3)) : best;
        setWinnerIdx(winner);
        setPhase(PHASE.PLAYING);
      }
    }, 100);
    return () => clearInterval(timerRef.current);
  }, [phase, duration]);

  // ---- Video progress + auto-loop when video ends ----
  useEffect(() => {
    if (phase !== PHASE.PLAYING) return;
    const v = videoRef.current;
    if (!v) return;

    const src = clips[winnerIdx - 1]?.video_url;
    if (!src) return;

    let hls = null;
    // Kick clips are HLS (.m3u8). Native support on Safari; hls.js elsewhere (OBS/Chromium).
    const isHls = src.includes(".m3u8");
    if (isHls && !v.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      v.src = src;
    }

    v.currentTime = 0;
    // Try unmuted autoplay; if browser blocks (OBS BrowserSource allows via flags),
    // fall back to muted so playback still proceeds.
    v.muted = false;
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => { /* noop */ });
    });

    const onTime = () => {
      if (v.duration > 0 && isFinite(v.duration)) {
        setVideoProgress((v.currentTime / v.duration) * 100);
      }
    };
    const onEnded = () => startNewRound();

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      if (hls) { try { hls.destroy(); } catch { /* noop */ } }
    };
  }, [phase, winnerIdx, clips, startNewRound]);

  // ---- Kickoff on mount ----
  useEffect(() => {
    startNewRound();
    return () => {
      clearInterval(timerRef.current);
    };
  }, [startNewRound]);

  const totalVotes = (votes[1] || 0) + (votes[2] || 0) + (votes[3] || 0);
  const pct = (n) => (totalVotes === 0 ? 0 : Math.round((votes[n] / totalVotes) * 100));
  const timeRatio = Math.max(0, Math.min(1, remaining / duration));

  return (
    <div data-testid="clip-voter-root" className="relative w-screen h-screen overflow-hidden text-white">
      <div className="bg-stage" />
      <div className="grain" />

      {/* HEADER (small, in-corner) */}
      <div className="absolute top-5 left-6 z-40 flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur-md">
          <span className="inline-block w-2 h-2 rounded-full bg-[#00ff9d] shadow-[0_0_10px_#00ff9d] animate-pulse" />
          <span className="text-xs tracking-[0.28em] uppercase text-white/80">Kick Klip Turnuvası</span>
        </div>
        {channel && (
          <div data-testid="channel-badge" className="px-3 py-1.5 rounded-full border border-[#b445ff]/40 bg-[#b445ff]/10 text-xs tracking-widest uppercase mono">
            /{channel}
          </div>
        )}
      </div>

      <div className="absolute top-5 right-6 z-40 flex items-center gap-2 text-xs">
        {chatStatus === "connected" ? (
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#00ff9d]/40 bg-black/40 text-[#00ff9d]">
            <Radio size={13} /> CHAT LIVE
          </span>
        ) : (
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/10 bg-black/40 text-white/60">
            <WifiOff size={13} /> {chatStatus.toUpperCase()}
          </span>
        )}
      </div>

      {/* ---------- WAKING ---------- */}
      {phase === PHASE.WAKING && (
        <div data-testid="waking-screen" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-8">
          <div className="loader" />
          <div className="text-2xl md:text-3xl tracking-[0.42em] uppercase neon-pulse text-[#00ff9d]">
            Yeni tur hazırlanıyor
          </div>
          <div className="text-xs tracking-[0.35em] uppercase text-white/40 mono">
            {channel ? `kick.com/${channel}` : "channel parametresi bekleniyor"}
          </div>
        </div>
      )}

      {/* ---------- ERROR ---------- */}
      {phase === PHASE.ERROR && (
        <div data-testid="error-screen" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 px-8 text-center">
          <div className="text-xs tracking-[0.4em] uppercase text-[#ff5577]">Bağlantı Hatası</div>
          <div className="text-lg text-white/80 max-w-xl">{errorMsg}</div>
          <div className="text-xs text-white/40 mono">Otomatik olarak yeniden denenecek...</div>
        </div>
      )}

      {/* ---------- VOTING ---------- */}
      {phase === PHASE.VOTING && clips.length === 3 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center px-10 py-16">
          <div className="w-full max-w-[1400px] grid grid-cols-[130px_1fr] gap-10 items-stretch fade-in">

            {/* Vertical vote bars */}
            <div data-testid="vote-bars" className="flex items-end justify-between h-[460px] px-2">
              {[1, 2, 3].map((n, i) => {
                const p = pct(n);
                const styleClass = i === 0 ? "g" : i === 1 ? "p" : "b";
                return (
                  <div key={n} className="flex flex-col items-center gap-3 h-full">
                    <div className="flex-1 flex items-end w-full">
                      <div className="vote-track">
                        <div
                          className={`vote-fill ${styleClass}`}
                          data-testid={`vote-fill-${n}`}
                          style={{ height: `${p}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-[11px] tracking-[0.25em] text-white/50 mono">#{n}</div>
                    <div data-testid={`vote-pct-${n}`} className="mono text-sm font-bold text-white">
                      {p}%
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Clip list */}
            <div className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-[10px] tracking-[0.45em] uppercase text-white/40">Oylama Aktif</div>
                  <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                    Chate <span className="text-[#00ff9d]">1</span>, <span className="text-[#b445ff]">2</span> veya <span className="text-[#ffe14a]">3</span> yaz
                  </h1>
                </div>
                <div className="flex items-center gap-2 text-xs mono text-white/60">
                  <Zap size={14} className="text-[#00ff9d]" />
                  <span data-testid="total-votes">{totalVotes} oy</span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {clips.map((c, idx) => {
                  const n = idx + 1;
                  return (
                    <div key={c.id || idx} data-testid={`clip-card-${n}`} className="clip-card fade-in" style={{ animationDelay: `${idx * 80}ms` }}>
                      <div className={`badge-num n${n}`}>{n}</div>
                      {c.thumbnail_url ? (
                        <img
                          src={c.thumbnail_url}
                          alt=""
                          className="w-32 h-[72px] object-cover rounded-md border border-white/10"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-32 h-[72px] rounded-md bg-white/5 border border-white/10" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm md:text-base font-semibold truncate">{c.title}</div>
                        <div className="text-[11px] mono text-white/50 mt-1 flex gap-3 uppercase tracking-wider">
                          {c.category && <span>{c.category}</span>}
                          {typeof c.view_count === "number" && <span>{c.view_count.toLocaleString()} views</span>}
                          {c.creator && <span>@{c.creator}</span>}
                        </div>
                      </div>
                      <div data-testid={`clip-votes-${n}`} className="mono text-2xl font-bold w-16 text-right" style={{ color: n === 1 ? "#00ff9d" : n === 2 ? "#b445ff" : "#ffe14a" }}>
                        {votes[n] || 0}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Countdown bar */}
              <div className="mt-4 panel green px-5 py-3 flex items-center gap-4">
                <Clock size={18} className="text-[#00ff9d]" />
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    data-testid="countdown-bar"
                    className="h-full bg-gradient-to-r from-[#00ff9d] via-[#7cffd0] to-[#b445ff] transition-[width] duration-100"
                    style={{ width: `${timeRatio * 100}%` }}
                  />
                </div>
                <div data-testid="countdown-text" className="mono text-lg font-bold text-[#00ff9d] tabular-nums w-20 text-right">
                  {remaining.toFixed(1)}s
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- PLAYING ---------- */}
      {phase === PHASE.PLAYING && winnerIdx !== null && clips[winnerIdx - 1] && (
        <div data-testid="playing-screen" className="absolute inset-0 z-10">
          <video
            data-testid="winner-video"
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            autoPlay
            playsInline
            controls={false}
          />

          {/* winner banner */}
          <div className="absolute top-6 left-1/2 -translate-x-1/2 fade-in flex items-center gap-3 px-5 py-2.5 rounded-full border border-[#00ff9d]/50 bg-black/60 backdrop-blur">
            <Trophy size={16} className="text-[#00ff9d]" />
            <span className="text-xs tracking-[0.35em] uppercase text-white/70">Kazanan</span>
            <span className="mono font-bold text-[#00ff9d] text-lg">#{winnerIdx}</span>
            <span className="max-w-[420px] truncate text-sm text-white/90">{clips[winnerIdx - 1].title}</span>
          </div>

          {/* video progress */}
          <div className="absolute bottom-0 left-0 right-0 z-20">
            <div className="h-1.5 bg-white/5">
              <div
                data-testid="video-progress"
                className="h-full bg-gradient-to-r from-[#00ff9d] to-[#b445ff]"
                style={{ width: `${videoProgress}%`, boxShadow: "0 0 12px #00ff9d" }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
